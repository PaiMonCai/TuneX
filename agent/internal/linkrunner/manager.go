package linkrunner

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Manager serializes complete placement commands, including stop/start/rollback
// and cache commits. Lease watchers stop children independently of this mutex,
// so a slow startup for one placement cannot extend another placement's lease.
// A state directory must have exactly one Manager owner.
type Manager struct {
	opMu                   sync.Mutex
	mu                     sync.Mutex
	binaryPath, runtimeDir string
	cache                  *privateCache
	records                map[string]record
	running                map[string]*child
	closed                 bool
	cacheErr               error
	external               externalReservations
	traffic                *trafficStore
	lifecycleStarted       bool
}

// New loads durable fences but does not start children. Corrupt/foreign caches
// fail closed. binaryPath is resolved once, never searched via PATH or a shell.
// stateDir must be dedicated to linkrunner; its machine.key is not AUTH_SECRET.
func New(binaryPath, stateDir, agentID string) (*Manager, error) {
	if strings.TrimSpace(binaryPath) == "" || strings.TrimSpace(stateDir) == "" || strings.TrimSpace(agentID) == "" || len(agentID) > 256 {
		return nil, ErrInvalidConfig
	}
	binaryPath, err := filepath.Abs(binaryPath)
	if err != nil {
		return nil, ErrInvalidConfig
	}
	stateDir, err = filepath.Abs(stateDir)
	if err != nil {
		return nil, ErrInvalidConfig
	}
	cache, records, err := openCache(stateDir, agentID)
	if err != nil {
		return nil, err
	}
	runtimeDir := filepath.Join(stateDir, "runtime")
	if err := privateDirectory(runtimeDir); err != nil {
		return nil, err
	}
	// Abandoned startup configs contain secrets. Never follow links or delete
	// anything outside the dedicated runtime directory.
	entries, err := os.ReadDir(runtimeDir)
	if err != nil {
		return nil, ErrCache
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "fxp-") && strings.HasSuffix(entry.Name(), ".json") {
			if !entry.Type().IsRegular() {
				return nil, ErrCache
			}
			if os.Remove(filepath.Join(runtimeDir, entry.Name())) != nil {
				return nil, ErrCache
			}
		}
	}
	return &Manager{binaryPath: binaryPath, runtimeDir: runtimeDir, cache: cache, records: records, running: make(map[string]*child)}, nil
}

// Apply accepts a complete, leased renderer output. Identical generation/content
// may renew its lease or retry a failed start. Different content needs a higher
// generation. Managed binding/policy updates preserve unchanged sibling runtimes;
// immutable carrier/transport changes stop/start and can interrupt traffic.
// On failure the still-leased committed config is restored; the new generation
// remains fenced and Observation exposes both desired and running generations.
func (m *Manager) Apply(input Config) (out Observation, resultErr error) {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	return m.apply(input)
}

