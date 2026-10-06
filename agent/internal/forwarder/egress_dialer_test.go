package forwarder

import (
	"context"
	"fmt"
	"io"
	"net"
	"sync"
	"testing"
	"time"
)

// The egress data plane must dial through the injected dialer, because
// a wired-but-unused injection is the exact failure this project has already paid
// for twice (the health facts, the tls cert paths). The behaviour of the injected
// dialer itself — TTL cache, stale fallback, "a DNS change never kills an
// established connection" — is proven in internal/targetdns; what is pinned here
// is that the egress forwarder really uses it.

type recordingDialer struct {
	mu      sync.Mutex
	calls   []string
	network []string
	inner   *net.Dialer
}

func (d *recordingDialer) Dial(ctx context.Context, network, address string) (net.Conn, error) {
	d.mu.Lock()
	d.calls = append(d.calls, address)
	d.network = append(d.network, network)
	d.mu.Unlock()
	inner := d.inner
	if inner == nil {
		inner = &net.Dialer{Timeout: 5 * time.Second}
	}
	return inner.DialContext(ctx, network, address)
}

func (d *recordingDialer) dialed() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]string(nil), d.calls...)
}

func TestEgressForwarderDialsThroughTheInjectedDialer(t *testing.T) {
	up, stopUp := echoTarget(t)
	defer stopUp()
	_, upPortS, _ := net.SplitHostPort(up)
	var upPort int
	fmt.Sscanf(upPortS, "%d", &upPort)

	dialer := &recordingDialer{}
	sel := &countingSelector{seq: []Target{{Host: "127.0.0.1", Port: upPort}}}
	port := freePort(t)
	f, err := NewEgressWithOptions(TunnelConfig{
		ID: "e-dial", Mode: ModeEgress, EgressPort: port, Protocol: "tcp", ListenHost: "127.0.0.1",
	}, sel, EgressOptions{Dial: dialer.Dial})
	if err != nil {
		t.Fatalf("NewEgressWithOptions: %v", err)
	}
	if err := f.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer f.Stop()

	conn, err := dialRetry(t, fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	if _, err := conn.Write([]byte("via-dialer")); err != nil {
		t.Fatalf("write: %v", err)
	}
	conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	buf := make([]byte, len("via-dialer"))
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatalf("read echo: %v", err)
	}

	got := dialer.dialed()
	if len(got) != 1 || got[0] != up {
		t.Fatalf("injected dialer saw %v, want exactly [%s]", got, up)
	}
	if dialer.network[0] != "tcp" {
		t.Fatalf("network = %q, want tcp", dialer.network[0])
	}
}

func TestEgressForwarderDefaultsToGoDialerWhenUninjected(t *testing.T) {
	up, stopUp := echoTarget(t)
	defer stopUp()
	_, upPortS, _ := net.SplitHostPort(up)
	var upPort int
	fmt.Sscanf(upPortS, "%d", &upPort)

	// The default path has no injected resolver. It must keep working exactly as it
	// did, which is what makes the resolver an addition rather than a
	// replacement.
	sel := &countingSelector{seq: []Target{{Host: "127.0.0.1", Port: upPort}}}
	port := freePort(t)
	f, err := NewEgress(TunnelConfig{
		ID: "e-default", Mode: ModeEgress, EgressPort: port, Protocol: "tcp", ListenHost: "127.0.0.1",
	}, sel)
	if err != nil {
		t.Fatalf("NewEgress: %v", err)
	}
	if err := f.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer f.Stop()

	conn, err := dialRetry(t, fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	if _, err := conn.Write([]byte("ok")); err != nil {
		t.Fatalf("write: %v", err)
	}
	conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	buf := make([]byte, 2)
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatalf("read echo: %v", err)
	}
}
