package main

import "time"

// Retain closed sessions over the existing idle/stalled lifetime, including
// policy generations. A full cache rejects new identities rather than evicting
// live replay history. History is process-local and expires after ten minutes.
const managedUDPWireLimit = 4 * fxpUDPMaxSessions

type managedUDPWireKey struct {
	rule int
	sid  uint64
}
type managedUDPWireState struct {
	active                  *udpDirectExitSession
	expires                 time.Time
	sequence, highest, seen uint64
	initialized             bool
	data, reply             *fxpUDPCodec
}

func (s *managedExitState) attachUDPWire(session *udpDirectExitSession, now time.Time) bool {
	s.wireMu.Lock()
	defer s.wireMu.Unlock()
	if s.wires == nil {
		s.wires = make(map[managedUDPWireKey]*managedUDPWireState)
	}
	key := managedUDPWireKey{session.ruleID, session.sessionID}
	state := s.wires[key]
	if state != nil && state.active == nil && !now.Before(state.expires) {
		delete(s.wires, key)
		state = nil
	}
	if state != nil && state.active != nil {
		return false
	}
	if state == nil {
		if len(s.wires) >= managedUDPWireLimit {
			for key, value := range s.wires {
				if value.active == nil && !now.Before(value.expires) {
					delete(s.wires, key)
				}
			}
		}
		if len(s.wires) >= managedUDPWireLimit {
			return false
		}
		state = &managedUDPWireState{data: session.dataOpener, reply: session.returnSealer}
		s.wires[key] = state
	} else {
		session.dataOpener, session.returnSealer = state.data, state.reply
		session.dataReplay.initialized, session.dataReplay.highest, session.dataReplay.seen = state.initialized, state.highest, state.seen
		if state.sequence > session.sendSequence.Load() {
			session.sendSequence.Store(state.sequence)
		}
	}
	state.active = session
	session.wireOwner = s
	return true
}

// close holds wireDataMu and targetMu: accepted data and managed return seals
// have completed before this snapshot, including the last allocated nonce.
func (s *managedExitState) rememberUDPWire(session *udpDirectExitSession, now time.Time) {
	s.wireMu.Lock()
	defer s.wireMu.Unlock()
	state := s.wires[managedUDPWireKey{session.ruleID, session.sessionID}]
	if state == nil || state.active != session {
		return
	}
	state.sequence = session.sendSequence.Load()
	session.dataReplay.mu.Lock()
	state.initialized, state.highest, state.seen = session.dataReplay.initialized, session.dataReplay.highest, session.dataReplay.seen
	session.dataReplay.mu.Unlock()
	state.active, state.expires = nil, now.Add(fxpUDPStalledTimeout)
}

func (s *udpDirectExitSession) acceptExitData(packet fxpUDPPacket) ([]byte, bool) {
	if s.wireOwner != nil {
		s.wireOwner.mu.RLock()
		defer s.wireOwner.mu.RUnlock()
		policy := s.wireOwner.policy.Load()
		if s.managedPool != nil {
			if policy.pools[s.ruleID] != s.managedPool {
				return nil, false
			}
		} else {
			target, ok := policy.targets[s.ruleID]
			if !ok || policy.pools[s.ruleID] != nil || target.TargetIP != s.targetIP || target.TargetPort != s.targetPort {
				return nil, false
			}
		}
	}
	s.wireDataMu.Lock()
	defer s.wireDataMu.Unlock()
	select {
	case <-s.done:
		return nil, false
	default:
	}
	return s.dataFragments.accept(packet, &s.dataReplay)
}