func (m *Manager) apply(input Config) (out Observation, resultErr error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return Observation{}, ErrClosed
	}
	m.lifecycleStarted = true
	if m.cacheErr != nil {
		return m.observeLocked(input.ID), m.cacheErr
	}
	if m.traffic != nil {
		if _, err := m.scanTrafficLocked(); err != nil {
			return m.observeLocked(input.ID), m.trafficFailureLocked(err)
		}
	}
	cfg := cloneConfig(input)
	deadline, expected, err := validateConfig(&cfg)
	if err != nil {
		return m.observeLocked(input.ID), err
	}
	if m.cache.nodeDBID != 0 && cfg.NodeID != m.cache.nodeDBID {
		return m.observeLocked(cfg.ID), ErrIdentityMismatch
	}
	r, exists := m.records[cfg.ID]
	if exists {
		if r.WorkspaceID != 0 && (cfg.WorkspaceID != r.WorkspaceID || cfg.NodeID != r.NodeID || cfg.LinkID != r.LinkID || cfg.Role != r.Role) {
			return m.observeLocked(cfg.ID), ErrIdentityMismatch
		}
		if cfg.Generation < r.Highest || (r.Removed && cfg.Generation <= r.Highest) {
			return m.observeLocked(cfg.ID), ErrStaleGeneration
		}
		if cfg.Generation == r.Highest {
			if fingerprint(cfg) != r.Fingerprint {
				return m.observeLocked(cfg.ID), ErrGenerationConflict
			}
			previousLease, _ := time.Parse(time.RFC3339Nano, r.DesiredLease)
			if deadline.Before(previousLease) {
				return m.observeLocked(cfg.ID), ErrLeaseRegression
			}
		}
	} else if len(m.records) >= maxRecords {
		return Observation{}, ErrCache
	}
	r.ID = cfg.ID
	r.LinkID = cfg.LinkID
	r.WorkspaceID = cfg.WorkspaceID
	r.NodeID = cfg.NodeID
	r.Role = cfg.Role
	r.Highest = cfg.Generation
	r.Removed = false
	r.Fingerprint = fingerprint(cfg)
	r.DesiredDigest = cfg.ConfigDigest
	r.DesiredLease = cfg.LeaseExpiresAt
	// Commit the generation fence before touching sockets. A crash at any later
	// step can restore only the committed config, never a partial candidate.
	if !time.Now().Before(deadline) {
		r.Config = nil
		r.State = "expired"
		r.LastError = ErrLeaseExpired.Error()
		if err := m.saveRecordLocked(r); err != nil {
			return m.observeLocked(cfg.ID), err
		}
		stopErr := m.stopLocked(cfg.ID)
		return m.observeLocked(cfg.ID), errors.Join(ErrLeaseExpired, stopErr)
	}
	if p := m.running[cfg.ID]; p != nil && p.live() && r.Config != nil && r.Config.Generation == cfg.Generation && fingerprint(*r.Config) == fingerprint(cfg) {
		if p.managed && !p.verifyFile(cfg.ConfigDigest) {
			r.State = "failed"
			r.LastError = ErrConfigTampered.Error()
			stopErr := m.stopLocked(cfg.ID)
			saveErr := m.saveRecordLocked(r)
			return m.observeLocked(cfg.ID), errors.Join(ErrConfigTampered, stopErr, saveErr)
		}
		r.Config = &cfg
		r.State = "ready"
		r.LastError = ""
		if err := m.saveRecordLocked(r); err != nil {
			return m.observeLocked(cfg.ID), err
		}
		if p.renew(deadline) {
			return m.observeLocked(cfg.ID), nil
		}
		// The old lease expired between the check and renewal; restart instead.
	}
	r.State = "updating"
	r.LastError = ""
	if err := m.saveRecordLocked(r); err != nil {
		return m.observeLocked(cfg.ID), err
	}
	for id, p := range m.running {
		if id == cfg.ID || !p.live() {
			continue
		}
		other := m.records[id].Config
		if other == nil {
			continue
		}
		for _, a := range cfg.Ports {
			for _, b := range other.Ports {
				if portsConflict(a, b) {
					r.State = "update_failed"
					r.LastError = ErrPortConflict.Error()
					_ = m.saveRecordLocked(r)
					return m.observeLocked(cfg.ID), errors.Join(ErrPortConflict, m.cacheErr)
				}
			}
		}
	}
	old := r.Config
	reserved := append([]Port(nil), cfg.Ports...)
	if old != nil {
		reserved = append(reserved, old.Ports...)
	}
	if err := m.reserveSlotsLocked(cfg.ID, reserved); err != nil {
		r.State = "update_failed"
		r.LastError = err.Error()
		_ = m.saveRecordLocked(r)
		return m.observeLocked(cfg.ID), errors.Join(err, m.cacheErr)
	}
	defer func() { resultErr = errors.Join(resultErr, m.finishSlotsLocked(cfg.ID)); out = m.observeLocked(cfg.ID) }()
	if current := m.running[cfg.ID]; current != nil && current.live() && old != nil && managedCompatible(old.RunnerConfig, cfg.RunnerConfig) {
		return m.reloadLocked(r, cfg, deadline, current)
	}
	r.UpdateMode = "stop_start"
	if current := m.running[cfg.ID]; current != nil {
		// Allow FXP's bounded TCP drain on updates. Listeners/UDP still close;
		// leases retain their independent short fail-safe stop timeout.
		if err := current.stopWithGrace(updateDrainTimeout); err != nil {
			return m.observeLocked(cfg.ID), err
		}
	}
	if err := m.stopLocked(cfg.ID); err != nil {
		r.State = "failed"
		r.LastError = err.Error()
		_ = m.saveRecordLocked(r)
		return m.observeLocked(cfg.ID), errors.Join(err, m.cacheErr)
	}
	if bytes.Equal(cfg.RunnerConfig, []byte("null")) {
		r.Config = &cfg
		r.State = "passive"
		r.LastError = ""
		if err := m.saveRecordLocked(r); err != nil {
			return m.observeLocked(cfg.ID), err
		}
		return m.observeLocked(cfg.ID), nil
	}
	p, startErr := m.startChildLocked(cfg, deadline, expected)
	if startErr == nil {
		m.running[cfg.ID] = p
		r.Config = &cfg
		r.State = "ready"
		r.LastError = ""
		if err := m.saveRecordLocked(r); err == nil {
			if !p.live() {
				return m.observeLocked(cfg.ID), p.failure()
			}
			return m.observeLocked(cfg.ID), nil
		} else {
			return m.observeLocked(cfg.ID), err
		}
	}
	if p != nil {
		if err := p.stop(); err != nil {
			// An unconfirmed stop must retain both the child and its external
			// claims; never start rollback over a possibly live candidate.
			m.running[cfg.ID] = p
			r.Config = &cfg
			r.State = "failed"
			r.LastError = err.Error()
			_ = m.saveRecordLocked(r)
			return m.observeLocked(cfg.ID), errors.Join(startErr, err, m.cacheErr)
		}
	}
	r.Config = old
	r.State = "failed"
	r.LastError = startErr.Error()
	var rollbackErr error
	if old != nil {
		previous := cloneConfig(*old)
		oldDeadline, oldExpected, validationErr := validateConfig(&previous)
		if validationErr == nil && time.Now().Before(oldDeadline) {
			if bytes.Equal(previous.RunnerConfig, []byte("null")) {
				r.State = "rolled_back"
			} else {
				var restored *child
				restored, rollbackErr = m.startChildLocked(previous, oldDeadline, oldExpected)
				if rollbackErr == nil {
					m.running[cfg.ID] = restored
					r.State = "rolled_back"
				} else if restored != nil {
					if stopErr := restored.stop(); stopErr != nil {
						m.running[cfg.ID] = restored
						rollbackErr = errors.Join(rollbackErr, stopErr)
					}
				}
			}
		}
	}
	if rollbackErr != nil {
		r.LastError += "; rollback failed"
	}
	if err := m.saveRecordLocked(r); err != nil {
		return m.observeLocked(cfg.ID), errors.Join(startErr, rollbackErr, err)
	}
	return m.observeLocked(cfg.ID), errors.Join(startErr, rollbackErr)
}

