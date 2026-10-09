//go:build linux

package forwarder

import (
	"fmt"
	"net"
	"testing"
)

// Linux rejects this overlapping wildcard bind, while Windows permits these
// listeners. Probe the actual Linux bind scope instead of just 127.0.0.1.
func TestWSWildcardRejectsPortOccupiedOnAnotherLoopbackAddress(t *testing.T) {
	occupied, err := net.Listen("tcp", "127.0.0.2:0")
	if err != nil {
		t.Fatal(err)
	}
	defer occupied.Close()
	port := occupied.Addr().(*net.TCPAddr).Port
	probe, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", fmt.Sprint(port)))
	if err != nil {
		t.Fatal("loopback probe must succeed while the other address owns the port", err)
	}
	if err := probe.Close(); err != nil {
		t.Fatal(err)
	}
	cfg := wsConfig(t, "127.0.0.1:9")
	cfg.IngressPort = port
	runtime, err := BuildStream(cfg, StreamBuildDeps{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = runtime.Stop() }()
	if err := runtime.Start(); err == nil {
		t.Fatal("wildcard listener must reject the port owned on 127.0.0.2")
	}
	if runtime.Running() {
		t.Fatal("a rejected wildcard bind must never be ready")
	}
}
