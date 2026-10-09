package main

import (
	"bytes"
	"encoding/json"
	"net"
	"os"
	"strconv"
	"sync/atomic"
	"testing"
	"time"
)

func managedTCPTestTarget(t *testing.T, label string, port int) managedTarget {
	t.Helper()
	ln, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		t.Fatal(err)
	}
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				buf := make([]byte, 1024)
				for {
					n, err := conn.Read(buf)
					if err != nil {
						return
					}
					if _, err := conn.Write(append([]byte(label+":"), buf[:n]...)); err != nil {
						return
					}
				}
			}()
		}
	}()
	t.Cleanup(func() { _ = ln.Close(); <-finished })
	return managedTarget{"127.0.0.1", ln.Addr().(*net.TCPAddr).Port}
}

func managedUDPTestTarget(t *testing.T, label string, echo bool) (*net.UDPConn, managedTarget) {
	t.Helper()
	// These targets may be auxiliary-probed over TCP. UDP port zero alone can
	// select a number already occupied by an unrelated TCP fixture/service.
	conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: freeTCPUDPPort(t)})
	if err != nil {
		t.Fatal(err)
	}
	finished := make(chan struct{})
	if echo {
		go func() {
			defer close(finished)
			buf := make([]byte, 65535)
			for {
				n, addr, err := conn.ReadFromUDP(buf)
				if err != nil {
					return
				}
				_, _ = conn.WriteToUDP(append([]byte(label+":"), buf[:n]...), addr)
			}
		}()
	} else {
		close(finished)
	}
	t.Cleanup(func() { _ = conn.Close(); <-finished })
	return conn, managedTarget{"127.0.0.1", conn.LocalAddr().(*net.UDPAddr).Port}
}

func startManagedTargetTestExit(t *testing.T, cfg config) (*managedExitState, config, string) {
	t.Helper()
	cfg.ListenPort = freeTCPUDPPort(t)
	cfg.UDPListenPort = cfg.ListenPort
	path := managedFile(t, cfg)
	done := make(chan struct{})
	finished := make(chan error, 1)
	go func() { finished <- runManaged(done, path, true) }()
	t.Cleanup(func() {
		close(done)
		select {
		case err := <-finished:
			if err != nil {
				t.Error(err)
			}
		case <-time.After(3 * time.Second):
			t.Error("managed exit did not stop")
		}
	})
	waitForTCP(t, cfg.ListenPort)
	var state *managedExitState
	waitManagedCondition(t, func() bool { state = managedExitFor(cfg); return state != nil })
	return state, cfg, path
}

func startManagedTargetDirectUDP(t *testing.T, cfg config) (*managedExitState, *net.UDPConn, config) {
	t.Helper()
	conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1")})
	if err != nil {
		t.Fatal(err)
	}
	cfg.ListenPort = conn.LocalAddr().(*net.UDPAddr).Port
	cfg.UDPListenPort = cfg.ListenPort
	state := &managedExitState{}
	state.policy.Store(policyFor(cfg))
	state.policy.Load().buildProbes()
	state.startTargets()
	managedExits.Store(exitIdentity(cfg), state)
	finished := make(chan error, 1)
	go func() { finished <- serveExitUDPDirect(conn, cfg) }()
	t.Cleanup(func() {
		state.stopTargets()
		_ = conn.Close()
		select {
		case <-finished:
		case <-time.After(3 * time.Second):
			t.Error("direct UDP did not stop")
		}
		managedExits.Delete(exitIdentity(cfg))
	})
	return state, conn, cfg
}