// Remove durably writes a permanent tombstone before stopping. A duplicate remove
// is idempotent; an equal/older Apply stays rejected even after Agent restart.
// Only an authoritative Apply with a strictly greater generation can reuse id.
func (m *Manager) Remove(id string, generation int64) (Observation, error) {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	return m.remove(id, generation)
}

func (m *Manager) remove(id string, generation int64) (Observation, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return Observation{}, ErrClosed
	}
	if id == "" || len(id) > 256 || generation <= 0 {
		return Observation{}, ErrInvalidConfig
	}
	if m.cacheErr != nil {
		return m.observeLocked(id), m.cacheErr
	}
	r := m.records[id]
	if generation < r.Highest {
		return m.observeLocked(id), ErrStaleGeneration
	}
	if r.ID == "" && len(m.records) >= maxRecords {
		return Observation{}, ErrCache
	}
	r.ID = id
	r.Highest = generation
	r.Removed = true
	r.Config = nil
	r.State = "removed"
	r.LastError = ""
	r.Fingerprint = ""
	r.DesiredDigest = ""
	r.DesiredLease = ""
	if err := m.saveRecordLocked(r); err != nil {
		return m.observeLocked(id), err
	}
	err := m.stopLocked(id)
	if err == nil {
		m.releaseSlotsLocked(id)
	}
	if err != nil {
		r.LastError = err.Error()
		m.records[id] = r
	}
	return m.observeLocked(id), err
}

