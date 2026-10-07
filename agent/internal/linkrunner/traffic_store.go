package linkrunner

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	maxTrafficFileBytes   = 1 << 20
	maxTrafficSamples     = 2048
	maxTrafficProducers   = 128
	maxTrafficTemps       = maxTrafficProducers + 1 // One writer per producer plus the Agent.
	maxTrafficSpoolBytes  = (maxTrafficProducers*2 + maxTrafficTemps) * maxTrafficFileBytes
	maxTrafficSafe        = int64(9007199254740991)
	trafficManifestSuffix = ".manifest.json"
	trafficSnapshotSuffix = ".snapshot.json"
)

type trafficStore struct {
	dir      string
	rotation bool
	epochAge time.Duration
	stats    map[string]TrafficStatus
	lastAck  map[string]time.Time
	started  map[string]time.Time
	blocked  bool
}

type trafficCounter struct {
	ForwardID   int64  `json:"forward_id"`
	Date        string `json:"date"`
	BytesIn     string `json:"bytes_in"`
	BytesOut    string `json:"bytes_out"`
	Connections string `json:"connections"`
}

type trafficSnapshot struct {
	Version    int              `json:"version"`
	ProducerID string           `json:"producer_id"`
	Samples    []trafficCounter `json:"samples"`
}

type trafficRule struct {
	ForwardID    int64  `json:"forward_id"`
	Generation   int64  `json:"generation"`
	ConfigDigest string `json:"config_digest"`
}

// No runner JSON, transport keys or node credentials are persisted here. Last
// is a durable high-water checkpoint; Discard is a crash-safe exact-total ACK.
type trafficManifest struct {
	Version      int              `json:"version"`
	ProducerID   string           `json:"producer_id"`
	PlacementID  string           `json:"placement_id"`
	LinkID       int64            `json:"link_id"`
	WorkspaceID  int64            `json:"workspace_id"`
	NodeID       int64            `json:"node_id"`
	Role         string           `json:"role"`
	Rules        []trafficRule    `json:"rules"`
	Last         []trafficCounter `json:"last"`
	Discard      bool             `json:"discard"`
	PreparedFrom string           `json:"prepared_from,omitempty"`
}

type trafficEnvelope struct {
	Version int    `json:"version"`
	Nonce   []byte `json:"nonce"`
	Sealed  []byte `json:"sealed"`
}

type trafficProducer struct {
	manifest trafficManifest
	snapshot trafficSnapshot
}

func (p trafficProducer) samples() []TrafficSample {
	rules := make(map[int64]trafficRule, len(p.manifest.Rules))
	for _, rule := range p.manifest.Rules {
		rules[rule.ForwardID] = rule
	}
	result := make([]TrafficSample, 0, len(p.snapshot.Samples))
	for _, counter := range p.snapshot.Samples {
		rule := rules[counter.ForwardID]
		result = append(result, TrafficSample{p.manifest.ProducerID, p.manifest.LinkID, p.manifest.WorkspaceID, p.manifest.NodeID, counter.ForwardID, rule.Generation, rule.ConfigDigest, counter.Date, counter.BytesIn, counter.BytesOut, counter.Connections})
	}
	return result
}

func (s *trafficStore) path(producer, suffix string) string {
	return filepath.Join(s.dir, producer+suffix)
}

func checkTrafficDirectory(dir string) error {
	if !filepath.IsAbs(dir) {
		return ErrTraffic
	}
	for path := dir; ; path = filepath.Dir(path) {
		info, err := os.Lstat(path)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return ErrTraffic
		}
		if path == dir && runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0 {
			return ErrTraffic
		}
		if filepath.Dir(path) == path {
			break
		}
	}
	return nil
}