func managedTestSecureTCP(t *testing.T, cfg config, rule, helloPort int) (*secureConn, net.Conn) {
	t.Helper()
	conn, sec, err := dialSecureTCP("127.0.0.1", cfg.ListenPort, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
	hello, _ := json.Marshal(helloFrame{TunnelID: cfg.TunnelID, RuleID: rule, Network: "tcp", TargetIP: "127.0.0.1", TargetPort: helloPort})
	if err := writeSecureHello(sec, hello); err != nil {
		t.Fatal(err)
	}
	return sec, conn
}

func managedTestTCPExchange(t *testing.T, sec *secureConn, want string) {
	t.Helper()
	if err := sec.writeFrame([]byte("payload")); err != nil {
		t.Fatal(err)
	}
	got, err := sec.readFrame()
	if err != nil || string(got) != want+":payload" {
		t.Fatalf("TCP reply=%q error=%v want=%s", got, err, want)
	}
}

func managedTestUDPClient(t *testing.T, exit *net.UDPConn) *net.UDPConn {
	t.Helper()
	client, err := net.DialUDP("udp", nil, exit.LocalAddr().(*net.UDPAddr))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return client
}

func managedTestUDPFrames(t *testing.T, cfg config, rule int, sid uint64, seq *atomic.Uint64, payload []byte) [][]byte {
	t.Helper()
	frames, err := sealFXPUDPDatagrams(fxpUDPPacket{packetType: fxpUDPTypeData, tunnelID: cfg.TunnelID, ruleID: rule, sessionID: sid, payload: payload}, cfg.Key, seq)
	if err != nil {
		t.Fatal(err)
	}
	return frames
}

func sendManagedTestUDP(t *testing.T, client *net.UDPConn, frames [][]byte) {
	t.Helper()
	for _, frame := range frames {
		if _, err := client.Write(frame); err != nil {
			t.Fatal(err)
		}
	}
}

func readManagedTestUDP(t *testing.T, client *net.UDPConn, cfg config, rule int, sid uint64, want string, replay *udpReplayWindow) fxpUDPPacket {
	t.Helper()
	_ = client.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, 65535)
	n, err := client.Read(buf)
	if err != nil {
		t.Fatal(err)
	}
	packet, err := openFXPUDPPacket(buf[:n], cfg.Key)
	if err != nil || packet.packetType != fxpUDPTypeReturn || packet.ruleID != rule || packet.sessionID != sid || string(packet.payload) != want {
		t.Fatalf("UDP reply=%+v error=%v want=%q", packet, err, want)
	}
	if replay != nil && !replay.accept(packet.sequence) {
		t.Fatal("return nonce/sequence repeated after socket replacement")
	}
	return packet
}

func assertNoManagedTestUDP(t *testing.T, client *net.UDPConn) {
	t.Helper()
	_ = client.SetReadDeadline(time.Now().Add(120 * time.Millisecond))
	if n, err := client.Read(make([]byte, 65535)); err == nil {
		t.Fatalf("unexpected UDP response (%d bytes)", n)
	} else if e, ok := err.(net.Error); !ok || !e.Timeout() {
		t.Fatal(err)
	}
}

func findManagedTestUDPSession(t *testing.T, state *managedExitState, rule int, sid uint64) *udpDirectExitSession {
	t.Helper()
	var found *udpDirectExitSession
	waitManagedCondition(t, func() bool {
		state.udp.Range(func(key, value any) bool {
			s := key.(*udpDirectExitSession)
			if value.(int) == rule && s.sessionID == sid {
				found = s
				return false
			}
			return true
		})
		return found != nil
	})
	return found
}

func confirmManagedTestFailure(t *testing.T, state *managedExitState, pool *managedTargetPool, index int) {
	confirmManagedTestFailures(t, state, pool, index)
}

// Socket tests use real time and real probes. Deterministic time stays in the
// pure policy tests.
func confirmManagedTestFailures(t *testing.T, state *managedExitState, pool *managedTargetPool, indices ...int) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		all := true
		for _, index := range indices {
			conn, err := dialManagedTarget(state.targetContext(), "tcp", pool.set.Targets[index])
			if conn != nil {
				_ = conn.Close()
			}
			if err == nil {
				t.Fatal("failure fixture accepted TCP probe")
			}
			state.observeTarget(pool, index, false, time.Now())
			pool.mu.Lock()
			failed := pool.health[index].state == "unhealthy"
			pool.mu.Unlock()
			all = all && failed
		}
		if all {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("real failure window did not confirm")
}

func recoverManagedTestTarget(t *testing.T, state *managedExitState, pool *managedTargetPool, index int) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		conn, err := dialManagedTarget(state.targetContext(), "tcp", pool.set.Targets[index])
		if conn != nil {
			_ = conn.Close()
		}
		if err != nil {
			t.Fatal("recovery fixture rejected TCP probe", err)
		}
		state.observeTarget(pool, index, true, time.Now())
		pool.mu.Lock()
		healthy := pool.health[index].state == "healthy"
		pool.mu.Unlock()
		if healthy {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("real recovery window did not confirm")
}