// Restore starts the authenticated, committed configurations loaded by New.
// Expired records are refused and cleared while their high-water marks survive.
// Restore is idempotent; it cannot reload an external cache over live state.
func (m *Manager) Restore() ([]Observation, error) {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil, ErrClosed
	}
	m.lifecycleStarted = true
	if m.cacheErr != nil {
		return m.statusLocked(), m.cacheErr
	}
	if m.traffic != nil {
		if _, err := m.scanTrafficLocked(); err != nil {
			return m.statusLocked(), m.trafficFailureLocked(err)
		}
	}
	var failures []error
	for _, id := range m.idsLocked() {
		r := m.records[id]
		if r.Removed || r.Config == nil {
			continue
		}
		cfg := cloneConfig(*r.Config)
		deadline, expected, err := validateConfig(&cfg)
		if err != nil {
			failures = append(failures, ErrCache)
			continue
		}
		if !time.Now().Before(deadline) {
			_ = m.stopLocked(id)
			r.Config = nil
			r.State = "expired"
			r.LastError = ErrLeaseExpired.Error()
			if err := m.saveRecordLocked(r); err != nil {
				failures = append(failures, err)
				break
			}
			failures = append(failures, ErrLeaseExpired)
			continue
		}
		if bytes.Equal(cfg.RunnerConfig, []byte("null")) {
			r.State = "passive"
			m.records[id] = r
			continue
		}
		if p := m.running[id]; p != nil && p.live() {
			continue
		}
		if err := m.stopLocked(id); err != nil {
			failures = append(failures, err)
			continue
		}
		if err := m.reserveSlotsLocked(id, cfg.Ports); err != nil {
			r.State = "failed"
			r.LastError = err.Error()
			m.records[id] = r
			failures = append(failures, err)
			continue
		}
		p, err := m.startChildLocked(cfg, deadline, expected)
		if err != nil {
			if p != nil {
				if stopErr := p.stop(); stopErr != nil {
					m.running[id] = p
					err = errors.Join(err, stopErr)
				}
			}
			r.State = "failed"
			r.LastError = err.Error()
			failures = append(failures, err)
		} else {
			m.running[id] = p
			if cfg.Generation < r.Highest {
				r.State = "rolled_back"
			} else {
				r.State = "ready"
				r.LastError = ""
			}
		}
		m.records[id] = r
		if err := m.finishSlotsLocked(id); err != nil {
			failures = append(failures, err)
		}
	}
	return m.statusLocked(), errors.Join(failures...)
}

// Status is a sorted, detached snapshot, including tombstones and exited runs.
func (m *Manager) Status() []Observation { m.mu.Lock(); defer m.mu.Unlock(); return m.statusLocked() }

