package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const managedPollInterval = 20 * time.Millisecond
const managedMaxConfigBytes = 1 << 20

type managedIdentity struct {
	tunnel, port, udpPort int
	host, protocol, key   string
}

var managedExits sync.Map // Identified standalone carriers only; legacy runs never register.
func exitIdentity(c config) managedIdentity {
	return managedIdentity{c.TunnelID, c.ListenPort, udpListenPort(c), c.ListenHost, c.Protocol, c.Key}
}
func managedExitFor(c config) *managedExitState {
	value, ok := managedExits.Load(exitIdentity(c))
	if !ok || c.Role != "exit" {
		return nil
	}
	return value.(*managedExitState)
}

type managedPolicy struct {
	cfg     config
	targets map[int]udpTarget
	pools   map[int]*managedTargetPool
	probes  []managedProbeJob
}
type managedExitState struct {
	mu           sync.RWMutex
	policy       atomic.Pointer[managedPolicy]
	clients      sync.Map // net.Conn -> ruleID
	udp          sync.Map // *udpDirectExitSession -> ruleID
	udpCarriers  sync.Map // net.Conn -> managedUDPBinding (legacy framed UDP)
	digest       string
	targetCtx    context.Context
	targetCancel context.CancelFunc
	targetDone   chan struct{}
	wireMu       sync.Mutex
	wires        map[managedUDPWireKey]*managedUDPWireState
}

func policyFor(cfg config) *managedPolicy {
	p := &managedPolicy{cfg: cfg, targets: make(map[int]udpTarget), pools: make(map[int]*managedTargetPool)}
	for _, target := range cfg.UDPTargets {
		p.targets[target.RuleID] = target
	}
	for _, set := range cfg.TargetSets {
		p.pools[set.RuleID] = newManagedTargetPool(set)
		if targetSetHas(set, "udp") {
			p.targets[set.RuleID] = udpTarget{RuleID: set.RuleID, TargetIP: set.Targets[0].Host, TargetPort: set.Targets[0].Port}
		}
	}
	return p
}

func (s *managedExitState) apply(cfg config, digests ...string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	old := s.policy.Load()
	next := policyFor(cfg)
	changed := make(map[int]bool)
	for rule, pool := range old.pools {
		if managedPoolsEqual(pool, next.pools[rule]) {
			next.pools[rule] = pool
		} else {
			changed[rule] = true
		}
	}
	for rule := range next.pools {
		if old.pools[rule] == nil {
			changed[rule] = true
		}
	}
	for _, binding := range old.cfg.AllowedBindings {
		if !authorizedTarget(cfg, binding.RuleID, binding.Protocol, binding.TargetIP, binding.TargetPort) {
			changed[binding.RuleID] = true
		}
	}
	for rule, target := range old.targets {
		other, ok := next.targets[rule]
		if !ok || other != target {
			changed[rule] = true
		}
	}
	next.buildProbes()
	s.policy.Store(next)
	if len(digests) > 0 {
		s.digest = digests[0]
	}
	s.clients.Range(func(key, value any) bool {
		if changed[value.(int)] {
			_ = key.(net.Conn).Close()
			s.clients.Delete(key)
		}
		return true
	})
	s.udp.Range(func(key, value any) bool {
		if changed[value.(int)] {
			key.(*udpDirectExitSession).close()
			s.udp.Delete(key)
		}
		return true
	})
}

// Only managed entry runtimes track accepted clients. Closing the listener alone
// would leave deleted bindings' established TCP sessions forwarding indefinitely.
type managedClients struct {
	mu      sync.Mutex
	closed  bool
	clients map[net.Conn]bool
	done    chan struct{}
}

func (s *managedClients) add(c net.Conn) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return false
	}
	s.clients[c] = true
	return true
}
func (s *managedClients) remove(c net.Conn) { s.mu.Lock(); delete(s.clients, c); s.mu.Unlock() }
func (s *managedClients) close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	s.closed = true
	if s.done != nil {
		close(s.done)
	}
	for c := range s.clients {
		_ = c.Close()
	}
}

type managedEntry struct {
	cfg        config
	runtime    *entryRuntime
	clients    *managedClients
	stop, done chan struct{}
	stopOnce   sync.Once
	started    bool
}

