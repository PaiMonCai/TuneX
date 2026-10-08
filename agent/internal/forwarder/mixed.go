package forwarder

import (
	"errors"
	"sort"
	"sync"
	"time"
)

var mixedBuilders = map[ForwardProtocol]func(TunnelConfig, BuildDeps) (Runtime, error){
	ProtocolBoth: func(cfg TunnelConfig, deps BuildDeps) (Runtime, error) { return BuildMixed(cfg, deps) },
}

func RegisteredMixedBuilders() []string {
	result := make([]string, 0, len(mixedBuilders))
	for protocol := range mixedBuilders {
		result = append(result, string(protocol))
	}
	sort.Strings(result)
	return result
}

// MixedRuntime deliberately does not implement StreamRuntime/DatagramRuntime:
// their Stats methods have different meanings and a UDP mapping is not a TCP
// connection. One business identity owns both children and their common budget.
type MixedRuntime interface {
	Runtime
	Stream() StreamRuntime
	Datagram() DatagramRuntime
	Drain(time.Duration) error
}

type MixedForwarder struct {
	mu               sync.Mutex
	stream           StreamRuntime
	datagram         DatagramRuntime
	policy           *DataPlanePolicy
	started, stopped bool
	draining         bool
}

func BuildMixed(cfg TunnelConfig, deps BuildDeps) (*MixedForwarder, error) {
	if cfg.Protocol != ProtocolBoth {
		return nil, errors.New("forwarder: mixed runtime requires both")
	}
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	policy, err := NewDataPlanePolicy(cfg)
	if err != nil {
		return nil, err
	}
	policy.pauseAdmission(true)
	tcp, udp := cfg.Clone(), cfg.Clone()
	tcp.Protocol, udp.Protocol = ProtocolTCP, ProtocolUDP
	s, err := BuildStream(tcp, deps.StreamBuildDeps)
	if err != nil {
		return nil, err
	}
	d, err := BuildDatagram(udp, deps.Datagram)
	if err != nil {
		_ = s.Stop()
		return nil, err
	}
	switch child := s.(type) {
	case *SingleHopForwarder:
		child.sharedPolicy = policy
	case *EgressForwarder:
		child.sharedPolicy = policy
	default:
		_ = s.Stop()
		_ = d.Stop()
		return nil, errors.New("forwarder: stream cannot share mixed budget")
	}
	switch child := d.(type) {
	case *DatagramForwarder:
		child.policy = policy
	case *DatagramRelay:
		child.policy = policy
	case *DatagramEgress:
		// No end-user budget belongs on an exit; its peer is the hop node.
	default:
		_ = s.Stop()
		_ = d.Stop()
		return nil, errors.New("forwarder: datagram cannot share mixed budget")
	}
	return &MixedForwarder{stream: s, datagram: d, policy: policy}, nil
}

func (m *MixedForwarder) Start() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.stopped || m.draining {
		return errStoppedForwarder
	}
	if m.started {
		return ErrAlreadyStarted
	}
	if err := m.stream.Start(); err != nil {
		m.stopped = true
		_ = m.datagram.Stop()
		_ = m.stream.Stop()
		return err
	}
	if err := m.datagram.Start(); err != nil {
		m.stopped = true
		_ = m.datagram.Stop()
		_ = m.stream.Stop()
		return err
	}
	m.started = true
	m.policy.pauseAdmission(false)
	return nil
}

func (m *MixedForwarder) Running() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.started && !m.stopped && !m.draining && m.stream.Running() && m.datagram.Running()
}
func (m *MixedForwarder) Stream() StreamRuntime     { return m.stream }
func (m *MixedForwarder) Datagram() DatagramRuntime { return m.datagram }
func (m *MixedForwarder) Stats() int64 {
	d := m.datagram.Stats()
	return m.stream.Stats() + d.BytesIn + d.BytesOut
}
func (m *MixedForwarder) LiveConns() int {
	if s, ok := m.stream.(interface{ LiveConns() int }); ok {
		return s.LiveConns()
	}
	return 0
}
func (m *MixedForwarder) Stop() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.stopped = true
	m.policy.pauseAdmission(true)
	if closer, ok := m.stream.(ListenerCloser); ok {
		closer.CloseListener()
	}
	return errors.Join(m.datagram.Stop(), m.stream.Stop())
}
func (m *MixedForwarder) CloseListener() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.closeListenersLocked()
}
func (m *MixedForwarder) closeListenersLocked() bool {
	m.draining = true
	m.policy.pauseAdmission(true)
	closed := m.datagram.CloseListener()
	if c, ok := m.stream.(ListenerCloser); ok {
		closed = c.CloseListener() || closed
	}
	return closed
}
func (m *MixedForwarder) Drain(timeout time.Duration) error {
	m.mu.Lock()
	m.draining = true
	m.policy.pauseAdmission(true)
	// In particular, datagram EGRESS's legacy zero-time drain waits forever.
	// Stop its admission first and do not invoke that wait for a zero budget.
	m.datagram.CloseListener()
	m.mu.Unlock()
	if timeout <= 0 {
		return m.stream.Drain(0)
	}
	if timeout > drainCeiling {
		timeout = drainCeiling
	}
	result := make(chan error, 2)
	go func() { result <- m.stream.Drain(timeout) }()
	go func() { result <- m.datagram.DrainMappings(timeout) }()
	return errors.Join(<-result, <-result)
}
func (m *MixedForwarder) Shutdown(timeout time.Duration) ShutdownResult {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.stopped = true
	closed := m.closeListenersLocked()
	start := time.Now()
	result := ShutdownResult{ClosedListener: closed}
	if d, ok := m.datagram.(Shutdowner); ok {
		udp := d.Shutdown(0)
		result.ForcedMappings = udp.ForcedMappings
	} else {
		result.ForcedMappings = m.datagram.LiveMappings()
		_ = m.datagram.Stop()
	}
	if s, ok := m.stream.(Shutdowner); ok {
		tcp := s.Shutdown(max(time.Duration(0), timeout-time.Since(start)))
		result.ClosedListener = result.ClosedListener || tcp.ClosedListener
		result.ForcedConns, result.RemainingConns = tcp.ForcedConns, tcp.RemainingConns
	} else {
		_ = m.stream.Stop()
	}
	return result
}
func (m *MixedForwarder) ProtocolDiagnostics() (ProtocolDiagnostics, bool) {
	if d, ok := m.datagram.(Diagnostician); ok {
		info, present := d.ProtocolDiagnostics()
		info.Protocol = string(ProtocolBoth)
		return info, present
	}
	return ProtocolDiagnostics{}, false
}
func (m *MixedForwarder) TargetStats() []TargetStats {
	if s, ok := m.stream.(interface{ TargetStats() []TargetStats }); ok {
		return s.TargetStats()
	}
	return nil
}
