package linkrunner

import (
	"fmt"
	"net"
	"os"
	"strings"
	"testing"
	"time"
)

// The separate variable lets the collector acceptance run without opting every
// existing FXP test into the real executable. Either variable is supported.
func TestRealFXPTrafficBothActiveTCPDeleteAndRestart(t *testing.T) {
	binary := os.Getenv("TUNEX_TEST_FXP_TRAFFIC_BINARY")
	if binary == "" {
		binary = os.Getenv("TUNEX_TEST_FXP_BINARY")
	}
	if binary == "" {
		t.Skip("set TUNEX_TEST_FXP_TRAFFIC_BINARY to a managed-traffic FXP executable")
	}
	t.Setenv("NODE_CREDENTIAL", "traffic-test-no-node-credential")
	t.Setenv("AUTH_SECRET", "traffic-test-no-auth-secret")
	dir := t.TempDir()
	m := newTestManager(t, binary, dir)
	if err := m.EnableTraffic(); err != nil {
		t.Fatal(err)
	}
	aTarget, bTarget := realEchoTarget(t), realEchoTarget(t)
	carrier, aPort, bPort := freePort(t, "tcp"), freePort(t, "tcp"), freePort(t, "tcp")
	for aPort == carrier {
		aPort = freePort(t, "tcp")
	}
	for bPort == carrier || bPort == aPort {
		bPort = freePort(t, "tcp")
	}
	exit := exitConfig(t, "traffic-real-exit", "both", carrier, 1)
	allowed, targets := []map[string]any{}, []map[string]any{}
	for _, binding := range []struct{ id, target int }{{101, aTarget.port}, {102, bTarget.port}} {
		for _, protocol := range []string{"tcp", "udp"} {
			allowed = append(allowed, map[string]any{"ruleId": binding.id, "protocol": protocol, "targetIp": "127.0.0.1", "targetPort": binding.target})
		}
		targets = append(targets, map[string]any{"ruleId": binding.id, "targetIp": "127.0.0.1", "targetPort": binding.target})
	}
	setRunner(t, &exit, map[string]any{"role": "exit", "tunnelId": 91, "listenHost": "127.0.0.1", "listenPort": carrier, "udpListenPort": carrier, "protocol": "both", "key": fixtureKey, "requireBindingAuth": true, "managedReload": true, "allowedBindings": allowed, "udpTargets": targets})
	ingress := cloneConfig(exit)
	ingress.ID, ingress.Role = "traffic-real-ingress", "ingress"
	configure := func(includeA bool) {
		entries := []map[string]any{}
		ingress.Ports = nil
		ingress.RuntimeIDs = nil
		for _, binding := range []struct{ id, port, target int }{{101, aPort, aTarget.port}, {102, bPort, bTarget.port}} {
			if binding.id == 101 && !includeA {
				continue
			}
			entries = append(entries, map[string]any{"role": "entry", "tunnelId": 91, "ruleId": binding.id, "listenHost": "127.0.0.1", "listenPort": binding.port, "protocol": "both", "key": fixtureKey, "exitHost": "127.0.0.1", "exitPort": carrier, "targetIp": "127.0.0.1", "targetPort": binding.target})
			for _, protocol := range []string{"tcp", "udp"} {
				ingress.Ports = append(ingress.Ports, Port{protocol, "127.0.0.1", binding.port})
				ingress.RuntimeIDs = append(ingress.RuntimeIDs, fmt.Sprintf("traffic-%d-%s", binding.id, protocol))
			}
		}
		setRunner(t, &ingress, map[string]any{"role": "entry-group", "tunnelId": 91, "managedReload": true, "entries": entries})
	}
	configure(true)
	o, err := m.Apply(exit)
	requireReady(t, o, err)
	o, err = m.Apply(ingress)
	requireReady(t, o, err)
	producer := m.running[ingress.ID].trafficProducer
	firstDigest := ingress.ConfigDigest
	pid := o.PID
	if m.running[exit.ID].trafficProducer != "" {
		t.Fatal("egress started a traffic producer")
	}
	connect := func(protocol string, port int) net.Conn {
		conn, err := net.DialTimeout(protocol, fmt.Sprintf("127.0.0.1:%d", port), time.Second)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = conn.Close() })
		return conn
	}
	aTCP, bTCP, aUDP, bUDP := connect("tcp", aPort), connect("tcp", bPort), connect("udp", aPort), connect("udp", bPort)
	payload := strings.Repeat("known-business-payload-", 32)
	if err := echoRoundTrip(aTCP, payload); err != nil {
		t.Fatal(err)
	}
	if err := echoRoundTrip(bTCP, payload); err != nil {
		t.Fatal(err)
	}
	udpRoundTrip(t, aUDP, aTarget, payload)
	udpRoundTrip(t, bUDP, bTarget, payload)
	var before []TrafficSample
	waitFor(t, func() bool {
		before, err = m.TrafficSamples()
		if err != nil {
			t.Fatal(err)
		}
		if len(before) != 2 {
			return false
		}
		for _, s := range before {
			in, _ := trafficDecimal(s.BytesIn)
			out, _ := trafficDecimal(s.BytesOut)
			connections, _ := trafficDecimal(s.Connections)
			if in < uint64(2*len(payload)) || out < uint64(2*len(payload)) || connections < 2 {
				return false
			}
			if s.ProducerID != producer || s.Generation != 1 || s.ConfigDigest != firstDigest || s.Date != time.Now().In(time.FixedZone("Asia/Shanghai", 8*60*60)).Format("2006-01-02") {
				t.Fatal("real traffic metadata", s)
			}
		}
		return true
	})
	// TCP is still open: its counters must already have reached the spool.
	if err := echoRoundTrip(bTCP, "still-held-open"); err != nil {
		t.Fatal(err)
	}
	if err := m.AckTraffic(before); err != nil {
		t.Fatal(err)
	}
	assertTrafficFiles(t, m, producer, true)
	// Remove A without touching B's process/held TCP or historical A counters.
	ingress.Generation = 2
	configure(false)
	o, err = m.Apply(ingress)
	requireReady(t, o, err)
	if o.PID != pid {
		t.Fatal("rule removal restarted carrier")
	}
	if err := echoRoundTrip(bTCP, "B-survives-removal"); err != nil {
		t.Fatal(err)
	}
	var after []TrafficSample
	waitFor(t, func() bool {
		after, err = m.TrafficSamples()
		if err != nil {
			t.Fatal(err)
		}
		if len(after) != 2 {
			return false
		}
		for i, s := range after {
			if s.ForwardID != before[i].ForwardID || !trafficMetadataEqual(s, before[i]) || !trafficCounterLE(before[i].counter(), s.counter()) {
				t.Fatal("removed-rule traffic lost", after)
			}
		}
		return true
	})
	if err := m.Close(); err != nil {
		t.Fatal(err)
	}
	assertTrafficFiles(t, m, producer, true)
	reopened := newTestManager(t, binary, dir)
	if err := reopened.EnableTraffic(); err != nil {
		t.Fatal(err)
	}
	recovered, err := reopened.TrafficSamples()
	if err != nil || len(recovered) != 2 {
		t.Fatal("close/reopen lost real traffic", recovered, err)
	}
	for i, s := range recovered {
		if !trafficMetadataEqual(s, after[i]) || !trafficCounterLE(after[i].counter(), s.counter()) {
			t.Fatal("final flush regressed", recovered)
		}
	}
	observations, err := reopened.Restore()
	if err != nil {
		t.Fatal(err)
	}
	for _, o := range observations {
		if !o.Ready {
			t.Fatal("restore not ready", o)
		}
	}
	newProducer := reopened.running[ingress.ID].trafficProducer
	if newProducer == producer {
		t.Fatal("restart reused producer")
	}
	assertTrafficFiles(t, reopened, newProducer, true)
	if all, err := reopened.TrafficSamples(); err != nil || len(all) != 2 {
		t.Fatal("new empty producer hid old data", all, err)
	}
	if err := reopened.AckTraffic(recovered); err != nil {
		t.Fatal(err)
	}
	assertTrafficFiles(t, reopened, producer, false)
	assertTrafficFiles(t, reopened, newProducer, true)
}
