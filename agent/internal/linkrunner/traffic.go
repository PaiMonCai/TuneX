package linkrunner

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
)

var (
	ErrTraffic        = errors.New("linkrunner: private traffic spool unavailable, full or corrupt")
	ErrTrafficAck     = errors.New("linkrunner: invalid traffic acknowledgement")
	ErrTrafficStarted = errors.New("linkrunner: enable traffic before Apply or Restore")
)

// TrafficSample is a cumulative ingress counter, not a delta. These are the
// complete wire fields; no process/config/transport credentials are exposed.
type TrafficSample struct {
	ProducerID   string `json:"producer_id"`
	LinkID       int64  `json:"link_id"`
	WorkspaceID  int64  `json:"workspace_id"`
	NodeID       int64  `json:"node_id"`
	ForwardID    int64  `json:"forward_id"`
	Generation   int64  `json:"generation"`
	ConfigDigest string `json:"config_digest"`
	Date         string `json:"date"`
	BytesIn      string `json:"bytes_in"`
	BytesOut     string `json:"bytes_out"`
	Connections  string `json:"connections"`
}

type childTraffic struct {
	enabled        bool
	producer, path string
	rotationPath   string
	targetsEnabled bool
}
type trafficKey struct {
	producer string
	forward  int64
	date     string
}

func (s TrafficSample) key() trafficKey { return trafficKey{s.ProducerID, s.ForwardID, s.Date} }

// EnableTraffic is optional and must precede the first Apply/Restore. It also
// validates durable producers from previous runs. A directory has one owner.
func (m *Manager) EnableTraffic() error {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return ErrClosed
	}
	if m.lifecycleStarted {
		return ErrTrafficStarted
	}
	if m.cacheErr != nil {
		return m.cacheErr
	}
	if runtime.GOOS != "linux" && runtime.GOOS != "windows" {
		return ErrTraffic
	}
	if m.traffic == nil {
		dir := filepath.Join(m.cache.dir, "traffic")
		if privateDirectory(dir) != nil {
			return ErrTraffic
		}
		m.traffic = &trafficStore{dir: dir}
	}
	m.traffic.rotation = probeTrafficRotation(m.binaryPath)
	m.traffic.epochAge = 24 * time.Hour
	if raw := strings.TrimSpace(os.Getenv("TUNEX_FXP_TRAFFIC_EPOCH_SECONDS")); raw != "" {
		seconds, err := strconv.Atoi(raw)
		if err != nil || seconds < 30 || seconds > 86400 {
			return ErrTraffic
		}
		m.traffic.epochAge = time.Duration(seconds) * time.Second
	}
	_, err := m.scanTrafficLocked()
	return err
}

// TrafficSamples includes stopped, removed, failed and previous-run producers.
// It checkpoints monotonic counters before returning them, so a later replay
// (including after Agent restart) fails closed. Invalid data is never skipped.
func (m *Manager) TrafficSamples() ([]TrafficSample, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.traffic == nil {
		return nil, nil
	}
	producers, err := m.scanTrafficLocked()
	if err != nil {
		return nil, m.trafficFailureLocked(err)
	}
	// A new accounting epoch does not restart the business process. Keep the
	// sealed old epoch intact until its complete final totals are committed.
	for _, p := range producers {
		child := m.running[p.manifest.PlacementID]
		if child != nil && child.trafficProducer == p.manifest.ProducerID && child.rotationPath != "" &&
			child.live() && (trafficRotationDue(p) || !child.trafficStartedAt.IsZero() && time.Since(child.trafficStartedAt) >= m.traffic.epochAge) {
			cfg := m.records[p.manifest.PlacementID].Config
			if cfg == nil {
				return nil, m.trafficFailureLocked(ErrTraffic)
			}
			if err := m.rotateTrafficLocked(child, *cfg); err != nil {
				return nil, m.trafficFailureLocked(err)
			}
		}
	}
	producers, err = m.scanTrafficLocked()
	if err != nil {
		return nil, m.trafficFailureLocked(err)
	}
	var out []TrafficSample
	for _, p := range producers {
		out = append(out, p.samples()...)
	}
	return out, nil
}

