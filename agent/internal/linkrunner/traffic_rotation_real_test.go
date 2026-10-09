package linkrunner

import (
	"fmt"
	"net"
	"os"
	"testing"
	"time"
)

func TestRealFXPTrafficRotationKeepsHeldTCPAndUDPAndFinalACK(t *testing.T) {
	binary := os.Getenv("TUNEX_TEST_FXP_BINARY")
	if binary == "" {
		t.Skip("requires the actual managed FXP binary")
	}
	m := newTestManager(t, binary, t.TempDir())
	if err := m.EnableTraffic(); err != nil {
		t.Fatal(err)
	}
	if !m.TrafficRotationSupported() {
		t.Fatal("pinned executable does not implement rotation capability")
	}
	target := realEchoTarget(t)
	carrier, port := freePort(t, "tcp"), freePort(t, "tcp")
	for port == carrier {
		port = freePort(t, "tcp")
	}
	exit := exitConfig(t, "rotation-exit", "both", carrier, 1)
	setRunner(t, &exit, map[string]any{"role": "exit", "tunnelId": 91, "listenHost": "127.0.0.1", "listenPort": carrier, "udpListenPort": carrier, "protocol": "both", "key": fixtureKey, "managedReload": true, "requireBindingAuth": true,
		"allowedBindings": []map[string]any{{"ruleId": 101, "protocol": "tcp", "targetIp": "127.0.0.1", "targetPort": target.port}, {"ruleId": 101, "protocol": "udp", "targetIp": "127.0.0.1", "targetPort": target.port}},
		"udpTargets":      []map[string]any{{"ruleId": 101, "targetIp": "127.0.0.1", "targetPort": target.port}}})
	entry := cloneConfig(exit)
	entry.ID, entry.Role = "rotation-entry", "ingress"
	entry.Ports = []Port{{"tcp", "127.0.0.1", port}, {"udp", "127.0.0.1", port}}
	entry.RuntimeIDs = []string{"rotation-tcp", "rotation-udp"}
	setRunner(t, &entry, map[string]any{"role": "entry-group", "tunnelId": 91, "managedReload": true, "entries": []map[string]any{{"role": "entry", "tunnelId": 91, "ruleId": 101, "listenHost": "127.0.0.1", "listenPort": port, "protocol": "both", "key": fixtureKey, "exitHost": "127.0.0.1", "exitPort": carrier, "targetIp": "127.0.0.1", "targetPort": target.port}}})
	o, err := m.Apply(exit)
	requireReady(t, o, err)
	o, err = m.Apply(entry)
	requireReady(t, o, err)
	pid := o.PID
	tcpConn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer tcpConn.Close()
	udpConn, err := net.DialTimeout("udp", fmt.Sprintf("127.0.0.1:%d", port), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer udpConn.Close()
	peer := ""
	for epoch := 0; epoch < 5; epoch++ {
		if err := echoRoundTrip(tcpConn, "persistent-tcp-across-accounting-epoch"); err != nil {
			t.Fatal(err)
		}
		got := udpRoundTrip(t, udpConn, target, "persistent-udp-across-accounting-epoch")
		if peer == "" {
			peer = got
		}
		if got != peer {
			t.Fatal("rotation rebuilt UDP target socket", peer, got)
		}
		var before []TrafficSample
		waitFor(t, func() bool {
			before, err = m.TrafficSamples()
			if err != nil {
				t.Fatal(err)
			}
			return len(before) > 0
		})
		oldID := m.running[entry.ID].trafficProducer
		// A confirmed active snapshot cannot reclaim files while the process
		// can still add deltas. After seal, the same stale ACK must retain tail.
		if err := m.AckTraffic(before); err != nil {
			t.Fatal(err)
		}
		assertTrafficFiles(t, m, oldID, true)
		if err := echoRoundTrip(tcpConn, "unacknowledged-tail-must-survive"); err != nil {
			t.Fatal(err)
		}
		waitFor(t, func() bool {
			current, e := m.TrafficSamples()
			if e != nil {
				t.Fatal(e)
			}
			if len(current) != len(before) {
				return true
			}
			return current[len(current)-1].BytesIn != before[len(before)-1].BytesIn
		})
		m.mu.Lock()
		err = m.rotateTrafficLocked(m.running[entry.ID], entry)
		m.mu.Unlock()
		if err != nil {
			t.Fatal(err)
		}
		m.mu.Lock()
		observation := m.observeLocked(entry.ID)
		m.mu.Unlock()
		if m.running[entry.ID].trafficProducer == oldID || observation.PID != pid {
			t.Fatal("accounting epoch did not change without restart", observation)
		}
		if err := m.AckTraffic(before); err != nil {
			t.Fatal(err)
		}
		assertTrafficFiles(t, m, oldID, true)
		final, err := m.TrafficSamples()
		if err != nil {
			t.Fatal(err)
		}
		if err := m.AckTraffic(final); err != nil {
			t.Fatal(err)
		}
		assertTrafficFiles(t, m, oldID, false)
		files, _, err := m.traffic.inventory()
		if err != nil || len(files) != 1 {
			t.Fatal("retained retired epoch after exact ACK", files, err)
		}
	}
	if err := echoRoundTrip(tcpConn, "final-held-tcp"); err != nil {
		t.Fatal(err)
	}
	if got := udpRoundTrip(t, udpConn, target, "final-held-udp"); got != peer {
		t.Fatal("UDP mapping changed")
	}
}
