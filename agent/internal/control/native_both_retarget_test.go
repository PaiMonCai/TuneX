package control

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"strconv"
	"testing"
	"time"

	"github.com/tunex/agent/internal/forwarder"
	"github.com/tunex/agent/internal/manager"
	"github.com/tunex/agent/internal/reporter"
)

// Tagged real endpoints distinguish a successful echo on the OLD target from
// a successful cutover. TCP and UDP use the same target port.
func bothTaggedTarget(t *testing.T, tag byte) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	u, err := net.ListenPacket("udp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = u.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				_ = c.SetDeadline(time.Now().Add(10 * time.Second))
				var buf [1]byte
				for {
					if _, err := c.Read(buf[:]); err != nil {
						return
					}
					if _, err := c.Write([]byte{tag}); err != nil {
						return
					}
				}
			}()
		}
	}()
	go func() {
		var buf [1024]byte
		for {
			_, addr, err := u.ReadFrom(buf[:])
			if err != nil {
				return
			}
			_, _ = u.WriteTo([]byte{tag}, addr)
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port
}

func TestNativeBothPublishesActualHopBeforeApplyAck(t *testing.T) {
	m := manager.NewTunnelManager(nil, "127.0.0.1")
	t.Cleanup(m.StopAll)
	var states []reporter.StatePayload
	r := reporter.New(reporter.Config{PanelURL: "http://fixture.invalid", Credential: "fixture"},
		reporter.WithTunnels(m), reporter.WithDiagnostics(m), reporter.WithPorts(m),
		reporter.WithPost(func(_ context.Context, _ string, body []byte, _ map[string]string) error {
			var state reporter.StatePayload
			if err := json.Unmarshal(body, &state); err != nil {
				return err
			}
			states = append(states, state)
			return nil
		}),
	)
	c := New(Config{ReportLinkState: r.ReportOnce}, m, nil)
	cmd := relayCommand(t, "tunex-9-relay", bothCommandPort(t), "127.0.0.1:9", 1)
	cmd.Config.Protocol = forwarder.ProtocolBoth
	for revision := int64(1); revision <= 2; revision++ {
		cmd.Config.Revision, cmd.Envelope.Revision = revision, revision
		ack := c.execute(context.Background(), cmd)
		if !ack.OK || ack.HopLocalAddr == "" {
			t.Fatalf("no actual hop in ACK: %+v", ack)
		}
		if len(states) != int(revision) {
			t.Fatalf("ACK preceded native state report: %d", len(states))
		}
		state := states[len(states)-1]
		if len(state.Tunnels) != 1 || state.Tunnels[0].Revision != revision || state.Tunnels[0].Diag == nil ||
			state.Tunnels[0].Diag.HopLocalAddr != ack.HopLocalAddr || state.Tunnels[0].Protocol != forwarder.ProtocolBoth {
			t.Fatal("published report did not describe the exact ACKed mixed runtime")
		}
	}
	cmd.Config.Revision, cmd.Envelope.Revision = 1, 1
	if ack := c.execute(context.Background(), cmd); ack.OK || len(states) != 2 {
		t.Fatal("stale apply published success facts")
	}
	// Telemetry outage is not a runtime refusal; do not manufacture a failed ACK.
	c.cfg.ReportLinkState = func(context.Context) error { return errors.New("offline fixture") }
	cmd.Config.Revision, cmd.Envelope.Revision = 3, 3
	if ack := c.execute(context.Background(), cmd); !ack.OK || ack.HopLocalAddr == "" {
		t.Fatal("telemetry failure changed the runtime outcome")
	}
}

func bothCommandPort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	u, err := net.ListenPacket("udp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer u.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

func TestExecuteNativeBothRelayRetargetsBothLanesAndActiveMapping(t *testing.T) {
	a, b := bothTaggedTarget(t, 'A'), bothTaggedTarget(t, 'B')
	em := manager.NewEgressManager()
	exit := manager.NewTunnelManager(em, "127.0.0.1")
	ingress := manager.NewTunnelManager(nil, "127.0.0.1")
	t.Cleanup(exit.StopAll)
	t.Cleanup(ingress.StopAll)
	exitClient, ingressClient := New(Config{}, exit, em), New(Config{}, ingress, nil)
	command := egressCommand(bothCommandPort(t))
	command.Config.Protocol, command.Config.HopPeer = forwarder.ProtocolBoth, "127.0.0.1"
	command.Config.Targets[0].Port = a
	apply := func(client *Client, cmd *QueuedCommand) {
		t.Helper()
		ack := client.execute(context.Background(), cmd)
		if !ack.OK {
			t.Fatalf("apply revision %d: %s %s", cmd.Envelope.Revision, ack.ErrorCode, ack.Error)
		}
	}
	apply(exitClient, command)
	hop := net.JoinHostPort("127.0.0.1", strconv.Itoa(command.Config.EgressPort))
	relay := relayCommand(t, "tunex-1-relay", bothCommandPort(t), hop, 1)
	relay.Config.Protocol = forwarder.ProtocolBoth
	apply(ingressClient, relay)
	addr := net.JoinHostPort("127.0.0.1", strconv.Itoa(relay.Config.IngressPort))
	u, err := net.Dial("udp", addr)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = u.Close() })
	expectTarget := func(tag byte) {
		t.Helper()
		c, err := net.DialTimeout("tcp", addr, 2*time.Second)
		if err != nil {
			t.Fatal(err)
		}
		defer c.Close()
		for _, lane := range []net.Conn{c, u} {
			_ = lane.SetDeadline(time.Now().Add(2 * time.Second))
			if _, err := lane.Write([]byte{'x'}); err != nil {
				t.Fatal(err)
			}
			var buf [1]byte
			if _, err := lane.Read(buf[:]); err != nil {
				t.Fatalf("%s reply: %v", lane.LocalAddr().Network(), err)
			}
			if buf[0] != tag {
				t.Fatalf("%s reached %c, want %c", lane.LocalAddr().Network(), buf[0], tag)
			}
		}
	}
	expectTarget('A') // Leaves a real UDP mapping alive across the revision.
	command.Config.Revision, command.Envelope.Revision = 2, 2
	command.Config.Targets[0].Port = b
	apply(exitClient, command) // PREPARE exit before the ingress cutover.
	apply(exitClient, command) // CUTOVER replay is idempotent.
	relay.Config.Revision, relay.Envelope.Revision = 2, 2
	apply(ingressClient, relay)
	expectTarget('B')
	for _, m := range []*manager.TunnelManager{exit, ingress} {
		if m.Len() != 1 || m.MaxRevision() != 2 {
			t.Fatal("split or stale business identity")
		}
	}
}