func TestManagedActualTCPFallbackAndRoundRobin(t *testing.T) {
	t.Run("fallback", func(t *testing.T) {
		backup := managedTCPTestTarget(t, "backup", 0)
		dead := managedTarget{"127.0.0.1", freeTCPPort(t)}
		cfg := managedTargetsFixture("tcp", "fallback", "none", dead, backup)
		state, cfg, _ := startManagedTargetTestExit(t, cfg)
		sec, _ := managedTestSecureTCP(t, cfg, 101, dead.Port)
		managedTestTCPExchange(t, sec, "backup")
		pool := state.policy.Load().pools[101]
		pool.mu.Lock()
		defer pool.mu.Unlock()
		if pool.tcp != 1 || pool.health[0].state != "suspect" || pool.health[1].state != "healthy" {
			t.Fatal("dial outcome not reflected", pool.health, pool.tcp)
		}
	})
	t.Run("round_robin", func(t *testing.T) {
		a := managedTCPTestTarget(t, "A", 0)
		b := managedTCPTestTarget(t, "B", 0)
		state, cfg, _ := startManagedTargetTestExit(t, managedTargetsFixture("tcp", "round_robin", "none", a, b))
		first, _ := managedTestSecureTCP(t, cfg, 101, b.Port) // legitimate member, exit still chooses A
		managedTestTCPExchange(t, first, "A")
		pool := state.policy.Load().pools[101]
		for i := 1; i < 8; i++ {
			sec, _ := managedTestSecureTCP(t, cfg, 101, a.Port)
			label := "A"
			if i%2 == 1 {
				label = "B"
			}
			managedTestTCPExchange(t, sec, label)
			pool.mu.Lock()
			index := pool.tcp
			pool.mu.Unlock()
			if index != i%2 {
				t.Fatalf("eight TCP RR indices: at %d got %d want %d", i, index, i%2)
			}
		}
		managedTestTCPExchange(t, first, "A") // established TCP never migrates
		third, _ := managedTestSecureTCP(t, cfg, 101, a.Port)
		managedTestTCPExchange(t, third, "A")
	})
}

func TestManagedActualTCPRandomStaysInsideAuthorizedSet(t *testing.T) {
	a := managedTCPTestTarget(t, "A", 0)
	b := managedTCPTestTarget(t, "B", 0)
	state, cfg, _ := startManagedTargetTestExit(t, managedTargetsFixture("tcp", "random", "none", a, b))
	for i := 0; i < 12; i++ {
		sec, conn := managedTestSecureTCP(t, cfg, 101, a.Port)
		if err := sec.writeFrame([]byte("random")); err != nil {
			t.Fatal(err)
		}
		got, err := sec.readFrame()
		if err != nil {
			t.Fatal(err)
		}
		pool := state.policy.Load().pools[101]
		pool.mu.Lock()
		index := pool.tcp
		pool.mu.Unlock()
		labels := []string{"A:random", "B:random"}
		if index < 0 || index > 1 || string(got) != labels[index] {
			t.Fatal("random escaped authorized set or reported wrong index", string(got), index)
		}
		_ = conn.Close()
	}
}