// Inventory is strict and bounded, including writer scratch space. Atomic
// writers may use private *.tmp files, which are retained and counted rather
// than cleaned up. Orphan snapshots, arbitrary names and symlinks fail closed.
func (s *trafficStore) inventory() ([]string, int64, error) {
	if checkTrafficDirectory(s.dir) != nil {
		return nil, 0, ErrTraffic
	}
	dir, err := os.Open(s.dir)
	if err != nil {
		return nil, 0, ErrTraffic
	}
	defer dir.Close()
	entries, err := dir.ReadDir(maxTrafficProducers*2 + maxTrafficTemps + 1)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, 0, ErrTraffic
	}
	if len(entries) > maxTrafficProducers*2+maxTrafficTemps {
		return nil, 0, ErrTraffic
	}
	manifests, snapshots := make(map[string]bool), make(map[string]bool)
	var total int64
	temps := 0
	for _, entry := range entries {
		name := entry.Name()
		info, err := lstatTrafficFile(filepath.Join(s.dir, name), !strings.HasSuffix(name, ".tmp"))
		// A transient atomic writer may already have renamed its scratch file.
		if errors.Is(err, os.ErrNotExist) && strings.HasSuffix(name, ".tmp") {
			continue
		}
		if err != nil || !info.Mode().IsRegular() || info.Size() > maxTrafficFileBytes || (runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0) {
			return nil, 0, ErrTraffic
		}
		total += info.Size()
		if total > maxTrafficSpoolBytes {
			return nil, 0, ErrTraffic
		}
		switch {
		case strings.HasSuffix(name, trafficManifestSuffix):
			id := strings.TrimSuffix(name, trafficManifestSuffix)
			if !trafficHex(id, 32) {
				return nil, 0, ErrTraffic
			}
			manifests[id] = true
		case strings.HasSuffix(name, trafficSnapshotSuffix):
			id := strings.TrimSuffix(name, trafficSnapshotSuffix)
			if !trafficHex(id, 32) {
				return nil, 0, ErrTraffic
			}
			snapshots[id] = true
		case strings.HasSuffix(name, ".tmp"):
			temps++
			if temps > maxTrafficTemps {
				return nil, 0, ErrTraffic
			}
		default:
			return nil, 0, ErrTraffic
		}
	}
	if len(manifests) > maxTrafficProducers {
		return nil, 0, ErrTraffic
	}
	for id := range snapshots {
		if !manifests[id] {
			return nil, 0, ErrTraffic
		}
	}
	ids := make([]string, 0, len(manifests))
	for id := range manifests {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids, total, nil
}

// Open pins one complete atomic snapshot without following a leaf symlink.
// Validate BOTH the path's Lstat and the opened handle; comparing a stale
// path-derived inode with an opened inode would incorrectly reject a rename.
func readTrafficFile(path string) ([]byte, error) {
	if checkTrafficDirectory(filepath.Dir(path)) != nil {
		return nil, ErrTraffic
	}
	for attempt := 0; attempt < 8; attempt++ {
		info, err := lstatTrafficFile(path, true)
		if err != nil {
			if retryTrafficRead(err) {
				time.Sleep(5 * time.Millisecond)
				continue
			}
			return nil, err
		}
		if !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > maxTrafficFileBytes || (runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0) {
			return nil, ErrTraffic
		}
		f, err := openTrafficFile(path)
		if err != nil {
			if retryTrafficRead(err) {
				time.Sleep(5 * time.Millisecond)
				continue
			}
			return nil, ErrTraffic
		}
		opened, statErr := f.Stat()
		if statErr != nil {
			_ = f.Close()
			if retryTrafficRead(statErr) {
				time.Sleep(5 * time.Millisecond)
				continue
			}
			return nil, ErrTraffic
		}
		if !opened.Mode().IsRegular() || opened.Size() <= 0 || opened.Size() > maxTrafficFileBytes || (runtime.GOOS != "windows" && opened.Mode().Perm()&0o077 != 0) {
			_ = f.Close()
			return nil, ErrTraffic
		}
		data, readErr := io.ReadAll(io.LimitReader(f, maxTrafficFileBytes+1))
		closeErr := f.Close()
		if readErr != nil || closeErr != nil || len(data) == 0 || len(data) > maxTrafficFileBytes {
			return nil, ErrTraffic
		}
		return data, nil
	}
	return nil, ErrTraffic
}

func retryTrafficRead(err error) bool {
	return runtime.GOOS == "windows" && (errors.Is(err, syscall.Errno(5)) || errors.Is(err, syscall.Errno(32)) || errors.Is(err, syscall.Errno(33)))
}

func lstatTrafficFile(path string, retryMissing bool) (os.FileInfo, error) {
	var info os.FileInfo
	var err error
	for attempt := 0; attempt < 8; attempt++ {
		info, err = os.Lstat(path)
		if !retryTrafficRead(err) && !(runtime.GOOS == "windows" && retryMissing && errors.Is(err, os.ErrNotExist)) {
			return info, err
		}
		time.Sleep(5 * time.Millisecond)
	}
	return info, err
}

