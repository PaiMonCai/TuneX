package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"testing"
	"time"
)

func managedSourceTarget(t *testing.T, label string) managedTarget {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
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
				info, err := readManagedProxyHeader(conn, time.Second)
				if err != nil {
					return
				}
				buf := make([]byte, 4)
				for {
					if _, err := io.ReadFull(conn, buf); err != nil {
						return
					}
					if _, err := conn.Write([]byte(label + "|" + info.SourceIP + "|" + strconv.Itoa(info.SourcePort) + "|" + string(buf))); err != nil {
						return
					}
				}
			}()
		}
	}()
	t.Cleanup(func() { _ = ln.Close(); <-finished })
	return managedTarget{"127.0.0.1", ln.Addr().(*net.TCPAddr).Port}
}

func startManagedSourceRuntime(t *testing.T, cfg config) string {
	t.Helper()
	path := managedFile(t, cfg)
	done := make(chan struct{})
	finished := make(chan error, 1)
	go func() { finished <- runManaged(done, path, true, true) }()
	t.Cleanup(func() {
		close(done)
		select {
		case err := <-finished:
			if err != nil {
				t.Error(err)
			}
		case <-time.After(3 * time.Second):
			t.Error("source runtime did not stop")
		}
	})
	port := cfg.ListenPort
	if cfg.Role == "entry-group" {
		port = cfg.Entries[0].ListenPort
	}
	waitForTCP(t, port)
	return path
}

func sourceRuntimePair(t *testing.T, source managedClientSource, limits ...int) (config, config) {
	t.Helper()
	a, b := managedSourceTarget(t, "first"), managedSourceTarget(t, "second")
	if source.SendProxy == "off" {
		a, b = managedTCPTestTarget(t, "first", 0), managedTCPTestTarget(t, "second", 0)
	}
	exit := managedTargetsFixture("tcp", "ip_hash", "none", a, b)
	exit.ListenPort = freeTCPUDPPort(t)
	exit.UDPListenPort = exit.ListenPort
	exitSource := source
	exitSource.RuleID = 101
	exit.ClientSources = []managedClientSource{exitSource}
	startManagedSourceRuntime(t, exit)
	set := exit.TargetSets[0]
	entry := config{Role: "entry-group", TunnelID: exit.TunnelID, Entries: []config{{Role: "entry", TunnelID: exit.TunnelID, RuleID: 101, Protocol: "tcp", ListenHost: "127.0.0.1", ListenPort: freeTCPUDPPort(t), Key: exit.Key, ExitHost: "127.0.0.1", ExitPort: exit.ListenPort, TargetIP: a.Host, TargetPort: a.Port, TargetSet: &set, ClientSource: &source}}}
	if len(limits) > 0 {
		entry.Entries[0].MaxIPs = limits[0]
	}
	startManagedSourceRuntime(t, entry)
	return entry, exit
}

func sourceEntryExchange(t *testing.T, entry config, header []byte) string {
	t.Helper()
	conn, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(entry.Entries[0].ListenPort)), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
	if _, err := conn.Write(append(header, []byte("PING")...)); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 512)
	n, err := conn.Read(buf)
	if err != nil {
		t.Fatal("source payload did not reach target", err)
	}
	return string(buf[:n])
}

func TestManagedSourceRealEncryptedPROXYBothVersionsAndIPHash(t *testing.T) {
	for _, version := range []int{1, 2} {
		t.Run(fmt.Sprint(version), func(t *testing.T) {
			source := sourceFixture(true, "v"+strconv.Itoa(version))
			entry, _ := sourceRuntimePair(t, source)
			selected := map[string]string{}
			for _, ip := range []string{"198.51.100.2", "198.51.100.3", "2001:db8::2", "2001:db8::3"} {
				for n := 0; n < 4; n++ {
					destination := "192.0.2.10"
					if strings.Contains(ip, ":") {
						destination = "2001:db8::10"
					}
					header := formatProxyProtocol(helloFrame{ProxySourceIP: ip, ProxySourcePort: 32001 + n, ProxyDestIP: destination, ProxyDestPort: 443, ProxyProtocolVersion: version})
					got := sourceEntryExchange(t, entry, header)
					parts := strings.Split(got, "|")
					if len(parts) != 4 || parts[1] != ip || parts[2] != strconv.Itoa(32001+n) || parts[3] != "PING" {
						t.Fatal("incorrect PROXY source/payload", got)
					}
					if old := selected[ip]; old != "" && old != parts[0] {
						t.Fatal("same IP/changed port changed target", got)
					}
					selected[ip] = parts[0]
				}
			}
			if selected["198.51.100.2"] == selected["198.51.100.3"] {
				t.Fatal("test clients not distributed")
			}
		})
	}
}