func TestManagedActualUDPFixedRoundRobinAndSilenceUnknown(t *testing.T) {
	_, a := managedUDPTestTarget(t, "A", true)
	_, b := managedUDPTestTarget(t, "B", true)
	state, exit, cfg := startManagedTargetDirectUDP(t, managedTargetsFixture("udp", "round_robin", "none", a, b))
	client := managedTestUDPClient(t, exit)
	var seqA, seqB atomic.Uint64
	for i := 0; i < 3; i++ {
		sendManagedTestUDP(t, client, managedTestUDPFrames(t, cfg, 101, 11, &seqA, []byte("same")))
		readManagedTestUDP(t, client, cfg, 101, 11, "A:same", nil)
	}
	sendManagedTestUDP(t, client, managedTestUDPFrames(t, cfg, 101, 12, &seqB, []byte("new")))
	readManagedTestUDP(t, client, cfg, 101, 12, "B:new", nil)
	first := findManagedTestUDPSession(t, state, 101, 11)
	_, index := first.targetSnapshot()
	if index != 0 {
		t.Fatal("RR moved existing UDP session")
	}
	_, silent := managedUDPTestTarget(t, "", false)
	silentState, silentExit, silentCfg := startManagedTargetDirectUDP(t, managedTargetsFixture("udp", "fallback", "none", silent, b))
	silentClient := managedTestUDPClient(t, silentExit)
	var silentSeq atomic.Uint64
	for i := 0; i < 3; i++ {
		sendManagedTestUDP(t, silentClient, managedTestUDPFrames(t, silentCfg, 101, 99, &silentSeq, []byte("silence")))
		assertNoManagedTestUDP(t, silentClient)
	}
	pool := silentState.policy.Load().pools[101]
	pool.mu.Lock()
	defer pool.mu.Unlock()
	if pool.checked != 0 || pool.health[0].state != "unknown" || pool.udp != 0 {
		t.Fatal("UDP silence fabricated a failed or successful probe", pool.checked, pool.health, pool.udp)
	}
}

func TestManagedEncryptedUDPFailoverKeepsNoncesReplayAndReceiverGeneration(t *testing.T) {
	oldTarget, a := managedUDPTestTarget(t, "A", true)
	_, b := managedUDPTestTarget(t, "B", true)
	managedTCPTestTarget(t, "probe-B", b.Port)
	state, exit, cfg := startManagedTargetDirectUDP(t, managedTargetsFixture("udp", "fallback", "tcp", a, b))
	client := managedTestUDPClient(t, exit)
	var seq atomic.Uint64
	var returns udpReplayWindow
	frames := managedTestUDPFrames(t, cfg, 101, 77, &seq, []byte("before"))
	sendManagedTestUDP(t, client, frames)
	before := readManagedTestUDP(t, client, cfg, 101, 77, "A:before", &returns)
	session := findManagedTestUDPSession(t, state, 101, 77)
	oldSocket, _ := session.targetSnapshot()
	oldAddress := oldSocket.LocalAddr().(*net.UDPAddr)
	dataCodec, returnCodec := session.dataOpener, session.returnSealer
	pool := state.policy.Load().pools[101]
	confirmManagedTestFailure(t, state, pool, 0)
	if socket, _ := session.targetSnapshot(); socket != nil {
		t.Fatal("confirmed failure did not close destination socket")
	}
	select {
	case <-session.done:
		t.Fatal("failover destroyed wire session")
	default:
	}
	sendManagedTestUDP(t, client, frames) // replay of the pre-failover authenticated datagram
	assertNoManagedTestUDP(t, client)
	sendManagedTestUDP(t, client, managedTestUDPFrames(t, cfg, 101, 77, &seq, []byte("after")))
	after := readManagedTestUDP(t, client, cfg, 101, 77, "B:after", &returns)
	if after.sequence <= before.sequence || session.dataOpener != dataCodec || session.returnSealer != returnCodec || findManagedTestUDPSession(t, state, 101, 77) != session {
		t.Fatal("failover reset codec/session/return sequence")
	}
	newSocket, index := session.targetSnapshot()
	if newSocket == oldSocket || index != 1 {
		t.Fatal("failed target socket was reused")
	}
	sequenceBeforeLate := session.sendSequence.Load()
	session.returnManagedPayload(oldSocket, 0, []byte("late-read-completed-before-close"))
	_, _ = oldTarget.WriteToUDP([]byte("late-network-packet"), oldAddress)
	assertNoManagedTestUDP(t, client)
	if session.sendSequence.Load() != sequenceBeforeLate {
		t.Fatal("obsolete receiver consumed nonce")
	}
	// Recovery restores fallback priority for new sessions; this session stays B.
	managedTCPTestTarget(t, "recovered-probe-A", a.Port)
	recoverManagedTestTarget(t, state, pool, 0)
	sendManagedTestUDP(t, client, managedTestUDPFrames(t, cfg, 101, 77, &seq, []byte("still")))
	readManagedTestUDP(t, client, cfg, 101, 77, "B:still", &returns)
	if socket, _ := session.targetSnapshot(); socket != newSocket {
		t.Fatal("recovery forcibly migrated existing UDP")
	}
	var nextSeq atomic.Uint64
	sendManagedTestUDP(t, client, managedTestUDPFrames(t, cfg, 101, 78, &nextSeq, []byte("new")))
	readManagedTestUDP(t, client, cfg, 101, 78, "A:new", nil)
}