// Go's decoder otherwise accepts duplicate keys and silently applies the last
// value. Reject duplicates at every depth, unknown fields, and trailing JSON.
func decodeTrafficJSON(data []byte, out any) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	var walk func(int) error
	walk = func(depth int) error {
		if depth > 32 {
			return ErrTraffic
		}
		token, err := dec.Token()
		if err != nil {
			return ErrTraffic
		}
		if delim, ok := token.(json.Delim); ok {
			switch delim {
			case '{':
				seen := make(map[string]bool)
				for dec.More() {
					key, err := dec.Token()
					name, ok := key.(string)
					if err != nil || !ok || seen[name] {
						return ErrTraffic
					}
					seen[name] = true
					if err := walk(depth + 1); err != nil {
						return err
					}
				}
			case '[':
				for dec.More() {
					if err := walk(depth + 1); err != nil {
						return err
					}
				}
			default:
				return ErrTraffic
			}
			if _, err := dec.Token(); err != nil {
				return ErrTraffic
			}
		}
		return nil
	}
	if walk(0) != nil {
		return ErrTraffic
	}
	if _, err := dec.Token(); err != io.EOF {
		return ErrTraffic
	}
	dec = json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if dec.Decode(out) != nil {
		return ErrTraffic
	}
	return nil
}

func (m *Manager) trafficAAD(producer string) []byte {
	return []byte("tunex-linkrunner-traffic-v1\x00" + m.cache.agentID + "\x00" + producer)
}

func (m *Manager) writeTrafficManifestLocked(manifest trafficManifest) error {
	if !trafficHex(manifest.ProducerID, 32) || checkTrafficDirectory(m.traffic.dir) != nil {
		return ErrTraffic
	}
	plain, err := json.Marshal(manifest)
	if err != nil || len(plain) > maxTrafficFileBytes {
		return ErrTraffic
	}
	nonce := make([]byte, m.cache.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return ErrTraffic
	}
	data, err := json.Marshal(trafficEnvelope{1, nonce, m.cache.aead.Seal(nil, nonce, plain, m.trafficAAD(manifest.ProducerID))})
	if err != nil || len(data) > maxTrafficFileBytes {
		return ErrTraffic
	}
	if atomicPrivateWrite(m.traffic.path(manifest.ProducerID, trafficManifestSuffix), data) != nil {
		return ErrTraffic
	}
	return nil
}

func (m *Manager) readTrafficManifestLocked(producer string) (trafficManifest, error) {
	var manifest trafficManifest
	data, err := readTrafficFile(m.traffic.path(producer, trafficManifestSuffix))
	if err != nil {
		return manifest, ErrTraffic
	}
	var envelope trafficEnvelope
	if decodeTrafficJSON(data, &envelope) != nil || envelope.Version != 1 || len(envelope.Nonce) != m.cache.aead.NonceSize() {
		return manifest, ErrTraffic
	}
	plain, err := m.cache.aead.Open(nil, envelope.Nonce, envelope.Sealed, m.trafficAAD(producer))
	if err != nil || decodeTrafficJSON(plain, &manifest) != nil {
		return manifest, ErrTraffic
	}
	if (manifest.Version != 1 && manifest.Version != 2) || manifest.ProducerID != producer || !trafficHex(producer, 32) || manifest.Role != "ingress" || !safeTrafficInt(manifest.LinkID) || !safeTrafficInt(manifest.WorkspaceID) || !safeTrafficInt(manifest.NodeID) || len(manifest.Rules) == 0 || len(manifest.Rules) > maxTrafficSamples || manifest.Last == nil {
		return manifest, ErrTraffic
	}
	if manifest.PreparedFrom != "" && (manifest.Version != 2 || !trafficHex(manifest.PreparedFrom, 32) || manifest.PreparedFrom == producer || len(manifest.Last) != 0 || manifest.Discard) {
		return manifest, ErrTraffic
	}
	r, exists := m.records[manifest.PlacementID]
	if !exists || r.Role != manifest.Role || r.LinkID != manifest.LinkID || r.WorkspaceID != manifest.WorkspaceID || r.NodeID != manifest.NodeID || (m.cache.nodeDBID != 0 && m.cache.nodeDBID != manifest.NodeID) {
		return manifest, ErrTraffic
	}
	rules := make(map[int64]bool, len(manifest.Rules))
	for _, rule := range manifest.Rules {
		if !safeTrafficInt(rule.ForwardID) || !safeTrafficInt(rule.Generation) || rule.Generation > r.Highest || !trafficHex(rule.ConfigDigest, 64) || rules[rule.ForwardID] {
			return manifest, ErrTraffic
		}
		rules[rule.ForwardID] = true
	}
	if validateTrafficCounters(manifest.Last, rules) != nil {
		return manifest, ErrTraffic
	}
	return manifest, nil
}

