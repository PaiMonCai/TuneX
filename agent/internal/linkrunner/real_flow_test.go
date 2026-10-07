package linkrunner

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"sync"
	"testing"
	"time"
)

type echoTarget struct {
	port     int
	udpPeers chan string
}

func realEchoTarget(t *testing.T) echoTarget {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	udp, err := net.ListenPacket("udp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		ln.Close()
		t.Fatal(err)
	}
	peers := make(chan string, 64)
	var mu sync.Mutex
	var connections []net.Conn
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			mu.Lock()
			connections = append(connections, c)
			mu.Unlock()
			wg.Add(1)
			go func() { defer wg.Done(); defer c.Close(); io.Copy(c, c) }()
		}
	}()
	go func() {
		defer wg.Done()
		buf := make([]byte, 2048)
		for {
			n, addr, err := udp.ReadFrom(buf)
			if err != nil {
				return
			}
			select {
			case peers <- addr.String():
			default:
			}
			udp.WriteTo(buf[:n], addr)
		}
	}()
	t.Cleanup(func() {
		ln.Close()
		udp.Close()
		mu.Lock()
		for _, c := range connections {
			c.Close()
		}
		mu.Unlock()
		wg.Wait()
	})
	return echoTarget{port, peers}
}

func echoRoundTrip(c net.Conn, value string) error {
	_ = c.SetDeadline(time.Now().Add(time.Second))
	if _, err := c.Write([]byte(value)); err != nil {
		return err
	}
	buf := make([]byte, len(value))
	if _, err := io.ReadFull(c, buf); err != nil {
		return err
	}
	if string(buf) != value {
		return fmt.Errorf("echo mismatch")
	}
	return nil
}

func udpRoundTrip(t *testing.T, c net.Conn, target echoTarget, value string) string {
	t.Helper()
	if err := echoRoundTrip(c, value); err != nil {
		t.Fatal(err)
	}
	select {
	case peer := <-target.udpPeers:
		return peer
	case <-time.After(time.Second):
		t.Fatal("target UDP source observation missing")
		return ""
	}
}

func setRunner(t *testing.T, cfg *Config, value any) {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	cfg.RunnerConfig = raw
	cfg.ConfigDigest, err = Digest(raw)
	if err != nil {
		t.Fatal(err)
	}
}