func TestManagedActualUDPAllUnavailableThenRecover(t *testing.T) {
	_, a := managedUDPTestTarget(t, "A", true)
	_, b := managedUDPTestTarget(t, "B", true)
	state, exit, cfg := startManagedTargetDirectUDP(t, managedTargetsFixture("udp", "fallback", "tcp", a, b))
	client := managedTestUDPClient(t, exit)
	var seq atomic.Uint64
	sendManagedTestUDP(t, client, managedTestUDPFrames(t, cfg, 101, 55, &seq, []byte("before")))
	readManagedTestUDP(t, client, cfg, 101, 55, "A:before", nil)
	pool := state.policy.Load().pools[101]
	confirmManagedTestFailures(t, state, pool, 0, 1)
	sendManagedTestUDP(t, client, managedTestUDPFrames(t, cfg, 101, 55, &seq, []byte("blocked")))
	assertNoManagedTestUDP(t, client)
	var otherSeq atomic.Uint64
	sendManagedTestUDP(t, client, managedTestUDPFrames(t, cfg, 101, 56, &otherSeq, []byte("blocked-new")))
	assertNoManagedTestUDP(t, client)
	managedTCPTestTarget(t, "recovered-probe-B", b.Port)
	conn, err := dialManagedTarget(state.targetContext(), "tcp", pool.set.Targets[1])
	if err != nil {
		t.Fatal(err)
	}
	_ = conn.Close()
	state.observeTarget(pool, 1, true, time.Now())
	sendManagedTestUDP(t, client, managedTestUDPFrames(t, cfg, 101, 55, &seq, []byte("recovering")))
	assertNoManagedTestUDP(t, client)
	recoverManagedTestTarget(t, state, pool, 1)
	sendManagedTestUDP(t, client, managedTestUDPFrames(t, cfg, 101, 55, &seq, []byte("recovered")))
	readManagedTestUDP(t, client, cfg, 101, 55, "B:recovered", nil)
}

