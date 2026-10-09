package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const managedTrafficMaxSamples = 2048
const managedTrafficMaxValue = uint64(1<<53 - 1)
const managedTrafficInterval = time.Second

var managedTrafficSink atomic.Pointer[managedTraffic]
var managedProducerPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)
var managedTrafficZone = time.FixedZone("Asia/Shanghai", 8*60*60)

type managedTrafficSample struct {
	ForwardID   int    `json:"forward_id"`
	Date        string `json:"date"`
	BytesIn     string `json:"bytes_in"`
	BytesOut    string `json:"bytes_out"`
	Connections string `json:"connections"`
}

type managedTrafficSnapshot struct {
	Version    int                    `json:"version"`
	ProducerID string                 `json:"producer_id"`
	Samples    []managedTrafficSample `json:"samples"`
}

type managedTrafficKey struct {
	rule int
	date string
}

// FXP receives no panel credential. The Agent owns authenticated delivery and
// binds this private cumulative payload spool to a deployment manifest.
type managedTraffic struct {
	mu           sync.Mutex
	path         string
	producer     string
	version      int
	rotationPath string
	values       map[managedTrafficKey]trafficBatchValue
	dirty        bool
	done         chan struct{}
	stopped      chan struct{}
	stopOnce     sync.Once
	failed       func()
}

func newManagedTraffic(path, producer string) (*managedTraffic, error) {
	return newManagedTrafficVersion(path, producer, 1)
}

func newManagedTrafficVersion(path, producer string, version int) (*managedTraffic, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path || !managedProducerPattern.MatchString(producer) {
		return nil, errors.New("invalid managed traffic destination")
	}
	for p := filepath.Dir(path); ; p = filepath.Dir(p) {
		info, err := os.Lstat(p)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return nil, errors.New("invalid managed traffic directory")
		}
		if p == filepath.Dir(path) && runtime.GOOS != "windows" && info.Mode().Perm()&0077 != 0 {
			return nil, errors.New("managed traffic directory is not private")
		}
		if filepath.Dir(p) == p {
			break
		}
	}
	if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
		return nil, errors.New("managed traffic destination already exists")
	}
	s := &managedTraffic{path: path, producer: producer, version: version, values: make(map[managedTrafficKey]trafficBatchValue), dirty: true,
		done: make(chan struct{}), stopped: make(chan struct{}), failed: func() { os.Exit(1) }}
	if err := s.flush(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *managedTraffic) record(cfg config, bytesIn, bytesOut, connections uint64, now time.Time) error {
	if strings.ToLower(cfg.Role) != "entry" || cfg.RuleID <= 0 {
		return errors.New("invalid managed traffic rule")
	}
	if bytesIn == 0 && bytesOut == 0 && connections == 0 {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	key := managedTrafficKey{cfg.RuleID, now.In(managedTrafficZone).Format("2006-01-02")}
	value, exists := s.values[key]
	if !exists && len(s.values) >= managedTrafficMaxSamples {
		return errors.New("managed traffic capacity exhausted")
	}
	remaining := managedTrafficMaxValue - value.bytesIn - value.bytesOut
	if bytesIn > remaining || bytesOut > remaining-bytesIn || connections > managedTrafficMaxValue-value.connections {
		return errors.New("managed traffic counter exhausted")
	}
	value.bytesIn += bytesIn
	value.bytesOut += bytesOut
	value.connections += connections
	s.values[key], s.dirty = value, true
	return nil
}

func (s *managedTraffic) flush() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.flushLocked()
}

func (s *managedTraffic) flushLocked() error {
	if !s.dirty {
		return nil
	}
	keys := make([]managedTrafficKey, 0, len(s.values))
	for key := range s.values {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].date != keys[j].date {
			return keys[i].date < keys[j].date
		}
		return keys[i].rule < keys[j].rule
	})
	snapshot := managedTrafficSnapshot{Version: s.version, ProducerID: s.producer, Samples: make([]managedTrafficSample, 0, len(keys))}
	for _, key := range keys {
		value := s.values[key]
		snapshot.Samples = append(snapshot.Samples, managedTrafficSample{ForwardID: key.rule, Date: key.date,
			BytesIn: strconv.FormatUint(value.bytesIn, 10), BytesOut: strconv.FormatUint(value.bytesOut, 10), Connections: strconv.FormatUint(value.connections, 10)})
	}
	body, err := json.Marshal(snapshot)
	if err != nil || len(body) > 1<<20 {
		return errors.New("managed traffic snapshot too large")
	}
	if info, err := os.Lstat(s.path); err == nil && (!info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 ||
		(runtime.GOOS != "windows" && info.Mode().Perm()&0077 != 0)) {
		return errors.New("invalid managed traffic snapshot")
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return errors.New("managed traffic snapshot unavailable")
	}
	f, err := os.CreateTemp(filepath.Dir(s.path), ".traffic-*.tmp")
	if err != nil {
		return errors.New("managed traffic storage unavailable")
	}
	defer os.Remove(f.Name())
	if f.Chmod(0600) != nil {
		f.Close()
		return errors.New("managed traffic storage is not private")
	}
	_, writeErr := f.Write(body)
	syncErr, closeErr := f.Sync(), f.Close()
	if writeErr != nil || syncErr != nil || closeErr != nil {
		return errors.New("managed traffic write failed")
	}
	// Never unlink the old durable snapshot to make room for a replacement.
	deadline := time.Now().Add(500 * time.Millisecond)
	for {
		err = os.Rename(f.Name(), s.path)
		if err == nil {
			break
		}
		if runtime.GOOS != "windows" || !time.Now().Before(deadline) {
			return errors.New("managed traffic replacement failed")
		}
		time.Sleep(5 * time.Millisecond)
	}
	// File.Sync alone does not persist the replacement directory entry after
	// a power loss. Windows cannot fsync a directory through os.File.Sync.
	if runtime.GOOS != "windows" {
		dir, openErr := os.Open(filepath.Dir(s.path))
		if openErr != nil {
			return errors.New("managed traffic directory sync failed")
		}
		syncErr, closeErr := dir.Sync(), dir.Close()
		if syncErr != nil || closeErr != nil {
			return errors.New("managed traffic directory sync failed")
		}
	}
	s.dirty = false
	return nil
}

func (s *managedTraffic) run() {
	go func() {
		defer close(s.stopped)
		ticker := time.NewTicker(managedTrafficInterval)
		defer ticker.Stop()
		var rotation <-chan time.Time
		if s.rotationPath != "" {
			poll := time.NewTicker(100 * time.Millisecond)
			defer poll.Stop()
			rotation = poll.C
		}
		for {
			select {
			case <-ticker.C:
				if s.flush() != nil {
					s.failed()
					return
				}
			case <-s.done:
				return
			case <-rotation:
				if s.rotateFromControl() != nil {
					s.failed()
					return
				}
			}
		}
	}()
}

func (s *managedTraffic) close() error {
	s.stopOnce.Do(func() { close(s.done) })
	<-s.stopped
	return s.flush()
}
