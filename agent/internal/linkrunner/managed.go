package linkrunner

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"time"
)

func managedObject(raw json.RawMessage) map[string]any {
	var v map[string]any
	if json.Unmarshal(raw, &v) != nil || v["managedReload"] != true {
		return nil
	}
	return v
}
func managedConfig(raw json.RawMessage) bool { return managedObject(raw) != nil }

// The runtime independently validates normalized configs. This conservative
// classifier permits bindings/policies only; transport changes take stop/start.
func managedCompatible(oldRaw, nextRaw json.RawMessage) bool {
	a, b := managedObject(oldRaw), managedObject(nextRaw)
	if a == nil || b == nil || a["role"] != b["role"] {
		return false
	}
	if a["role"] == "exit" {
		for _, k := range []string{"allowedBindings", "udpTargets"} {
			delete(a, k)
			delete(b, k)
		}
		return reflect.DeepEqual(a, b)
	}
	if a["role"] != "entry-group" {
		return false
	}
	oldEntries, okA := a["entries"].([]any)
	newEntries, okB := b["entries"].([]any)
	if !okA || !okB || len(oldEntries) == 0 || len(newEntries) == 0 {
		return false
	}
	byID := map[any]map[string]any{}
	for _, v := range oldEntries {
		entry, ok := v.(map[string]any)
		if !ok {
			return false
		}
		byID[entry["ruleId"]] = entry
	}
	carrierKey := oldEntries[0].(map[string]any)["key"]
	for _, v := range newEntries {
		next, ok := v.(map[string]any)
		if !ok || next["key"] != carrierKey {
			return false
		}
		if old := byID[next["ruleId"]]; old != nil {
			for _, key := range []string{"key", "tunnelId", "ruleId", "listenHost", "protocol", "exitHost", "exitPort", "udpExitPort", "exits"} {
				if !reflect.DeepEqual(old[key], next[key]) {
					return false
				}
			}
		}
	}
	delete(a, "entries")
	delete(b, "entries")
	return reflect.DeepEqual(a, b)
}

func (p *child) expectReload(digest string) uint64 {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.pendingDigest = digest
	return p.ackSequence
}

func (p *child) waitApplied(digest string, after uint64) error {
	timer := time.NewTimer(startupTimeout)
	defer timer.Stop()
	for {
		p.mu.Lock()
		kind, matched, tampered := p.ackKind, p.ackSequence > after && p.ackDigest == digest, p.tampered
		p.mu.Unlock()
		if tampered {
			return ErrConfigTampered
		}
		if !p.live() {
			return p.failure()
		}
		if matched {
			if kind == "applied" {
				return nil
			}
			return ErrReloadRejected
		}
		select {
		case <-p.ackChanged:
		case <-p.done:
			return p.failure()
		case <-timer.C:
			return ErrReloadTimeout
		}
	}
}

func (p *child) commitReload(digest string) {
	p.mu.Lock()
	p.currentDigest = digest
	p.pendingDigest = ""
	p.mu.Unlock()
}

func (p *child) verifyFile(digest string) bool {
	info, err := os.Lstat(p.path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxConfigBytes {
		return false
	}
	data, err := os.ReadFile(p.path)
	if err != nil {
		return false
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]) == digest
}

// Generation is already durable and external reservations cover old+candidate.
// Only a fresh runtime ACK permits committing a new encrypted restore config.
func (m *Manager) reloadLocked(r record, cfg Config, deadline time.Time, p *child) (Observation, error) {
	old := r.Config
	r.UpdateMode = "managed_reload"
	var reloadErr error
	if cfg.ConfigDigest == old.ConfigDigest {
		if !p.verifyFile(cfg.ConfigDigest) {
			reloadErr = ErrConfigTampered
		}
	} else {
		after := p.expectReload(cfg.ConfigDigest)
		if err := atomicPrivateWrite(p.path, cfg.RunnerConfig); err != nil {
			reloadErr = err
		} else {
			reloadErr = p.waitApplied(cfg.ConfigDigest, after)
		}
	}
	if reloadErr == nil && !p.verifyFile(cfg.ConfigDigest) {
		reloadErr = ErrConfigTampered
	}
	if reloadErr == nil && p.renew(deadline) {
		p.commitReload(cfg.ConfigDigest)
		r.Config = &cfg
		r.State = "ready"
		r.LastError = ""
		if err := m.saveRecordLocked(r); err != nil {
			return m.observeLocked(cfg.ID), err
		}
		if !p.live() {
			return m.observeLocked(cfg.ID), p.failure()
		}
		return m.observeLocked(cfg.ID), nil
	}
	if reloadErr == nil {
		reloadErr = p.failure()
	}
	r.State = "failed"
	r.LastError = reloadErr.Error()
	// A rejection acknowledges that compensation completed. Rewriting the old
	// bytes still needs a fresh ACK, so neither a stale marker nor exec.Start can
	// prove rollback. An ambiguous timeout or tamper always stops the carrier.
	if errors.Is(reloadErr, ErrReloadRejected) && p.live() {
		after := p.expectReload(old.ConfigDigest)
		if err := atomicPrivateWrite(p.path, old.RunnerConfig); err == nil {
			if err = p.waitApplied(old.ConfigDigest, after); err == nil && p.verifyFile(old.ConfigDigest) {
				p.commitReload(old.ConfigDigest)
				r.State = "rolled_back"
			} else {
				reloadErr = errors.Join(reloadErr, err)
			}
		} else {
			reloadErr = errors.Join(reloadErr, err)
		}
	}
	if r.State != "rolled_back" {
		reloadErr = errors.Join(reloadErr, m.stopLocked(cfg.ID))
	}
	if err := m.saveRecordLocked(r); err != nil {
		reloadErr = errors.Join(reloadErr, err)
	}
	return m.observeLocked(cfg.ID), reloadErr
}