func prepareManagedEntry(cfg config) (*managedEntry, error) {
	clients := &managedClients{clients: make(map[net.Conn]bool), done: make(chan struct{})}
	rt, err := prepareEntryRuntime(cfg, clients)
	if err != nil {
		return nil, err
	}
	return &managedEntry{cfg: cfg, runtime: rt, clients: clients, stop: make(chan struct{}), done: make(chan struct{})}, nil
}
func (e *managedEntry) start(failed chan<- error) {
	e.started = true
	go func() {
		defer close(e.done)
		err := e.runtime.serve(e.stop)
		select {
		case <-e.stop:
			return
		default:
		}
		select {
		case failed <- errors.New("managed entry stopped"):
		default:
		}
		_ = err
	}()
}
func (e *managedEntry) close() error {
	e.stopOnce.Do(func() {
		e.clients.close()
		close(e.stop)
		e.runtime.close()
		if !e.started {
			close(e.done)
		}
	})
	select {
	case <-e.done:
		return nil
	case <-time.After(6 * time.Second):
		return errors.New("managed entry stop timeout")
	}
}

type managedRuntime struct {
	cfg     config
	digest  string
	entries map[int]*managedEntry
	exit    *managedExitState
	failed  chan error
	prepare func(config) (*managedEntry, error)
}

func (m *managedRuntime) prepareEntry(cfg config) (*managedEntry, error) {
	if m.prepare != nil {
		return m.prepare(cfg)
	}
	return prepareManagedEntry(cfg)
}

func managedEnabled(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, managedMaxConfigBytes+1))
	if err != nil || len(data) > managedMaxConfigBytes {
		return false
	}
	var flags struct {
		ManagedReload bool `json:"managedReload"`
	}
	return json.Unmarshal(data, &flags) == nil && flags.ManagedReload
}

func readManagedConfig(path string, targetsEnabled ...bool) (config, string, error) {
	var cfg config
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > managedMaxConfigBytes || (runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0) {
		return cfg, "", errors.New("private config file rejected")
	}
	parent, err := os.Lstat(filepath.Dir(path))
	if err != nil || !parent.IsDir() || parent.Mode()&os.ModeSymlink != 0 || (runtime.GOOS != "windows" && parent.Mode().Perm()&0o077 != 0) {
		return cfg, "", errors.New("private config directory rejected")
	}
	f, err := os.Open(path)
	if err != nil {
		return cfg, "", errors.New("config read failed")
	}
	defer f.Close()
	opened, err := f.Stat()
	if err != nil || !os.SameFile(info, opened) {
		return cfg, "", errors.New("config identity changed")
	}
	data, err := io.ReadAll(io.LimitReader(f, managedMaxConfigBytes+1))
	if err != nil || len(data) > managedMaxConfigBytes {
		return cfg, "", errors.New("config read failed")
	}
	sum := sha256.Sum256(data)
	digest := hex.EncodeToString(sum[:])
	var flags struct {
		ManagedReload bool `json:"managedReload"`
	}
	if json.Unmarshal(data, &flags) != nil || !flags.ManagedReload || json.Unmarshal(data, &cfg) != nil {
		return cfg, digest, errors.New("invalid managed config")
	}
	enableManagedTargets(&cfg, len(targetsEnabled) > 0 && targetsEnabled[0])
	if validateManagedTargets(cfg) != nil {
		return cfg, digest, errors.New("invalid managed config")
	}
	// Legacy normalization drops malformed UDP targets. Managed updates must
	// reject the whole candidate instead of silently authorizing a subset.
	if !validManagedRaw(cfg) {
		return cfg, digest, errors.New("invalid managed config")
	}
	cfg = normalizeConfig(cfg)
	if validateConfig(cfg) != nil || (cfg.Role != "exit" && cfg.Role != "entry-group") {
		return cfg, digest, errors.New("invalid managed config")
	}
	if cfg.Role == "entry-group" {
		seen := map[int]bool{}
		var carrierKey string
		for _, entry := range cfg.Entries {
			if entry.RuleID <= 0 || seen[entry.RuleID] {
				return cfg, digest, errors.New("duplicate managed binding")
			}
			seen[entry.RuleID] = true
			if carrierKey == "" {
				carrierKey = entry.Key
			}
			if entry.Key != carrierKey {
				return cfg, digest, errors.New("managed carrier key mismatch")
			}
		}
	}
	return cfg, digest, nil
}