func TestManagedSourceRealSocketAttestationAndForgedHelloRejection(t *testing.T) {
	source := sourceFixture(false, "v2")
	entry, exit := sourceRuntimePair(t, source)
	got := sourceEntryExchange(t, entry, nil)
	if !strings.Contains(got, "|127.0.0.1|") || !strings.HasSuffix(got, "|PING") {
		t.Fatal("carrier address or unavailable source sent", got)
	}
	// A correctly keyed carrier still cannot omit the required version/policy,
	// override PROXY version, or select an undeclared target/rule.
	for _, bad := range []string{"missing", "policy", "target", "rule"} {
		conn, sec, err := dialSecureTCP("127.0.0.1", exit.ListenPort, exit)
		if err != nil {
			t.Fatal(err)
		}
		_ = conn.SetDeadline(time.Now().Add(time.Second))
		h := sourceHello(source, "198.51.100.2")
		h.TargetIP, h.TargetPort = exit.TargetSets[0].Targets[0].Host, exit.TargetSets[0].Targets[0].Port
		switch bad {
		case "missing":
			h.SourceVersion = 0
		case "policy":
			h.SourcePolicy = "old-policy"
		case "target":
			h.TargetPort = 1
			for _, member := range exit.TargetSets[0].Targets {
				if h.TargetPort == member.Port {
					h.TargetPort++
				}
			}
		case "rule":
			h.RuleID++
		}
		raw, _ := json.Marshal(h)
		err = writeSecureHello(sec, raw)
		if err == nil {
			err = sec.writeFrame([]byte("PING"))
		}
		if err == nil {
			_, err = sec.readFrame()
		}
		conn.Close()
		if err == nil {
			t.Fatal("forged hello reached target", bad)
		}
	}
}

func TestManagedSourceRealUntrustedPeerAndUnknownHeaderFailClosed(t *testing.T) {
	for _, untrusted := range []bool{false, true} {
		source := sourceFixture(true, "v1")
		if untrusted {
			source.TrustedCIDRs = []string{"192.0.2.0/24"}
		}
		entry, _ := sourceRuntimePair(t, source)
		conn, err := net.Dial("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(entry.Entries[0].ListenPort)))
		if err != nil {
			t.Fatal(err)
		}
		_ = conn.SetDeadline(time.Now().Add(time.Second))
		header := []byte("PROXY UNKNOWN\r\n")
		if untrusted {
			header = formatProxyProtocolV1BytesForSourceTest("198.51.100.2", 32001)
		}
		_, _ = conn.Write(append(header, []byte("PING")...))
		_, err = conn.Read(make([]byte, 1))
		conn.Close()
		if err == nil {
			t.Fatal("untrusted/unknown source reached target")
		}
	}
}

func formatProxyProtocolV1BytesForSourceTest(ip string, port int) []byte {
	return formatProxyProtocol(helloFrame{ProxySourceIP: ip, ProxySourcePort: port, ProxyDestIP: "192.0.2.10", ProxyDestPort: 443, ProxyProtocolVersion: 1})
}

func TestManagedSourceRealSendOffNeverPrependsProxyAndStillHashes(t *testing.T) {
	entry, _ := sourceRuntimePair(t, sourceFixture(false, "off"))
	first := sourceEntryExchange(t, entry, nil)
	if first != "first:PING" && first != "second:PING" {
		t.Fatal("send off prefixed a PROXY header", first)
	}
	for n := 0; n < 4; n++ {
		if got := sourceEntryExchange(t, entry, nil); got != first {
			t.Fatal("socket source changed hash by client port", got)
		}
	}
}

func TestManagedSourceRealPerIPGateUsesAttestedClientNotProxyPeer(t *testing.T) {
	entry, _ := sourceRuntimePair(t, sourceFixture(true, "v1"), 1)
	open := func(ip string) (net.Conn, error) {
		conn, err := net.Dial("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(entry.Entries[0].ListenPort)))
		if err != nil {
			return nil, err
		}
		_ = conn.SetDeadline(time.Now().Add(time.Second))
		_, err = conn.Write(append(formatProxyProtocolV1BytesForSourceTest(ip, 32001), []byte("PING")...))
		if err == nil {
			_, err = conn.Read(make([]byte, 512))
		}
		if err != nil {
			conn.Close()
			return nil, err
		}
		t.Cleanup(func() { conn.Close() })
		return conn, nil
	}
	a, err := open("198.51.100.2")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := open("198.51.100.3"); err != nil {
		t.Fatal("different attested client shared proxy peer limit", err)
	}
	if _, err := open("198.51.100.2"); err == nil {
		t.Fatal("same attested source exceeded its limit")
	}
	_ = a.Close()
	// Wait for the completed source session to release its admission slot, then
	// establish another real session (not a fabricated gate callback).
	deadline := time.Now().Add(time.Second)
	for {
		if _, err := open("198.51.100.2"); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("source slot not released")
		}
		time.Sleep(10 * time.Millisecond)
	}
}