// Quantify shared process disruption instead of claiming binding hot reload.
// A and B carry real encrypted TCP and UDP; only B's target changes. Both
// existing TCP connections must drop after restart, while fresh traffic works.
func TestRealFXPSiblingUpdateDisruptionAndRecovery(t *testing.T) {
	if os.Getenv("TUNEX_TEST_FXP_BINARY") == "" {
		t.Skip("set TUNEX_TEST_FXP_BINARY for real network acceptance")
	}
	m := newTestManager(t, binaryForTest(t), t.TempDir())
	aTarget, bTarget, newBTarget := realEchoTarget(t), realEchoTarget(t), realEchoTarget(t)
	carrier, aPort, bPort := freePort(t, "tcp"), freePort(t, "tcp"), freePort(t, "tcp")
	for aPort == carrier {
		aPort = freePort(t, "tcp")
	}
	for bPort == carrier || bPort == aPort {
		bPort = freePort(t, "tcp")
	}
	exit := exitConfig(t, "shared-exit", "both", carrier, 1)
	exitShape := map[string]any{"role": "exit", "tunnelId": 91, "listenHost": "127.0.0.1", "listenPort": carrier, "udpListenPort": carrier, "protocol": "both", "key": fixtureKey, "requireBindingAuth": true}
	auth := func(bPort int) {
		allowed := []map[string]any{}
		targets := []map[string]any{}
		for i, p := range []int{aTarget.port, bPort} {
			for _, protocol := range []string{"tcp", "udp"} {
				allowed = append(allowed, map[string]any{"ruleId": 101 + i, "protocol": protocol, "targetIp": "127.0.0.1", "targetPort": p})
			}
			targets = append(targets, map[string]any{"ruleId": 101 + i, "targetIp": "127.0.0.1", "targetPort": p})
		}
		exitShape["allowedBindings"] = allowed
		exitShape["udpTargets"] = targets
	}
	auth(bTarget.port)
	setRunner(t, &exit, exitShape)
	o, err := m.Apply(exit)
	requireReady(t, o, err)
	entries := []map[string]any{}
	for i, p := range []int{aPort, bPort} {
		target := aTarget.port
		if i == 1 {
			target = bTarget.port
		}
		entries = append(entries, map[string]any{"role": "entry", "tunnelId": 91, "ruleId": 101 + i, "listenHost": "127.0.0.1", "listenPort": p, "protocol": "both", "exitHost": "127.0.0.1", "exitPort": carrier, "targetIp": "127.0.0.1", "targetPort": target, "key": fixtureKey})
	}
	ingress := cloneConfig(exit)
	ingress.ID = "shared-ingress"
	ingress.Role = "ingress"
	ingress.Ports = nil
	ingress.RuntimeIDs = nil
	for i, p := range []int{aPort, bPort} {
		for _, protocol := range []string{"tcp", "udp"} {
			ingress.Ports = append(ingress.Ports, Port{protocol, "127.0.0.1", p})
			ingress.RuntimeIDs = append(ingress.RuntimeIDs, fmt.Sprintf("binding-%d-%s", 101+i, protocol))
		}
	}
	setRunner(t, &ingress, map[string]any{"role": "entry-group", "tunnelId": 91, "entries": entries})
	o, err = m.Apply(ingress)
	requireReady(t, o, err)
	connect := func(protocol string, port int) net.Conn {
		c, err := net.Dial(protocol, fmt.Sprintf("127.0.0.1:%d", port))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { c.Close() })
		return c
	}
	aTCP, bTCP := connect("tcp", aPort), connect("tcp", bPort)
	for _, c := range []net.Conn{aTCP, bTCP} {
		if err := echoRoundTrip(c, "before-update"); err != nil {
			t.Fatal(err)
		}
	}
	aUDP, bUDP := connect("udp", aPort), connect("udp", bPort)
	aPeerBefore := udpRoundTrip(t, aUDP, aTarget, "a-before")
	udpRoundTrip(t, bUDP, bTarget, "b-before")
	// Change B only, keeping A's config, listen ports and physical UDP socket.
	for _, entry := range entries {
		if entry["ruleId"] == 102 {
			entry["targetPort"] = newBTarget.port
		}
	}
	ingress.Generation++
	setRunner(t, &ingress, map[string]any{"role": "entry-group", "tunnelId": 91, "entries": entries})
	started := time.Now()
	o, err = m.Apply(ingress)
	requireReady(t, o, err)
	elapsed := time.Since(started)
	dropped := 0
	for _, c := range []net.Conn{aTCP, bTCP} {
		if echoRoundTrip(c, "old-session") != nil {
			dropped++
		}
	}
	if dropped != 2 {
		t.Fatalf("restart unexpectedly preserved %d/2 sessions", 2-dropped)
	}
	// A recovers before exit authorization changes, proving sibling isolation in
	// new flow policy while explicitly exposing existing-session disruption.
	aPeerAfter := udpRoundTrip(t, aUDP, aTarget, "a-after-ingress")
	if aPeerBefore == aPeerAfter {
		t.Fatal("UDP mapping unexpectedly survived full process restart")
	}
	newATCP := connect("tcp", aPort)
	if err := echoRoundTrip(newATCP, "a-after-ingress"); err != nil {
		t.Fatal(err)
	}
	// Exit authorization is applied by restart as well; no live policy reload.
	exit.Generation++
	auth(newBTarget.port)
	setRunner(t, &exit, exitShape)
	startedExit := time.Now()
	o, err = m.Apply(exit)
	requireReady(t, o, err)
	if err := echoRoundTrip(newATCP, "old-exit-session"); err == nil {
		t.Fatal("exit restart preserved persistent TCP session")
	}
	for _, p := range []int{aPort, bPort} {
		fresh := connect("tcp", p)
		if err := echoRoundTrip(fresh, "fresh-after-update"); err != nil {
			t.Fatal(err)
		}
	}
	udpRoundTrip(t, aUDP, aTarget, "a-after-exit")
	udpRoundTrip(t, bUDP, newBTarget, "b-new-target")
	data, _ := json.Marshal(m.Status())
	if bytes.Contains(data, []byte(fixtureKey)) {
		t.Fatal("flow diagnostics leaked key")
	}
	t.Logf("B-only update: existing A/B TCP dropped=%d/2; unchanged A UDP mapping reset=true; ingress interruption=%s; exit auth restart=%s; fresh A/B TCP+UDP recovered", dropped, elapsed, time.Since(startedExit))
}