func TestManagedActualReloadOnlyClosesChangedRule(t *testing.T) {
	_, a := managedUDPTestTarget(t, "A", true)
	_, backup := managedUDPTestTarget(t, "backup", true)
	managedTCPTestTarget(t, "A", a.Port)
	managedTCPTestTarget(t, "backup", backup.Port)
	cfg := managedTargetsFixture("both", "round_robin", "none", a, backup)
	b := cfg.TargetSets[0]
	b.RuleID = 102
	cfg.TargetSets = append(cfg.TargetSets, b)
	for _, binding := range append([]authorizedBinding(nil), cfg.AllowedBindings...) {
		binding.RuleID = 102
		cfg.AllowedBindings = append(cfg.AllowedBindings, binding)
	}
	cfg.UDPTargets = append(cfg.UDPTargets, udpTarget{102, a.Host, a.Port})
	state, cfg, path := startManagedTargetTestExit(t, cfg)
	udp, err := net.DialUDP("udp", nil, &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: cfg.ListenPort})
	if err != nil {
		t.Fatal(err)
	}
	defer udp.Close()
	var seqA, seqB atomic.Uint64
	sendManagedTestUDP(t, udp, managedTestUDPFrames(t, cfg, 101, 1, &seqA, []byte("A")))
	readManagedTestUDP(t, udp, cfg, 101, 1, "A:A", nil)
	sendManagedTestUDP(t, udp, managedTestUDPFrames(t, cfg, 102, 2, &seqB, []byte("B")))
	readManagedTestUDP(t, udp, cfg, 102, 2, "A:B", nil)
	oldA := findManagedTestUDPSession(t, state, 101, 1)
	oldB := findManagedTestUDPSession(t, state, 102, 2)
	bSocket, _ := oldB.targetSnapshot()
	bPool := state.policy.Load().pools[102]
	aTCP, aConn := managedTestSecureTCP(t, cfg, 101, a.Port)
	managedTestTCPExchange(t, aTCP, "backup")
	bTCP, _ := managedTestSecureTCP(t, cfg, 102, a.Port)
	managedTestTCPExchange(t, bTCP, "backup")
	next := cfg
	next.TargetSets = append([]managedTargetSet(nil), cfg.TargetSets...)
	next.TargetSets[0].Strategy = "fallback"
	raw, _ := json.Marshal(next)
	var shape map[string]any
	_ = json.Unmarshal(raw, &shape)
	shape["managedReload"] = true
	raw, _ = json.Marshal(shape)
	if err := os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	waitManagedCondition(t, func() bool { return state.policy.Load().pools[101] != oldA.managedPool })
	select {
	case <-oldA.done:
	default:
		t.Fatal("changed A UDP still open")
	}
	_ = aConn.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := aTCP.readFrame(); err == nil {
		t.Fatal("changed A TCP still open")
	}
	if findManagedTestUDPSession(t, state, 102, 2) != oldB || state.policy.Load().pools[102] != bPool {
		t.Fatal("B session/pool replaced")
	}
	if socket, _ := oldB.targetSnapshot(); socket != bSocket {
		t.Fatal("B target socket replaced")
	}
	managedTestTCPExchange(t, bTCP, "backup")
	sendManagedTestUDP(t, udp, managedTestUDPFrames(t, cfg, 102, 2, &seqB, []byte("kept")))
	readManagedTestUDP(t, udp, cfg, 102, 2, "A:kept", nil)
	if _, digest, err := readManagedConfig(path, true); err != nil {
		t.Fatal(err)
	} else {
		state.mu.RLock()
		running := state.digest
		state.mu.RUnlock()
		if running != digest {
			t.Fatal("running status digest did not advance")
		}
	}
}

func TestManagedActualTCPRejectsForgedHelloWithValidKey(t *testing.T) {
	allowed := managedTCPTestTarget(t, "allowed", 0)
	state, cfg, _ := startManagedTargetTestExit(t, managedTargetsFixture("tcp", "fallback", "none", allowed))
	_ = state
	for _, change := range []func(*helloFrame){func(h *helloFrame) { h.TargetPort++ }, func(h *helloFrame) { h.RuleID++ }, func(h *helloFrame) { h.Network = "udp" }} {
		conn, sec, err := dialSecureTCP("127.0.0.1", cfg.ListenPort, cfg)
		if err != nil {
			t.Fatal(err)
		}
		_ = conn.SetDeadline(time.Now().Add(time.Second))
		h := helloFrame{TunnelID: cfg.TunnelID, RuleID: 101, Network: "tcp", TargetIP: allowed.Host, TargetPort: allowed.Port}
		change(&h)
		raw, _ := json.Marshal(h)
		if err := writeSecureHello(sec, raw); err != nil {
			t.Fatal(err)
		}
		if _, err := sec.readFrame(); err == nil {
			t.Fatal("valid key bypassed binding boundary")
		}
		_ = conn.Close()
	}
}