func (m *Manager) scanTrafficLocked() ([]trafficProducer, error) {
	ids, _, err := m.traffic.inventory()
	if err != nil {
		return nil, ErrTraffic
	}
	producers := make([]trafficProducer, 0, len(ids))
	for _, id := range ids {
		manifest, err := m.readTrafficManifestLocked(id)
		if err != nil {
			return nil, ErrTraffic
		}
		data, err := readTrafficFile(m.traffic.path(id, trafficSnapshotSuffix))
		if errors.Is(err, os.ErrNotExist) && manifest.Discard && !m.trafficActiveLocked(id) {
			producers = append(producers, trafficProducer{manifest: manifest})
			continue
		}
		if errors.Is(err, os.ErrNotExist) && manifest.PreparedFrom != "" && !m.trafficActiveLocked(id) {
			producers = append(producers, trafficProducer{manifest: manifest})
			continue
		}
		if err != nil {
			return nil, ErrTraffic
		}
		var snapshot trafficSnapshot
		if decodeTrafficJSON(data, &snapshot) != nil || !trafficSnapshotVersion(manifest.Version, snapshot.Version) || snapshot.ProducerID != id || snapshot.Samples == nil {
			return nil, ErrTraffic
		}
		rules := make(map[int64]bool, len(manifest.Rules))
		for _, rule := range manifest.Rules {
			rules[rule.ForwardID] = true
		}
		if validateTrafficCounters(snapshot.Samples, rules) != nil {
			return nil, ErrTraffic
		}
		current := make(map[trafficKey]trafficCounter, len(snapshot.Samples))
		for _, c := range snapshot.Samples {
			current[trafficKey{forward: c.ForwardID, date: c.Date}] = c
		}
		for _, previous := range manifest.Last {
			counter, ok := current[trafficKey{forward: previous.ForwardID, date: previous.Date}]
			if !ok || !trafficCounterLE(previous, counter) {
				return nil, ErrTraffic
			}
		}
		if manifest.Discard && (m.trafficActiveLocked(id) || !reflect.DeepEqual(manifest.Last, snapshot.Samples)) {
			return nil, ErrTraffic
		}
		producers = append(producers, trafficProducer{manifest, snapshot})
	}
	if err := m.validatePreparedTrafficLocked(producers); err != nil {
		return nil, err
	}
	// Validate the entire inventory before checkpointing or recovering any ACK.
	result := make([]trafficProducer, 0, len(producers))
	for _, p := range producers {
		if p.manifest.PreparedFrom != "" {
			p.manifest.PreparedFrom = ""
			if p.snapshot.Version == 0 {
				p.manifest.Discard = true
			}
			if err := m.writeTrafficManifestLocked(p.manifest); err != nil {
				return nil, err
			}
		}
		if p.manifest.Discard {
			if err := m.finishTrafficDeletionLocked(p.manifest.ProducerID); err != nil {
				return nil, err
			}
			continue
		}
		if !reflect.DeepEqual(p.manifest.Last, p.snapshot.Samples) {
			p.manifest.Last = p.snapshot.Samples
			if err := m.writeTrafficManifestLocked(p.manifest); err != nil {
				return nil, err
			}
		}
		result = append(result, p)
	}
	m.updateTrafficStatsLocked(result)
	return result, nil
}