// Close stops every child but keeps leased committed configs for a later New +
// Restore. It does not turn Agent shutdown into an authoritative deletion.
func (m *Manager) Close() error {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed && len(m.running) == 0 {
		return nil
	}
	m.closed = true
	var failures []error
	for id := range m.running {
		if err := m.stopLocked(id); err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}

func (m *Manager) saveRecordLocked(r record) error {
	all := make(map[string]record, len(m.records)+1)
	for id, item := range m.records {
		all[id] = item
	}
	all[r.ID] = r
	if err := m.cache.save(all); err != nil {
		// An uncertain durable write must never permit another stale command.
		m.records = all
		m.cacheErr = ErrCache
		for id := range m.running {
			_ = m.stopLocked(id)
		}
		return ErrCache
	}
	m.records = all
	return nil
}

func (m *Manager) stopLocked(id string) error {
	p := m.running[id]
	if p == nil {
		return nil
	}
	if err := p.stop(); err != nil {
		return err
	}
	// Lease expiry can race an atomic reload replacement after Wait removed the
	// previous inode. Once stop is confirmed, remove any recreated private file.
	if err := os.Remove(p.path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return ErrCache
	}
	delete(m.running, id)
	// A pending restart retains the union reservation until finishSlotsLocked.
	m.external.Lock()
	if slot := m.external.slots[id]; slot != nil && !slot.pending && m.external.guard != nil {
		m.external.guard.ReleaseExternal(slotOwner(id))
		delete(m.external.slots, id)
	}
	m.external.Unlock()
	return nil
}

func (m *Manager) idsLocked() []string {
	ids := make([]string, 0, len(m.records))
	for id := range m.records {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

func (m *Manager) statusLocked() []Observation {
	result := make([]Observation, 0, len(m.records))
	for _, id := range m.idsLocked() {
		result = append(result, m.observeLocked(id))
	}
	return result
}

func (m *Manager) observeLocked(id string) Observation {
	r, ok := m.records[id]
	if !ok {
		return Observation{ID: id, State: "absent"}
	}
	o := Observation{UpdateMode: "stop_start", ID: id, LinkID: r.LinkID, WorkspaceID: r.WorkspaceID, NodeID: r.NodeID, Role: r.Role, Generation: r.Highest, DesiredConfigDigest: r.DesiredDigest, State: r.State, LastError: r.LastError}
	if r.UpdateMode != "" {
		o.UpdateMode = r.UpdateMode
	}
	if r.Removed {
		return o
	}
	if r.Config != nil {
		cfg := r.Config
		o.ConfigDigest = cfg.ConfigDigest
		o.LeaseExpiresAt = cfg.LeaseExpiresAt
		o.RuntimeIDs = append([]string(nil), cfg.RuntimeIDs...)
		o.Ports = append([]Port(nil), cfg.Ports...)
		deadline, _ := time.Parse(time.RFC3339Nano, cfg.LeaseExpiresAt)
		if !time.Now().Before(deadline) {
			o.State = "expired"
			o.LastError = ErrLeaseExpired.Error()
		}
	}
	if p := m.running[id]; p != nil {
		p.mu.Lock()
		o.Logs = append([]string(nil), p.logs...)
		if p.tampered {
			o.State = "failed"
			o.LastError = ErrConfigTampered.Error()
		} else if p.expired || !time.Now().Before(p.deadline) {
			o.State = "expired"
			o.LastError = ErrLeaseExpired.Error()
		} else if p.exited {
			o.State = "exited"
			o.LastError = ErrProcessExited.Error() + " (code=" + strconv.Itoa(p.exitCode) + ")"
		} else if p.readyClosed {
			o.Ready = true
			o.PID = p.cmd.Process.Pid
			if r.Config != nil {
				o.ObservedGeneration = r.Config.Generation
			}
		}
		p.mu.Unlock()
	} else if o.State == "ready" || o.State == "rolled_back" {
		o.State = "cached"
	}
	if m.closed {
		o.Ready = false
		o.PID = 0
		o.ObservedGeneration = 0
		if !r.Removed && o.State != "expired" {
			o.State = "closed"
		}
	}
	if m.cacheErr != nil {
		o.Ready = false
		o.State = "failed"
		o.LastError = m.cacheErr.Error()
	}
	return o
}
