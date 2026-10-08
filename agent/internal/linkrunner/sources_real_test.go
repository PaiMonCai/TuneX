package linkrunner

import (
	"fmt"
	"net"
	"os"
	"testing"
)

func sourceFreeBothPort(t *testing.T) int {
	t.Helper()
	for attempt := 0; attempt < 20; attempt++ {
		tcp, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		port := tcp.Addr().(*net.TCPAddr).Port
		udp, err := net.ListenPacket("udp", fmt.Sprintf("127.0.0.1:%d", port))
		_ = tcp.Close()
		if err == nil {
			_ = udp.Close()
			return port
		}
	}
	t.Fatal("no free TCP+UDP test port")
	return 0
}

func TestRealFXPSourcePolicyReloadPreservesSiblingAndCarrier(t *testing.T) {
	if os.Getenv("TUNEX_TEST_FXP_BINARY") == "" {
		t.Skip("requires real FXP")
	}
	m := newTestManager(t, binaryForTest(t), t.TempDir())
	if !m.ClientSourceSupported() {
		t.Fatal("pinned source capability unavailable")
	}
	aTarget, bTarget := realEchoTarget(t), realEchoTarget(t)
	carrier, aPort, bPort := sourceFreeBothPort(t), freePort(t, "tcp"), sourceFreeBothPort(t)
	for aPort == carrier {
		aPort = freePort(t, "tcp")
	}
	for bPort == carrier || bPort == aPort {
		bPort = sourceFreeBothPort(t)
	}
	exit := exitConfig(t, "source-exit", "both", carrier, 1)
	ingress := cloneConfig(exit)
	ingress.ID = "source-entry"
	ingress.Role = "ingress"
	configure := func(source map[string]any) {
		entries := []map[string]any{}
		allowed := []map[string]any{}
		ingress.Ports = nil
		ingress.RuntimeIDs = nil
		for _, b := range []struct {
			id, port, target int
			protocol         string
		}{{101, aPort, aTarget.port, "tcp"}, {102, bPort, bTarget.port, "both"}} {
			e := map[string]any{"role": "entry", "tunnelId": 91, "ruleId": b.id, "listenHost": "127.0.0.1", "listenPort": b.port, "udpListenPort": b.port, "protocol": b.protocol, "exitHost": "127.0.0.1", "exitPort": carrier, "udpExitPort": carrier, "targetIp": "127.0.0.1", "targetPort": b.target, "key": fixtureKey}
			if b.id == 101 && source != nil {
				e["clientSource"] = source
			}
			entries = append(entries, e)
			for _, protocol := range []string{"tcp", "udp"} {
				if b.protocol == "tcp" && protocol == "udp" {
					continue
				}
				ingress.Ports = append(ingress.Ports, Port{protocol, "127.0.0.1", b.port})
				ingress.RuntimeIDs = append(ingress.RuntimeIDs, fmt.Sprintf("source-%d-%s", b.id, protocol))
				allowed = append(allowed, map[string]any{"ruleId": b.id, "protocol": protocol, "targetIp": "127.0.0.1", "targetPort": b.target})
			}
		}
		x := map[string]any{"role": "exit", "tunnelId": 91, "listenHost": "127.0.0.1", "listenPort": carrier, "udpListenPort": carrier, "protocol": "both", "key": fixtureKey, "requireBindingAuth": true, "managedReload": true, "allowedBindings": allowed, "udpTargets": []map[string]any{{"ruleId": 102, "targetIp": "127.0.0.1", "targetPort": bTarget.port}}}
		if source != nil {
			s := map[string]any{}
			for k, v := range source {
				s[k] = v
			}
			s["ruleId"] = 101
			x["clientSources"] = []map[string]any{s}
		}
		setRunner(t, &exit, x)
		setRunner(t, &ingress, map[string]any{"role": "entry-group", "tunnelId": 91, "entries": entries, "managedReload": true})
	}
	configure(nil)
	xo, err := m.Apply(exit)
	requireReady(t, xo, err)
	exitPID := xo.PID
	io, err := m.Apply(ingress)
	requireReady(t, io, err)
	entryPID := io.PID
	exitChild, entryChild := m.running[exit.ID], m.running[ingress.ID]
	dumpLogs := func(p *child) {
		p.mu.Lock()
		defer p.mu.Unlock()
		t.Logf("child events: %v", p.logs)
	}
	bTCP, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", bPort))
	if err != nil {
		t.Fatal(err)
	}
	defer bTCP.Close()
	if err := echoRoundTrip(bTCP, "B-before-source"); err != nil {
		t.Fatal(err)
	}
	bUDP, err := net.Dial("udp", fmt.Sprintf("127.0.0.1:%d", bPort))
	if err != nil {
		t.Fatal(err)
	}
	defer bUDP.Close()
	bPeer := udpRoundTrip(t, bUDP, bTarget, "B-before-source")
	for _, receive := range []bool{false, true} {
		trust := []string{}
		if receive {
			trust = []string{"127.0.0.1/32"}
		}
		configure(map[string]any{"version": 1, "receiveProxy": receive, "trustedCIDRs": trust, "sendProxy": "off"})
		exit.Generation++
		ingress.Generation++
		xo, err = m.Apply(exit)
		if err != nil {
			dumpLogs(exitChild)
		}
		requireReady(t, xo, err)
		if xo.PID != exitPID || xo.UpdateMode != "managed_reload" {
			t.Fatal("source exit restarted", xo)
		}
		io, err = m.Apply(ingress)
		if err != nil {
			t.Logf("source receive=%v exit=%s ingress=%s", receive, exit.ConfigDigest, ingress.ConfigDigest)
			dumpLogs(entryChild)
		}
		requireReady(t, io, err)
		if io.PID != entryPID || io.UpdateMode != "managed_reload" {
			t.Fatal("source entry restarted", io)
		}
		if err := echoRoundTrip(bTCP, "B-held-through-source"); err != nil {
			t.Fatal(err)
		}
		if peer := udpRoundTrip(t, bUDP, bTarget, "B-source-fixed-mapping"); peer != bPeer {
			t.Fatal("B target UDP socket changed")
		}
		client, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", aPort))
		if err != nil {
			t.Fatal(err)
		}
		if receive {
			_, err = client.Write([]byte("PROXY TCP4 198.51.100.2 192.0.2.10 32001 443\r\n"))
			if err != nil {
				client.Close()
				t.Fatal(err)
			}
		}
		if err := echoRoundTrip(client, "A-new-source-policy"); err != nil {
			client.Close()
			t.Fatal(err)
		}
		client.Close()
	}
}
