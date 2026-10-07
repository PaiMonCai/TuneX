package linkrunner

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"
)

// Leave room for a complete 500-rule day and a configuration transition.
// Epochs bound history without restarting listeners or weakening watermarks.
const trafficRotationThreshold = 1024

type trafficRotationRequest struct {
	Version        int    `json:"version"`
	ProducerID     string `json:"producer_id"`
	NextProducerID string `json:"next_producer_id"`
}

func probeTrafficRotation(binary string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, binary, "-managed-traffic-capabilities")
	for _, env := range os.Environ() {
		name, _, _ := strings.Cut(env, "=")
		if !strings.EqualFold(name, "AUTH_SECRET") && !strings.EqualFold(name, "NODE_CREDENTIAL") {
			cmd.Env = append(cmd.Env, env)
		}
	}
	var out bytes.Buffer
	cmd.Stdout = &boundedTrafficProbe{buffer: &out}
	cmd.Stderr = io.Discard
	if cmd.Run() != nil {
		return false
	}
	var reply struct {
		Rotation int `json:"managed_traffic_rotation"`
	}
	dec := json.NewDecoder(&out)
	dec.DisallowUnknownFields()
	return dec.Decode(&reply) == nil && dec.Decode(new(any)) == io.EOF && reply.Rotation == 1
}

type boundedTrafficProbe struct{ buffer *bytes.Buffer }

func (p *boundedTrafficProbe) Write(b []byte) (int, error) {
	if p.buffer.Len()+len(b) > 512 {
		return 0, ErrTraffic
	}
	return p.buffer.Write(b)
}

func (m *Manager) TrafficRotationSupported() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.traffic != nil && m.traffic.rotation
}

func trafficSnapshotVersion(manifest, snapshot int) bool {
	return manifest == 1 && snapshot == 1 || manifest == 2 && (snapshot == 2 || snapshot == 3)
}

func trafficRotationDue(p trafficProducer) bool {
	if len(p.snapshot.Samples) >= trafficRotationThreshold || len(p.manifest.Rules) >= trafficRotationThreshold {
		return true
	}
	today := time.Now().In(time.FixedZone("Asia/Shanghai", 8*60*60)).Format("2006-01-02")
	for _, sample := range p.snapshot.Samples {
		if sample.Date < today {
			return true
		}
	}
	return false
}

// An authenticated preparation explains exactly one future epoch. A missing
// empty destination is recoverable only before old sealing and after process
// exit; a sealed predecessor with missing successor is unexplained data loss.
func (m *Manager) validatePreparedTrafficLocked(producers []trafficProducer) error {
	byID := make(map[string]trafficProducer, len(producers))
	for _, p := range producers {
		byID[p.manifest.ProducerID] = p
	}
	referenced := map[string]bool{}
	for _, p := range producers {
		from := p.manifest.PreparedFrom
		if from == "" {
			continue
		}
		old, exists := byID[from]
		if !exists || referenced[from] || old.manifest.Discard || old.manifest.PreparedFrom != "" ||
			old.manifest.Version != 2 || old.manifest.PlacementID != p.manifest.PlacementID ||
			old.manifest.LinkID != p.manifest.LinkID || old.manifest.WorkspaceID != p.manifest.WorkspaceID ||
			old.manifest.NodeID != p.manifest.NodeID {
			return ErrTraffic
		}
		referenced[from] = true
		if p.snapshot.Version == 0 {
			if old.snapshot.Version == 3 || m.trafficActiveLocked(from) {
				return ErrTraffic
			}
		} else if old.snapshot.Version != 3 && (len(p.snapshot.Samples) != 0 || m.trafficActiveLocked(from)) {
			return ErrTraffic
		}
	}
	return nil
}