func (m *Manager) finishTrafficDeletionLocked(producer string) error {
	if !trafficHex(producer, 32) || m.trafficActiveLocked(producer) || checkTrafficDirectory(m.traffic.dir) != nil {
		return ErrTraffic
	}
	manifest, err := m.readTrafficManifestLocked(producer)
	if err != nil || !manifest.Discard {
		return ErrTraffic
	}
	data, err := readTrafficFile(m.traffic.path(producer, trafficSnapshotSuffix))
	if err == nil {
		var snapshot trafficSnapshot
		rules := make(map[int64]bool, len(manifest.Rules))
		for _, rule := range manifest.Rules {
			rules[rule.ForwardID] = true
		}
		if decodeTrafficJSON(data, &snapshot) != nil || !trafficSnapshotVersion(manifest.Version, snapshot.Version) || snapshot.ProducerID != producer || snapshot.Samples == nil || validateTrafficCounters(snapshot.Samples, rules) != nil || !reflect.DeepEqual(snapshot.Samples, manifest.Last) {
			return ErrTraffic
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return ErrTraffic
	}
	for _, suffix := range []string{trafficSnapshotSuffix, trafficManifestSuffix} {
		path := m.traffic.path(producer, suffix)
		info, err := os.Lstat(path)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil || !info.Mode().IsRegular() || os.Remove(path) != nil {
			return ErrTraffic
		}
		// Ensure the snapshot unlink reaches disk before the manifest unlink;
		// otherwise a crash could leave an unbound, unexplained snapshot.
		if runtime.GOOS != "windows" {
			d, err := os.Open(m.traffic.dir)
			if err != nil {
				return ErrTraffic
			}
			syncErr, closeErr := d.Sync(), d.Close()
			if syncErr != nil || closeErr != nil {
				return ErrTraffic
			}
		}
	}
	return nil
}

func validateTrafficCounters(counters []trafficCounter, rules map[int64]bool) error {
	if len(counters) > maxTrafficSamples {
		return ErrTraffic
	}
	seen := make(map[trafficKey]bool, len(counters))
	for _, c := range counters {
		key := trafficKey{forward: c.ForwardID, date: c.Date}
		if !validTrafficCounter(c) || !rules[c.ForwardID] || seen[key] {
			return ErrTraffic
		}
		seen[key] = true
	}
	sort.Slice(counters, func(i, j int) bool {
		if counters[i].ForwardID != counters[j].ForwardID {
			return counters[i].ForwardID < counters[j].ForwardID
		}
		return counters[i].Date < counters[j].Date
	})
	return nil
}

func safeTrafficInt(n int64) bool { return n > 0 && n <= maxTrafficSafe }
func trafficHex(s string, size int) bool {
	if len(s) != size {
		return false
	}
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

func trafficDecimal(s string) (uint64, bool) {
	if len(s) == 0 || len(s) > 16 || len(s) > 1 && s[0] == '0' {
		return 0, false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0, false
		}
	}
	n, err := strconv.ParseUint(s, 10, 64)
	return n, err == nil && n <= uint64(maxTrafficSafe)
}

func validTrafficCounter(c trafficCounter) bool {
	if !safeTrafficInt(c.ForwardID) || len(c.Date) != 10 {
		return false
	}
	date, err := time.Parse("2006-01-02", c.Date)
	if err != nil || date.Format("2006-01-02") != c.Date {
		return false
	}
	for _, s := range []string{c.BytesIn, c.BytesOut, c.Connections} {
		if _, ok := trafficDecimal(s); !ok {
			return false
		}
	}
	in, _ := trafficDecimal(c.BytesIn)
	out, _ := trafficDecimal(c.BytesOut)
	if in+out > uint64(maxTrafficSafe) {
		return false
	}
	return true
}

func validTrafficSample(s TrafficSample) bool {
	return trafficHex(s.ProducerID, 32) && safeTrafficInt(s.LinkID) && safeTrafficInt(s.WorkspaceID) && safeTrafficInt(s.NodeID) && safeTrafficInt(s.Generation) && trafficHex(s.ConfigDigest, 64) && validTrafficCounter(s.counter())
}

func trafficCounterLE(a, b trafficCounter) bool {
	for _, pair := range [][2]string{{a.BytesIn, b.BytesIn}, {a.BytesOut, b.BytesOut}, {a.Connections, b.Connections}} {
		an, aok := trafficDecimal(pair[0])
		bn, bok := trafficDecimal(pair[1])
		if !aok || !bok || an > bn {
			return false
		}
	}
	return true
}
