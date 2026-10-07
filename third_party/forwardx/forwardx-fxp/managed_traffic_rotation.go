package main

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
)

// v2 is a live cumulative epoch, v3 its immutable final snapshot. Rotation
// changes accounting identity only: listeners, counters, gates and sessions
// remain alive. Old totals are reclaimed exclusively by the Agent's exact ACK.
type managedTrafficRotation struct {
	Version        int    `json:"version"`
	ProducerID     string `json:"producer_id"`
	NextProducerID string `json:"next_producer_id"`
}

func privateManagedDirectory(dir string) error {
	if !filepath.IsAbs(dir) || filepath.Clean(dir) != dir {
		return errors.New("invalid managed traffic directory")
	}
	for p := dir; ; p = filepath.Dir(p) {
		info, err := os.Lstat(p)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return errors.New("invalid managed traffic directory")
		}
		if p == dir && runtime.GOOS != "windows" && info.Mode().Perm()&0077 != 0 {
			return errors.New("managed traffic directory is not private")
		}
		if filepath.Dir(p) == p {
			return nil
		}
	}
}

func (s *managedTraffic) enableRotation(path string) error {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path || privateManagedDirectory(filepath.Dir(path)) != nil ||
		filepath.Base(s.path) != s.producer+".snapshot.json" {
		return errors.New("invalid managed traffic rotation destination")
	}
	s.rotationPath, s.version, s.dirty = path, 2, true
	return s.flush()
}

func readManagedRotation(path string) (managedTrafficRotation, error) {
	var req managedTrafficRotation
	if privateManagedDirectory(filepath.Dir(path)) != nil {
		return req, errors.New("invalid managed traffic control directory")
	}
	f, err := openManagedTrafficControl(path)
	if err != nil {
		return req, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() > 512 ||
		(runtime.GOOS != "windows" && info.Mode().Perm()&0077 != 0) {
		return req, errors.New("invalid managed traffic control")
	}
	dec := json.NewDecoder(io.LimitReader(f, 513))
	first, err := dec.Token()
	if err != nil || first != json.Delim('{') {
		return req, errors.New("invalid managed traffic control")
	}
	seen := map[string]bool{}
	for dec.More() {
		token, err := dec.Token()
		key, ok := token.(string)
		if err != nil || !ok || seen[key] {
			return req, errors.New("invalid managed traffic control")
		}
		seen[key] = true
		switch key {
		case "version":
			err = dec.Decode(&req.Version)
		case "producer_id":
			err = dec.Decode(&req.ProducerID)
		case "next_producer_id":
			err = dec.Decode(&req.NextProducerID)
		default:
			return req, errors.New("invalid managed traffic control")
		}
		if err != nil {
			return req, errors.New("invalid managed traffic control")
		}
	}
	last, err := dec.Token()
	if err != nil || last != json.Delim('}') || len(seen) != 3 {
		return req, errors.New("invalid managed traffic control")
	}
	if _, err = dec.Token(); err != io.EOF {
		return req, errors.New("invalid managed traffic control")
	}
	if req.Version != 1 || !managedProducerPattern.MatchString(req.ProducerID) || !managedProducerPattern.MatchString(req.NextProducerID) || req.ProducerID == req.NextProducerID {
		return req, errors.New("invalid managed traffic control")
	}
	return req, nil
}

func (s *managedTraffic) rotateFromControl() error {
	req, err := readManagedRotation(s.rotationPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	return s.rotate(req)
}

func (s *managedTraffic) rotate(req managedTrafficRotation) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.rotationPath == "" || req.Version != 1 || !managedProducerPattern.MatchString(req.ProducerID) ||
		!managedProducerPattern.MatchString(req.NextProducerID) || req.ProducerID == req.NextProducerID {
		return errors.New("invalid managed traffic rotation")
	}
	if req.NextProducerID == s.producer {
		return nil
	} // A repeated successful request never resets totals.
	if req.ProducerID != s.producer {
		return errors.New("foreign managed traffic rotation")
	}
	nextPath := filepath.Join(filepath.Dir(s.path), req.NextProducerID+".snapshot.json")
	// Persist the empty destination before sealing the old totals. A crash at
	// either write leaves explainable, bound files, never unreported counters.
	next, err := newManagedTrafficVersion(nextPath, req.NextProducerID, 2)
	if err != nil {
		return err
	}
	s.version, s.dirty = 3, true
	if err = s.flushLocked(); err != nil {
		return err
	}
	// record uses this same mutex; no sample can enter the sealed epoch after
	// its final durable write. Later deltas join the new identity without reset.
	s.path, s.producer, s.version = next.path, next.producer, 2
	s.values, s.dirty = next.values, false
	return nil
}