func validManagedRaw(cfg config) bool {
	if cfg.LimitIn < 0 || cfg.LimitOut < 0 || cfg.MaxConnections < 0 || cfg.MaxIPs < 0 {
		return false
	}
	if cfg.Role != "entry-group" && (strings.TrimSpace(cfg.Key) == "" || (cfg.Protocol != "tcp" && cfg.Protocol != "udp" && cfg.Protocol != "both")) {
		return false
	}
	seen := map[int]bool{}
	for _, target := range cfg.UDPTargets {
		if target.RuleID <= 0 || seen[target.RuleID] || strings.TrimSpace(target.TargetIP) == "" || target.TargetPort <= 0 || target.TargetPort > 65535 {
			return false
		}
		seen[target.RuleID] = true
	}
	for _, entry := range cfg.Entries {
		if !validManagedRaw(entry) {
			return false
		}
	}
	return true
}

func immutableManagedConfig(cfg config) config {
	cfg.Entries = nil
	cfg.AllowedBindings = nil
	cfg.UDPTargets = nil
	cfg.TargetSets = nil
	return cfg
}
func entryTransportEqual(a, b config) bool {
	// Business listener ports belong to an individual rule. Rebuild that rule,
	// while retaining the shared carrier and every unchanged sibling runtime.
	return a.Key == b.Key && a.TunnelID == b.TunnelID && a.RuleID == b.RuleID && a.ListenHost == b.ListenHost && a.Protocol == b.Protocol && a.ExitHost == b.ExitHost && a.ExitPort == b.ExitPort && a.UDPExitPort == b.UDPExitPort && reflect.DeepEqual(a.Exits, b.Exits)
}
func sameEntry(a, b config) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return bytes.Equal(x, y)
}

func (m *managedRuntime) apply(cfg config, digests ...string) (string, error) {
	if !reflect.DeepEqual(immutableManagedConfig(m.cfg), immutableManagedConfig(cfg)) {
		return "immutable", nil
	}
	if m.exit != nil {
		m.exit.apply(cfg, digests...)
		m.cfg = cfg
		return "", nil
	}
	oldByID := make(map[int]config)
	for _, e := range m.cfg.Entries {
		oldByID[e.RuleID] = e
	}
	newByID := make(map[int]config)
	for _, e := range cfg.Entries {
		newByID[e.RuleID] = e
		if old, ok := oldByID[e.RuleID]; ok && !entryTransportEqual(old, e) {
			return "immutable", nil
		}
	}
	if len(m.cfg.Entries) > 0 && len(cfg.Entries) > 0 && m.cfg.Entries[0].Key != cfg.Entries[0].Key {
		return "immutable", nil
	}
	changed := []int{}
	for id, old := range oldByID {
		next, ok := newByID[id]
		if !ok || !sameEntry(old, next) {
			changed = append(changed, id)
		}
	}
	sort.Ints(changed)
	staged := make(map[int]*managedEntry)
	// Validate every entry before any mutation. Prepare brand-new listeners first
	// whenever they don't need an affected entry's occupied socket.
	for _, e := range cfg.Entries {
		if _, exists := oldByID[e.RuleID]; !exists {
			conflict := false
			for _, old := range m.cfg.Entries {
				for _, protocol := range []string{"tcp", "udp"} {
					if protocolHas(e, protocol) && protocolHas(old, protocol) {
						ep, op := e.ListenPort, old.ListenPort
						if protocol == "udp" {
							ep, op = udpListenPort(e), udpListenPort(old)
						}
						if ep == op && (e.ListenHost == "" || old.ListenHost == "" || e.ListenHost == old.ListenHost) {
							conflict = true
						}
					}
				}
			}
			if !conflict {
				prepared, err := m.prepareEntry(e)
				if err != nil {
					for _, s := range staged {
						s.runtime.close()
					}
					return "bind", nil
				}
				staged[e.RuleID] = prepared
			}
		}
	}
	for _, id := range changed {
		if err := m.entries[id].close(); err != nil {
			for _, s := range staged {
				_ = s.close()
			}
			return "stop", err
		}
		delete(m.entries, id)
	}
	for _, e := range cfg.Entries {
		if current := m.entries[e.RuleID]; current != nil {
			continue
		}
		if staged[e.RuleID] != nil {
			continue
		}
		prepared, err := m.prepareEntry(e)
		if err != nil {
			for _, s := range staged {
				s.runtime.close()
			}
			for _, id := range changed {
				restored, restoreErr := m.prepareEntry(oldByID[id])
				if restoreErr != nil {
					return "rollback", errors.New("managed binding rollback failed")
				}
				m.entries[id] = restored
				restored.start(m.failed)
			}
			return "bind", nil
		}
		staged[e.RuleID] = prepared
	}
	for id, e := range staged {
		m.entries[id] = e
		e.start(m.failed)
	}
	m.cfg = cfg
	return "", nil
}

