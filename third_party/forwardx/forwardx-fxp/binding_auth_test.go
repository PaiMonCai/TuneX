package main

import (
	"encoding/json"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

func TestBindingAuthorizationRejectsValidKeyWithForgedTarget(t *testing.T) {
	cfg := config{Role: "exit", TunnelID: 71, Key: "tunex-fixture-carrier-key", RequireBindingAuth: true, AllowedBindings: []authorizedBinding{{RuleID: 101, Protocol: "tcp", TargetIP: "127.0.0.1", TargetPort: 443}}}
	for _, hello := range []helloFrame{
		{TunnelID: 71, RuleID: 101, Network: "tcp", TargetIP: "127.0.0.1", TargetPort: 444},
		{TunnelID: 71, RuleID: 102, Network: "tcp", TargetIP: "127.0.0.1", TargetPort: 443},
		{TunnelID: 72, RuleID: 101, Network: "tcp", TargetIP: "127.0.0.1", TargetPort: 443},
		{TunnelID: 71, RuleID: 101, Network: "udp", TargetIP: "127.0.0.1", TargetPort: 443},
	} {
		client, server := net.Pipe()
		finished := make(chan error, 1)
		go func() { finished <- handleExitSession(server, cfg) }()
		sec, err := newEntrySecureConn(client, cfg)
		if err != nil {
			t.Fatal(err)
		}
		payload, _ := json.Marshal(hello)
		if err = writeSecureHello(sec, payload); err != nil {
			t.Fatal(err)
		}
		select {
		case err = <-finished:
			if err == nil || !strings.Contains(err.Error(), "unauthorized") {
				t.Fatalf("valid-key forged hello accepted: %v", err)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("authorization did not terminate")
		}
		client.Close()
	}
}

func TestAuthorizedBindingCarriesEncryptedTCPPayload(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		conn, err := ln.Accept()
		if err == nil {
			defer conn.Close()
			payload := make([]byte, len("shared-link-payload"))
			if _, err := io.ReadFull(conn, payload); err == nil {
				_, _ = conn.Write(payload)
			}
		}
	}()
	port := ln.Addr().(*net.TCPAddr).Port
	cfg := config{Role: "exit", TunnelID: 73, Key: "tunex-fixture-carrier-key", RequireBindingAuth: true, AllowedBindings: []authorizedBinding{{RuleID: 103, Protocol: "tcp", TargetIP: "127.0.0.1", TargetPort: port}}}
	client, server := net.Pipe()
	defer client.Close()
	finished := make(chan error, 1)
	go func() { finished <- handleExitSession(server, cfg) }()
	sec, err := newEntrySecureConn(client, cfg)
	if err != nil {
		t.Fatal(err)
	}
	client.SetDeadline(time.Now().Add(3 * time.Second))
	hello, _ := json.Marshal(helloFrame{TunnelID: 73, RuleID: 103, Network: "tcp"})
	if err = writeSecureHello(sec, hello); err != nil {
		t.Fatal(err)
	}
	if err = sec.writeFrame([]byte("shared-link-payload")); err != nil {
		t.Fatal(err)
	}
	got, err := sec.readFrame()
	if err != nil || string(got) != "shared-link-payload" {
		t.Fatalf("encrypted payload = %q, %v", got, err)
	}
	client.Close()
	select {
	case <-finished:
	case <-time.After(4 * time.Second):
		t.Fatal("exit did not close")
	}
}

func TestBindingPolicyRejectsUDPMapOutsideAuthorizedRules(t *testing.T) {
	cfg := config{Role: "exit", TunnelID: 71, RequireBindingAuth: true, AllowedBindings: []authorizedBinding{{RuleID: 101, Protocol: "tcp", TargetIP: "127.0.0.1", TargetPort: 443}}, UDPTargets: []udpTarget{{RuleID: 101, TargetIP: "127.0.0.1", TargetPort: 443}}}
	if validateBindingPolicy(cfg) == nil {
		t.Fatal("unauthorized UDP target accepted")
	}
	cfg.UDPTargets = nil
	cfg.AllowedBindings = nil
	if err := validateBindingPolicy(cfg); err != nil {
		t.Fatalf("zero-binding carrier must remain configurable: %v", err)
	}
}