// AckTraffic never deletes active files. A stopped or sealed producer is reclaimed only
// when every current persisted rule/day total is exactly acknowledged. Stale or
// partial ACKs retain it; duplicate calls after deletion are harmless.
func (m *Manager) AckTraffic(samples []TrafficSample) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(samples) > maxTrafficProducers*maxTrafficSamples {
		return ErrTrafficAck
	}
	acks := make(map[trafficKey]TrafficSample, len(samples))
	for _, s := range samples {
		if !validTrafficSample(s) {
			return ErrTrafficAck
		}
		if _, exists := acks[s.key()]; exists {
			return ErrTrafficAck
		}
		acks[s.key()] = s
	}
	if m.traffic == nil {
		if len(samples) != 0 {
			return ErrTrafficAck
		}
		return nil
	}
	producers, err := m.scanTrafficLocked()
	if err != nil {
		return m.trafficFailureLocked(err)
	}
	// Validate the whole response before deleting anything. Acknowledgements
	// for already-deleted producer IDs are intentionally idempotent.
	byID := make(map[string]trafficProducer, len(producers))
	currentSamples := make(map[trafficKey]TrafficSample)
	for _, p := range producers {
		byID[p.manifest.ProducerID] = p
		for _, s := range p.samples() {
			currentSamples[s.key()] = s
		}
	}
	for _, s := range samples {
		_, exists := byID[s.ProducerID]
		if !exists {
			continue
		}
		current, matched := currentSamples[s.key()]
		if !matched || !trafficMetadataEqual(current, s) || !trafficCounterLE(s.counter(), current.counter()) {
			return ErrTrafficAck
		}
	}
	for _, s := range samples {
		if p, exists := byID[s.ProducerID]; exists {
			m.markTrafficAckLocked(p.manifest.PlacementID)
		}
	}
	for _, p := range producers {
		if m.trafficActiveLocked(p.manifest.ProducerID) {
			continue
		}
		complete := true
		for _, s := range p.samples() {
			if ack, ok := acks[s.key()]; !ok || ack != s {
				complete = false
				break
			}
		}
		if !complete {
			continue
		}
		// Persist a deletion intent first. Recovery may finish an interrupted
		// deletion only if the remaining snapshot still equals these totals.
		p.manifest.Discard = true
		if err := m.writeTrafficManifestLocked(p.manifest); err != nil {
			return m.trafficFailureLocked(err)
		}
		if err := m.finishTrafficDeletionLocked(p.manifest.ProducerID); err != nil {
			return m.trafficFailureLocked(err)
		}
	}
	_, err = m.scanTrafficLocked()
	if err != nil {
		return m.trafficFailureLocked(err)
	}
	return nil
}

func (m *Manager) startChildLocked(cfg Config, deadline time.Time, expected []listener) (*child, error) {
	options := childTraffic{enabled: m.traffic != nil}
	if !m.targetProbeDone {
		m.targetSupport, m.targetProbeDone = probeTargetSets(m.binaryPath), true
	}
	options.targetsEnabled = m.targetSupport
	// Restore must enforce the same capability gate as a new Apply. An older
	// runner must never ignore a persisted target set and use its first member.
	if usesTargetSets(cfg.RunnerConfig) && !options.targetsEnabled {
		return nil, ErrTargetCapability
	}
	if options.enabled && cfg.Role == "ingress" {
		if !managedConfig(cfg.RunnerConfig) {
			return nil, ErrTraffic
		}
		if _, err := m.scanTrafficLocked(); err != nil {
			return nil, m.trafficFailureLocked(err)
		}
		entries, _, err := m.traffic.inventory()
		if err != nil || len(entries) >= maxTrafficProducers {
			return nil, m.trafficFailureLocked(ErrTraffic)
		}
		var id [16]byte
		if _, err := rand.Read(id[:]); err != nil {
			return nil, m.trafficFailureLocked(ErrTraffic)
		}
		options.producer = hex.EncodeToString(id[:])
		options.path = m.traffic.path(options.producer, trafficSnapshotSuffix)
		if _, err := os.Lstat(options.path); !errors.Is(err, os.ErrNotExist) {
			return nil, m.trafficFailureLocked(ErrTraffic)
		}
		if _, err := os.Lstat(m.traffic.path(options.producer, trafficManifestSuffix)); !errors.Is(err, os.ErrNotExist) {
			return nil, m.trafficFailureLocked(ErrTraffic)
		}
		manifest := trafficManifest{Version: 1, ProducerID: options.producer, PlacementID: cfg.ID, LinkID: cfg.LinkID, WorkspaceID: cfg.WorkspaceID, NodeID: cfg.NodeID, Role: cfg.Role, Last: []trafficCounter{}}
		if m.traffic.rotation {
			manifest.Version = 2
			options.rotationPath = filepath.Join(m.runtimeDir, "fxp-traffic-rotate-"+options.producer+".json")
		}
		if err := addTrafficRules(&manifest, cfg); err != nil {
			return nil, m.trafficFailureLocked(err)
		}
		if err := m.writeTrafficManifestLocked(manifest); err != nil {
			return nil, m.trafficFailureLocked(err)
		}
		// FXP requires a new destination and writes its first empty snapshot
		// before starting listeners. Never overwrite or pre-seed that file.
	}
	p, err := startChild(m.binaryPath, m.runtimeDir, cfg, deadline, expected, options)
	if err == nil && options.producer != "" {
		if _, scanErr := m.scanTrafficLocked(); scanErr != nil {
			return p, m.trafficFailureLocked(scanErr)
		}
	}
	return p, err
}