func TestManagedTargetUDPFragmentReplaySurvivesFailover(t *testing.T) {
	// Fragment admission is the same replay object across destination changes.
	_, a := managedUDPTestTarget(t, "A", true)
	bConn, b := managedUDPTestTarget(t, "", false)
	managedTCPTestTarget(t, "probe-B", b.Port)
	state, exit, cfg := startManagedTargetDirectUDP(t, managedTargetsFixture("udp", "fallback", "tcp", a, b))
	client := managedTestUDPClient(t, exit)
	var seq atomic.Uint64
	large := bytes.Repeat([]byte("x"), 2*fxpUDPFragmentPayloadSize)
	frames := managedTestUDPFrames(t, cfg, 101, 88, &seq, large)
	sendManagedTestUDP(t, client, frames)
	// Reassemble the real encrypted return before changing the socket.
	var reassembler udpFragmentReassembler
	var replay udpReplayWindow
	buf := make([]byte, 65535)
	_ = client.SetReadDeadline(time.Now().Add(2 * time.Second))
	for {
		n, err := client.Read(buf)
		if err != nil {
			t.Fatal(err)
		}
		packet, err := openFXPUDPPacket(buf[:n], cfg.Key)
		if err != nil {
			t.Fatal(err)
		}
		if payload, ok := reassembler.accept(packet, &replay); ok {
			if !bytes.Equal(payload, append([]byte("A:"), large...)) {
				t.Fatal("large encrypted return corrupted")
			}
			break
		}
	}
	pool := state.policy.Load().pools[101]
	confirmManagedTestFailure(t, state, pool, 0)
	sendManagedTestUDP(t, client, frames)
	_ = bConn.SetReadDeadline(time.Now().Add(120 * time.Millisecond))
	if _, _, err := bConn.ReadFromUDP(buf); err == nil {
		t.Fatal("replayed fragment assembly forwarded after failover")
	}
	sendManagedTestUDP(t, client, managedTestUDPFrames(t, cfg, 101, 88, &seq, large))
	_ = bConn.SetReadDeadline(time.Now().Add(2 * time.Second))
	n, _, err := bConn.ReadFromUDP(buf)
	if err != nil || !bytes.Equal(buf[:n], large) {
		t.Fatal("fresh fragments not forwarded after failover", err)
	}
}

func TestManagedEncryptedUDPPolicyReloadKeepsWireHistory(t *testing.T) {
	_, a := managedUDPTestTarget(t, "A", true)
	_, b := managedUDPTestTarget(t, "B", true)
	state, exit, cfg := startManagedTargetDirectUDP(t, managedTargetsFixture("udp", "fallback", "none", a, b))
	client := managedTestUDPClient(t, exit)
	var seq atomic.Uint64
	var returns udpReplayWindow
	oldFrames := managedTestUDPFrames(t, cfg, 101, 202, &seq, []byte("before"))
	sendManagedTestUDP(t, client, oldFrames)
	before := readManagedTestUDP(t, client, cfg, 101, 202, "A:before", &returns)
	old := findManagedTestUDPSession(t, state, 101, 202)
	next := managedTargetsFixture("udp", "fallback", "none", b, a)
	state.apply(next)
	select {
	case <-old.done:
	default:
		t.Fatal("policy retained old destination session")
	}
	sendManagedTestUDP(t, client, oldFrames)
	assertNoManagedTestUDP(t, client)
	sendManagedTestUDP(t, client, managedTestUDPFrames(t, cfg, 101, 202, &seq, []byte("after")))
	after := readManagedTestUDP(t, client, cfg, 101, 202, "B:after", &returns)
	current := findManagedTestUDPSession(t, state, 101, 202)
	if current == old || after.sequence <= before.sequence || current.dataOpener != old.dataOpener || current.returnSealer != old.returnSealer {
		t.Fatal("policy reload forgot nonce/replay/codec history")
	}
	// The same authenticated context cannot open a second peer-side session.
	other := managedTestUDPClient(t, exit)
	sendManagedTestUDP(t, other, oldFrames)
	assertNoManagedTestUDP(t, other)
}

func TestManagedActualNoProbeTCPRecoveryFromAllUnavailable(t *testing.T) {
	dead := managedTarget{"127.0.0.1", freeTCPPort(t)}
	cfg := managedTargetsFixture("tcp", "fallback", "none", dead)
	state, cfg, _ := startManagedTargetTestExit(t, cfg)
	p := state.policy.Load().pools[101]
	confirmManagedTestFailures(t, state, p, 0)
	managedTCPTestTarget(t, "recovered", dead.Port)
	for i := 0; i < 2; i++ {
		// Accelerate only the selector's cooldown clock; each dial is real.
		p.mu.Lock()
		p.health[0].nextProbe = time.Time{}
		if i == 1 {
			p.health[0].recoverySince = time.Now().Add(-10 * time.Second)
		}
		p.mu.Unlock()
		sec, conn := managedTestSecureTCP(t, cfg, 101, dead.Port)
		if i == 0 {
			if _, err := sec.readFrame(); err == nil {
				t.Fatal("half-open carried payload before recovery")
			}
			_ = conn.Close()
		} else {
			managedTestTCPExchange(t, sec, "recovered")
		}
	}
}