func runManaged(done <-chan struct{}, path string, targetsEnabled ...bool) error {
	cfg, digest, err := readManagedConfig(path, targetsEnabled...)
	if err != nil {
		return err
	}
	runDone := make(chan struct{})
	var stopOnce sync.Once
	stop := func() { stopOnce.Do(func() { close(runDone) }) }
	defer stop()
	go func() {
		select {
		case <-done:
			stop()
		case <-runDone:
		}
	}()
	m := &managedRuntime{cfg: cfg, digest: digest, entries: make(map[int]*managedEntry), failed: make(chan error, 4)}
	defer func() {
		stop()
		for _, e := range m.entries {
			_ = e.close()
		}
		if m.exit != nil {
			m.exit.stopTargets()
			m.exit.clients.Range(func(k, v any) bool { _ = k.(net.Conn).Close(); return true })
			m.exit.udp.Range(func(k, v any) bool { k.(*udpDirectExitSession).close(); return true })
		}
	}()
	if cfg.Role == "exit" {
		m.exit = &managedExitState{digest: digest}
		policy := policyFor(cfg)
		policy.buildProbes()
		m.exit.policy.Store(policy)
		m.exit.targetCtx, m.exit.targetCancel = context.WithCancel(context.Background())
		managedExits.Store(exitIdentity(cfg), m.exit)
		defer managedExits.Delete(exitIdentity(cfg))
		bound := make(chan struct{})
		go func() { m.failed <- runExit(runDone, cfg, func() { close(bound) }) }()
		select {
		case <-bound:
		case <-done:
			return nil
		case <-m.failed:
			return errors.New("managed exit bind failed")
		}
		m.exit.startTargets(runDone)
	} else {
		for _, entry := range cfg.Entries {
			e, err := prepareManagedEntry(entry)
			if err != nil {
				for _, prepared := range m.entries {
					prepared.runtime.close()
				}
				m.entries = map[int]*managedEntry{}
				return errors.New("managed entry bind failed")
			}
			m.entries[entry.RuleID] = e
		}
		for _, entry := range m.entries {
			entry.start(m.failed)
		}
	}
	log.Printf("managed applied sha256=%s", digest)
	if m.exit != nil {
		m.exit.emitTargets()
	}
	lastSeen := digest
	ticker := time.NewTicker(managedPollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-done:
			return nil
		case err := <-m.failed:
			if err == nil {
				select {
				case <-done:
					return nil
				default:
				}
			}
			return errors.New("managed runtime stopped")
		case <-ticker.C:
			next, nextDigest, readErr := readManagedConfig(path, targetsEnabled...)
			if nextDigest == lastSeen {
				continue
			}
			lastSeen = nextDigest
			if readErr != nil {
				if nextDigest == "" {
					nextDigest = hex.EncodeToString(make([]byte, 32))
				}
				log.Printf("managed rejected sha256=%s code=invalid", nextDigest)
				continue
			}
			if nextDigest == m.digest {
				log.Printf("managed applied sha256=%s", nextDigest)
				continue
			}
			code, applyErr := m.apply(next, nextDigest)
			if applyErr != nil {
				return applyErr
			}
			if code != "" {
				log.Printf("managed rejected sha256=%s code=%s", nextDigest, code)
				continue
			}
			m.digest = nextDigest
			log.Printf("managed applied sha256=%s", nextDigest)
			if m.exit != nil {
				m.exit.emitTargets()
			}
		}
	}
}
