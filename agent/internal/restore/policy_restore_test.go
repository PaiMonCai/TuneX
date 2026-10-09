package restore

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/tunex/agent/internal/forwarder"
)

func TestPolicyHTTPAndCacheRestoreExecuteLimits(t *testing.T) {
	target, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer target.Close()
	go func() {
		for {
			c, err := target.Accept()
			if err != nil {
				return
			}
			go func() { defer c.Close(); _, _ = io.Copy(c, c) }()
		}
	}()
	reserve, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := reserve.Addr().(*net.TCPAddr).Port
	_ = reserve.Close()
	body := fmt.Sprintf(`{"data":{"snapshot":{"version":"policy-v1","tunnels":[{"id":"policy-restored","mode":"DIRECT","protocol":"tcp","listen_host":"127.0.0.1","ingress_port":%d,"remote_host":"127.0.0.1","remote_port":%d,"revision":3,"policy_scope":"runtime","bytes_per_second_in":8192,"bytes_per_second_out":16384,"max_connections":1,"max_connections_per_ip":1,"rate_burst_bytes":256}]}}}`, port, target.Addr().(*net.TCPAddr).Port)
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, body) }))
	defer panel.Close()
	snap, err := (HTTPSource{PanelURL: panel.URL, Credential: "test"}).FetchSnapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	cache := LKG{Path: filepath.Join(t.TempDir(), "policy.json")}
	if err := cache.Save("agent-policy", snap); err != nil {
		t.Fatal(err)
	}
	loaded, err := cache.Load("agent-policy")
	if err != nil {
		t.Fatal(err)
	}
	want, _ := json.Marshal(snap.Tunnels[0])
	got, _ := json.Marshal(loaded.Tunnels[0])
	if !bytes.Equal(want, got) {
		t.Fatal("policy lost in LKG round trip")
	}
	cfg := loaded.Tunnels[0]
	if cfg.BytesPerSecondIn != 8192 || cfg.BytesPerSecondOut != 16384 || cfg.MaxConnections != 1 || cfg.MaxConnectionsPerIP != 1 || cfg.PolicyScope != forwarder.PolicyScopeRuntime {
		t.Fatalf("wire policy lost: %+v", cfg)
	}
	f, err := forwarder.NewSingleHop(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Start(); err != nil {
		t.Fatal(err)
	}
	defer f.Stop()
	c, err := net.Dial("tcp", cfg.ListenAddr())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(3 * time.Second))
	payload := bytes.Repeat([]byte("p"), 4096)
	start := time.Now()
	_, _ = c.Write(payload)
	actual := make([]byte, len(payload))
	if _, err := io.ReadFull(c, actual); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(payload, actual) || time.Since(start) < 430*time.Millisecond {
		t.Fatal("restored runtime did not enforce rate")
	}
	second, err := net.Dial("tcp", cfg.ListenAddr())
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	_ = second.SetDeadline(time.Now().Add(300 * time.Millisecond))
	_, _ = second.Write([]byte("rejected"))
	if _, err := second.Read(make([]byte, 1)); err == nil {
		t.Fatal("restored connection ceiling was not enforced")
	} else if e, ok := err.(net.Error); ok && e.Timeout() {
		t.Fatal("restored gate did not promptly close rejected client")
	}
}

func TestPolicySnapshotBoundsAndLegacy(t *testing.T) {
	base := tunnelPayload{ID: "policy", Mode: "DIRECT", Protocol: "tcp", IngressPort: 19001, RemoteHost: "127.0.0.1", RemotePort: 80, Revision: 1}
	snap, err := decodeSnapshot("policy-v1", []tunnelPayload{base})
	if err != nil {
		t.Fatal(err)
	}
	if snap.Tunnels[0].BytesPerSecondIn != 0 || snap.Tunnels[0].MaxConnections != 0 {
		t.Fatal("absent policy changed legacy defaults")
	}
	for _, field := range []string{"bytes_per_second_in", "bytes_per_second_out", "max_connections", "max_connections_per_ip"} {
		for _, value := range []int64{-1, 2147483648} {
			wire, _ := json.Marshal(base)
			var record map[string]any
			_ = json.Unmarshal(wire, &record)
			record[field] = value
			wire, _ = json.Marshal(record)
			var payload tunnelPayload
			if err := json.Unmarshal(wire, &payload); err != nil {
				continue
			}
			if _, err := decodeSnapshot("policy-v1", []tunnelPayload{payload}); err == nil {
				t.Fatalf("invalid %s=%d restored", field, value)
			}
		}
	}
}