func (m *Manager) rotateTrafficLocked(child *child, candidate Config) error {
	if m.traffic == nil || child.rotationPath == "" || !child.live() {
		return ErrTraffic
	}
	ids, _, err := m.traffic.inventory()
	if err != nil || len(ids) >= maxTrafficProducers {
		return ErrTraffic
	}
	old, err := m.readTrafficManifestLocked(child.trafficProducer)
	if err != nil || old.Version != 2 || old.PreparedFrom != "" || old.Discard {
		return ErrTraffic
	}
	current := m.records[old.PlacementID].Config
	if current == nil || current.ID != candidate.ID {
		return ErrTraffic
	}
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return ErrTraffic
	}
	nextID := hex.EncodeToString(random[:])
	for _, suffix := range []string{trafficManifestSuffix, trafficSnapshotSuffix} {
		if _, err := os.Lstat(m.traffic.path(nextID, suffix)); !errors.Is(err, os.ErrNotExist) {
			return ErrTraffic
		}
	}
	next := trafficManifest{Version: 2, ProducerID: nextID, PreparedFrom: old.ProducerID,
		PlacementID: old.PlacementID, LinkID: old.LinkID, WorkspaceID: old.WorkspaceID,
		NodeID: old.NodeID, Role: old.Role, Last: []trafficCounter{}}
	// The old config may still generate delayed samples until candidate apply.
	// First-known metadata is immutable within each epoch, including rollback.
	if addTrafficRules(&next, *current) != nil || addTrafficRules(&next, candidate) != nil {
		return ErrTraffic
	}
	if m.writeTrafficManifestLocked(next) != nil {
		return ErrTraffic
	}
	body, err := json.Marshal(trafficRotationRequest{1, old.ProducerID, nextID})
	if err != nil || atomicPrivateWrite(child.rotationPath, body) != nil {
		return ErrTraffic
	}
	deadline := time.Now().Add(startupTimeout)
	for time.Now().Before(deadline) {
		if !child.live() {
			return ErrTraffic
		}
		oldBody, oldErr := readTrafficFile(m.traffic.path(old.ProducerID, trafficSnapshotSuffix))
		newBody, newErr := readTrafficFile(m.traffic.path(nextID, trafficSnapshotSuffix))
		var previous, currentSnapshot trafficSnapshot
		if oldErr == nil && newErr == nil && decodeTrafficJSON(oldBody, &previous) == nil &&
			decodeTrafficJSON(newBody, &currentSnapshot) == nil && previous.ProducerID == old.ProducerID &&
			previous.Version == 3 && currentSnapshot.ProducerID == nextID && currentSnapshot.Version == 2 {
			child.trafficProducer = nextID
			child.trafficStartedAt = time.Now().UTC()
			_, err := m.scanTrafficLocked()
			return err
		}
		time.Sleep(10 * time.Millisecond)
	}
	return ErrTraffic
}

func (m *Manager) markTrafficAckLocked(placement string) {
	if m.traffic.lastAck == nil {
		m.traffic.lastAck = map[string]time.Time{}
	}
	m.traffic.lastAck[placement] = time.Now().UTC()
}

func (m *Manager) updateTrafficStatsLocked(producers []trafficProducer) {
	if m.traffic == nil {
		return
	}
	stats := map[string]TrafficStatus{}
	if m.traffic.started == nil {
		m.traffic.started = map[string]time.Time{}
	}
	for _, p := range producers {
		id := p.manifest.PlacementID
		s := stats[id]
		s.RotationSupported = m.traffic.rotation
		s.ProducerCount++
		s.SampleCount += len(p.snapshot.Samples)
		s.RuleCount += len(p.manifest.Rules)
		for _, suffix := range []string{trafficManifestSuffix, trafficSnapshotSuffix} {
			if info, err := os.Lstat(m.traffic.path(p.manifest.ProducerID, suffix)); err == nil && info.Mode().IsRegular() {
				s.SpoolBytes += info.Size()
			}
		}
		if m.traffic.started[id].IsZero() {
			m.traffic.started[id] = time.Now().UTC()
		}
		stats[id] = s
	}
	m.traffic.stats, m.traffic.blocked = stats, false
}

func (m *Manager) trafficStatusLocked(id string) *TrafficStatus {
	if m.traffic == nil || m.records[id].Role != "ingress" {
		return nil
	}
	s := m.traffic.stats[id]
	s.RotationSupported, s.State = m.traffic.rotation, "idle"
	ack := m.traffic.lastAck[id]
	if !ack.IsZero() {
		stamp := ack.Format(time.RFC3339Nano)
		s.LastAckAt = &stamp
	}
	if s.ProducerCount > 0 {
		s.State = "collecting"
		since := m.traffic.started[id]
		if !ack.IsZero() {
			since = ack
		}
		// A fresh listener with no samples needs no HTTP acknowledgement.
		// Its silence is not an upload backlog.
		if s.SampleCount > 0 && !since.IsZero() && time.Since(since) >= time.Minute {
			s.State = "backlogged"
		}
	} else {
		delete(m.traffic.started, id)
	}
	if m.traffic.blocked {
		s.State = "blocked"
	}
	return &s
}
