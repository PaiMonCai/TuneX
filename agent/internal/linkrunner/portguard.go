package linkrunner

import (
	"errors"
	"sync"

	"github.com/tunex/agent/internal/portlease"
)

// PortGuard is the TunnelManager's shared native/external socket registry.
// ReserveExternal atomically replaces this owner's claims, excluding that owner
// from conflict checks; it must leave prior claims intact on error.
type PortGuard interface {
	ReserveExternal(owner string, bindings []portlease.Binding) error
	ReleaseExternal(owner string)
}

type externalSlot struct {
	pending bool
	current *child
}
type externalReservations struct {
	sync.Mutex
	guard PortGuard
	slots map[string]*externalSlot
}

func (m *Manager) SetPortGuard(guard PortGuard) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return ErrClosed
	}
	if len(m.running) != 0 {
		return ErrPortConflict
	}
	m.external.Lock()
	defer m.external.Unlock()
	if len(m.external.slots) != 0 {
		return ErrPortConflict
	}
	m.external.guard = guard
	m.external.slots = make(map[string]*externalSlot)
	return nil
}

func slotOwner(id string) string { return "fxp:" + id }

func bindingsFor(ports []Port) []portlease.Binding {
	bindings := make([]portlease.Binding, 0, len(ports))
	seen := make(map[portlease.Binding]bool)
	for _, p := range ports {
		b := portlease.New(p.Protocol, p.Port, p.Host)
		if !seen[b] {
			bindings = append(bindings, b)
			seen[b] = true
		}
	}
	return bindings
}

// Keep both old rollback and candidate ports claimed across the restart gap.
func (m *Manager) reserveSlotsLocked(id string, ports []Port) error {
	m.external.Lock()
	defer m.external.Unlock()
	if m.external.guard == nil {
		return nil
	}
	slot := m.external.slots[id]
	if slot == nil {
		slot = &externalSlot{current: m.running[id]}
		m.external.slots[id] = slot
	}
	slot.pending = true
	if err := m.external.guard.ReserveExternal(slotOwner(id), bindingsFor(ports)); err != nil {
		slot.pending = false
		if slot.current == nil || childDone(slot.current) {
			m.external.guard.ReleaseExternal(slotOwner(id))
			delete(m.external.slots, id)
		}
		return ErrPortConflict // The guard's arbitrary error text never reaches logs.
	}
	return nil
}

func (m *Manager) finishSlotsLocked(id string) error {
	m.external.Lock()
	if m.external.guard == nil {
		m.external.Unlock()
		return nil
	}
	p := m.running[id]
	r := m.records[id]
	if p != nil && (!p.live() || r.Config == nil) && !childDone(p) {
		m.external.Unlock()
		if err := m.stopLocked(id); err != nil {
			return err
		}
		m.external.Lock()
		p = m.running[id]
	}
	if p == nil || r.Config == nil || !p.live() {
		m.external.guard.ReleaseExternal(slotOwner(id))
		delete(m.external.slots, id)
		m.external.Unlock()
		return nil
	}
	if err := m.external.guard.ReserveExternal(slotOwner(id), bindingsFor(r.Config.Ports)); err != nil {
		m.external.Unlock()
		stopErr := m.stopLocked(id)
		if stopErr == nil {
			m.releaseSlotsLocked(id)
		}
		r.State = "failed"
		r.LastError = ErrPortConflict.Error()
		m.records[id] = r
		return errors.Join(ErrPortConflict, stopErr)
	}
	m.external.slots[id] = &externalSlot{current: p}
	m.external.Unlock()
	// Releases on crash/lease stop without waiting for the manager command mutex.
	go func() {
		<-p.done
		m.external.Lock()
		defer m.external.Unlock()
		if slot := m.external.slots[id]; slot != nil && !slot.pending && slot.current == p {
			m.external.guard.ReleaseExternal(slotOwner(id))
			delete(m.external.slots, id)
		}
	}()
	return nil
}

func childDone(p *child) bool {
	select {
	case <-p.done:
		return true
	default:
		return false
	}
}

func (m *Manager) releaseSlotsLocked(id string) {
	m.external.Lock()
	defer m.external.Unlock()
	if m.external.guard != nil {
		m.external.guard.ReleaseExternal(slotOwner(id))
		delete(m.external.slots, id)
	}
}