func (m *Manager) extendTrafficLocked(child *child, cfg Config) error {
	if m.traffic == nil || child.trafficProducer == "" {
		return nil
	}
	producers, err := m.scanTrafficLocked()
	if err != nil {
		return m.trafficFailureLocked(err)
	}
	for _, p := range producers {
		if p.manifest.ProducerID != child.trafficProducer {
			continue
		}
		manifest := p.manifest
		if manifest.PlacementID != cfg.ID || manifest.LinkID != cfg.LinkID || manifest.WorkspaceID != cfg.WorkspaceID || manifest.NodeID != cfg.NodeID {
			return m.trafficFailureLocked(ErrTraffic)
		}
		candidate := manifest
		candidate.Rules = append([]trafficRule(nil), manifest.Rules...)
		if err := addTrafficRules(&candidate, cfg); err != nil {
			return m.trafficFailureLocked(err)
		}
		if child.rotationPath != "" && len(candidate.Rules) >= trafficRotationThreshold {
			if err := m.rotateTrafficLocked(child, cfg); err != nil {
				return m.trafficFailureLocked(err)
			}
			return nil
		}
		manifest = candidate
		if len(manifest.Rules) == len(p.manifest.Rules) {
			return nil
		}
		if err := m.writeTrafficManifestLocked(manifest); err != nil {
			return m.trafficFailureLocked(err)
		}
		return nil
	}
	return m.trafficFailureLocked(ErrTraffic)
}

func addTrafficRules(manifest *trafficManifest, cfg Config) error {
	var shape runnerShape
	if json.Unmarshal(cfg.RunnerConfig, &shape) != nil || cfg.Role != "ingress" || shape.Role != "entry-group" || shape.TunnelID != cfg.LinkID || !safeTrafficInt(cfg.Generation) {
		return ErrTraffic
	}
	known := make(map[int64]bool, len(manifest.Rules))
	for _, rule := range manifest.Rules {
		known[rule.ForwardID] = true
	}
	for _, entry := range shape.Entries {
		if !safeTrafficInt(entry.RuleID) {
			return ErrTraffic
		}
		if known[entry.RuleID] {
			continue
		} // Both transports share one forward ID.
		manifest.Rules = append(manifest.Rules, trafficRule{entry.RuleID, cfg.Generation, cfg.ConfigDigest})
		known[entry.RuleID] = true
	}
	if len(manifest.Rules) == 0 || len(manifest.Rules) > maxTrafficSamples {
		return ErrTraffic
	}
	sort.Slice(manifest.Rules, func(i, j int) bool { return manifest.Rules[i].ForwardID < manifest.Rules[j].ForwardID })
	return nil
}

func (m *Manager) trafficActiveLocked(producer string) bool {
	for _, p := range m.running {
		if p.trafficProducer != producer {
			continue
		}
		// Expired/tampered is not proof of exit: it may still flush counters.
		select {
		case <-p.done:
		default:
			return true
		}
	}
	return false
}

func (m *Manager) trafficFailureLocked(err error) error {
	if m.traffic != nil {
		m.traffic.blocked = true
	}
	var failures []error
	for id, p := range m.running {
		if p.trafficProducer != "" {
			failures = append(failures, m.stopLocked(id))
		}
	}
	return errors.Join(ErrTraffic, err, errors.Join(failures...))
}

func (s TrafficSample) counter() trafficCounter {
	return trafficCounter{s.ForwardID, s.Date, s.BytesIn, s.BytesOut, s.Connections}
}

func trafficMetadataEqual(a, b TrafficSample) bool {
	a.BytesIn, a.BytesOut, a.Connections = "", "", ""
	b.BytesIn, b.BytesOut, b.Connections = "", "", ""
	return a == b
}
