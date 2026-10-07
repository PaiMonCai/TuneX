package main

import (
	"net"
	"time"
)

func (s *udpDirectExitSession) targetSnapshot() (*net.UDPConn, int) {
	s.targetMu.Lock()
	defer s.targetMu.Unlock()
	return s.target, s.targetIndex
}

// Rebuild the destination socket, retaining the wire session's replay and
// sequence state. A new packet may be dropped while all targets are unavailable.
func (s *udpDirectExitSession) invalidateManagedTarget(pool *managedTargetPool, index int) {
	if s.managedPool != pool {
		return
	}
	s.targetMu.Lock()
	defer s.targetMu.Unlock()
	if s.targetIndex != index {
		return
	}
	if s.target != nil {
		_ = s.target.Close()
		s.target = nil
	}
	s.targetIndex = -1
}

func (s *udpDirectExitSession) clearManagedSocket(target *net.UDPConn, unpin bool) {
	s.targetMu.Lock()
	defer s.targetMu.Unlock()
	if s.target != target {
		return
	}
	_ = target.Close()
	s.target = nil
	if unpin {
		s.targetIndex = -1
	}
}

func (s *udpDirectExitSession) writeManagedTarget(payload []byte) {
	managed := managedExitFor(s.cfg)
	if managed == nil {
		return
	}
	managed.mu.RLock()
	defer managed.mu.RUnlock()
	p := s.managedPool
	if managed.policy.Load().pools[s.ruleID] != p {
		return
	}
	s.targetMu.Lock()
	defer s.targetMu.Unlock()
	select {
	case <-s.done:
		return
	default:
	}
	if !p.available(s.targetIndex) {
		if s.target != nil {
			_ = s.target.Close()
			s.target = nil
		}
		s.targetIndex = -1
	}
	if s.target == nil {
		pinned := s.targetIndex >= 0
		attempted := make(map[int]bool)
		for len(attempted) < len(p.set.Targets) {
			index := s.targetIndex
			if index < 0 || attempted[index] {
				_, chosen, ok := p.pick("udp", attempted)
				if !ok {
					return
				}
				index = chosen
			}
			attempted[index] = true
			conn, err := dialManagedTarget(managed.targetContext(), "udp", p.set.Targets[index])
			if err != nil {
				if pinned {
					return
				}
				continue
			}
			s.target, s.targetIndex = conn.(*net.UDPConn), index
			tuneUDPConn(s.target, "exit target", fxpUDPSessionBufferBytes)
			p.selected("udp", index)
			select {
			case s.targetWake <- struct{}{}:
			default:
			}
			break
		}
		if s.target == nil {
			return
		}
	}
	_ = s.target.SetWriteDeadline(time.Now().Add(managedTargetDialTimeout))
	if _, err := s.target.Write(payload); err != nil {
		_ = s.target.Close()
		s.target = nil
		return
	}
	s.touch()
}

// Socket identity is the receiver generation. Serialize validation and sealing
// with socket replacement: an old receiver cannot consume a return nonce or
// send a late response after failover, even if it completed Read before Close.
func (s *udpDirectExitSession) returnManagedPayload(target *net.UDPConn, index int, payload []byte) {
	managed := managedExitFor(s.cfg)
	if managed == nil {
		return
	}
	managed.mu.RLock()
	defer managed.mu.RUnlock()
	policy := managed.policy.Load()
	if s.managedPool != nil {
		if policy.pools[s.ruleID] != s.managedPool {
			return
		}
	} else {
		target, ok := policy.targets[s.ruleID]
		if !ok || policy.pools[s.ruleID] != nil || target.TargetIP != s.targetIP || target.TargetPort != s.targetPort {
			return
		}
	}
	s.targetMu.Lock()
	defer s.targetMu.Unlock()
	select {
	case <-s.done:
		return
	default:
	}
	if s.target != target || (s.managedPool != nil && !s.managedPool.available(index)) {
		return
	}
	if s.managedPool != nil && s.managedPool.set.Probe == "none" {
		s.managedPool.observe(index, true, time.Now())
	}
	packets, err := sealFXPUDPDatagramsWithCodec(fxpUDPPacket{
		packetType: fxpUDPTypeReturn, tunnelID: s.cfg.TunnelID, ruleID: s.ruleID,
		sessionID: s.sessionID, payload: payload,
	}, s.returnSealer, &s.sendSequence)
	if err != nil {
		return
	}
	_ = s.conn.SetWriteDeadline(time.Now().Add(managedTargetDialTimeout))
	for _, packet := range packets {
		if _, err := s.conn.WriteToUDP(packet, s.peerAddr); err != nil {
			return
		}
	}
	s.touch()
}
