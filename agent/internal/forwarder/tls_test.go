package forwarder

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// V5-WP5-A1 TLS stream runtime tests.
//
// The claim these tests have to make good on is "TLS is a stream runtime": the
// listener is TLS, and EVERYTHING else — accept loop, per-connection pipe, port
// guard, drain, stats, hot reload — is the same code. So the tests check both
// halves: the handshake really happens, and the stream lifecycle really is
// unchanged on top of it.

// testCertFiles writes a freshly generated self-signed certificate and key into
// a temp dir and returns their paths.
//
// Generating instead of committing a fixture is deliberate: a private key in the
// repository would be picked up by secret scanning (correctly), would have to be
// rotated, and would teach the wrong habit. The files are also the only way to
// exercise the real `tls.LoadX509KeyPair` path that production uses.
func testCertFiles(t *testing.T, host string) (certPath, keyPath string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	tmpl := x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: host},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IPAddresses:           []net.IP{net.ParseIP(host)},
		IsCA:                  true,
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("create certificate: %v", err)
	}
	dir := t.TempDir()
	certPath = filepath.Join(dir, "site.crt")
	keyPath = filepath.Join(dir, "site.key")

	certOut, err := os.Create(certPath)
	if err != nil {
		t.Fatalf("create cert file: %v", err)
	}
	if err := pem.Encode(certOut, &pem.Block{Type: "CERTIFICATE", Bytes: der}); err != nil {
		t.Fatalf("encode cert: %v", err)
	}
	_ = certOut.Close()

	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatalf("marshal key: %v", err)
	}
	keyOut, err := os.Create(keyPath)
	if err != nil {
		t.Fatalf("create key file: %v", err)
	}
	if err := pem.Encode(keyOut, &pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}); err != nil {
		t.Fatalf("encode key: %v", err)
	}
	_ = keyOut.Close()
	return certPath, keyPath
}

func tlsDirectConfig(t *testing.T, target string) TunnelConfig {
	t.Helper()
	host, port := splitTarget(t, target)
	certPath, keyPath := testCertFiles(t, "127.0.0.1")
	return TunnelConfig{
		ID:          "tunex-1-direct",
		Mode:        ModeDirect,
		IngressPort: freePort(t),
		RemoteHost:  host,
		RemotePort:  port,
		Protocol:    ProtocolTLS,
		TLSCertPath: certPath,
		TLSKeyPath:  keyPath,
		Revision:    1,
	}
}

func splitTarget(t *testing.T, addr string) (string, int) {
	t.Helper()
	host, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		t.Fatalf("split %q: %v", addr, err)
	}
	var port int
	if _, err := fmt.Sscanf(portStr, "%d", &port); err != nil {
		t.Fatalf("parse port %q: %v", portStr, err)
	}
	return host, port
}

// A TLS client really completes a handshake against the tunnel listener, and the
// bytes it sends come back from the target — i.e. TLS terminators at the ingress
// listener and the decrypted stream is forwarded like any other TCP tunnel.
func TestTLSDirectTerminatesAndForwards(t *testing.T) {
	target, stopTarget := echoTarget(t)
	defer stopTarget()

	cfg := tlsDirectConfig(t, target)
	runtime, err := BuildStream(cfg, StreamBuildDeps{})
	if err != nil {
		t.Fatalf("BuildStream: %v", err)
	}
	if err := runtime.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = runtime.Stop() }()

	raw, err := tls.Dial("tcp", cfg.ListenAddr(), &tls.Config{InsecureSkipVerify: true})
	if err != nil {
		t.Fatalf("tls dial: %v", err)
	}
	defer func() { _ = raw.Close() }()
	_ = raw.SetDeadline(time.Now().Add(10 * time.Second))

	msg := []byte("tls-through-forwarder")
	if _, err := raw.Write(msg); err != nil {
		t.Fatalf("write: %v", err)
	}
	got := make([]byte, len(msg))
	if _, err := io.ReadFull(raw, got); err != nil {
		t.Fatalf("read echo: %v", err)
	}
	if string(got) != string(msg) {
		t.Fatalf("echo = %q, want %q", got, msg)
	}
	if !runtime.Running() {
		t.Fatal("a served connection must not stop the listener")
	}
	// The stream lifecycle is unchanged: stats count the bytes actually moved.
	if runtime.Stats() == 0 {
		t.Fatal("Stats must count the bytes forwarded over the TLS front")
	}
}

// A plain-TCP client (or a garbage handshake) must not take the listener down:
// it fails to negotiate TLS, and the tunnel keeps serving real clients after.
func TestTLSRejectsNonTLSClientAndKeepsServing(t *testing.T) {
	target, stopTarget := echoTarget(t)
	defer stopTarget()

	cfg := tlsDirectConfig(t, target)
	runtime, err := BuildStream(cfg, StreamBuildDeps{})
	if err != nil {
		t.Fatalf("BuildStream: %v", err)
	}
	if err := runtime.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = runtime.Stop() }()

	// Garbage instead of a ClientHello.
	conn, err := net.DialTimeout("tcp", cfg.ListenAddr(), 5*time.Second)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	_, _ = conn.Write([]byte("this is not a TLS handshake\n"))
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := conn.Read(make([]byte, 16)); err == nil {
		t.Fatal("a non-TLS client must not get a usable stream")
	}
	_ = conn.Close()

	if !runtime.Running() {
		t.Fatal("a failed handshake must not take the listener down")
	}

	// ... and a real client still works afterwards.
	client, err := tls.Dial("tcp", cfg.ListenAddr(), &tls.Config{InsecureSkipVerify: true})
	if err != nil {
		t.Fatalf("tls dial after the bad client: %v", err)
	}
	defer func() { _ = client.Close() }()
	_ = client.SetDeadline(time.Now().Add(10 * time.Second))
	if _, err := client.Write([]byte("still-alive")); err != nil {
		t.Fatalf("write after the bad client: %v", err)
	}
	got := make([]byte, len("still-alive"))
	if _, err := io.ReadFull(client, got); err != nil {
		t.Fatalf("read after the bad client: %v", err)
	}
}

// Hot reload is the stream lifecycle, so it must work unchanged on a TLS front:
// the listener is not rebuilt, only the upstream the NEXT connection dials.
func TestTLSHotReloadSwapsUpstreamWithoutRebuildingListener(t *testing.T) {
	first, stopFirst := echoTarget(t)
	defer stopFirst()
	second, stopSecond := echoTarget(t)
	defer stopSecond()

	cfg := tlsDirectConfig(t, first)
	runtime, err := BuildStream(cfg, StreamBuildDeps{})
	if err != nil {
		t.Fatalf("BuildStream: %v", err)
	}
	if err := runtime.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = runtime.Stop() }()

	swappable, ok := runtime.(interface{ SetUpstream(string) error })
	if !ok {
		t.Fatal("a TLS front must still be a stream runtime with SetUpstream")
	}
	host, port := splitTarget(t, second)
	if err := swappable.SetUpstream(net.JoinHostPort(host, fmt.Sprint(port))); err != nil {
		t.Fatalf("SetUpstream: %v", err)
	}

	conn, err := tls.Dial("tcp", cfg.ListenAddr(), &tls.Config{InsecureSkipVerify: true})
	if err != nil {
		t.Fatalf("tls dial after the swap: %v", err)
	}
	defer func() { _ = conn.Close() }()
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
	if _, err := conn.Write([]byte("after-swap")); err != nil {
		t.Fatalf("write: %v", err)
	}
	got := make([]byte, len("after-swap"))
	if _, err := io.ReadFull(conn, got); err != nil {
		t.Fatalf("read: %v", err)
	}
}

// Drain is the stream lifecycle too: a TLS tunnel must stop taking new work
// while the listener stays bound (the port stays reserved for whoever owns it
// next).
//
// The probe is deliberately bounded. A drained tunnel ends its accept loop but
// leaves the listener bound, so a new TCP connect still succeeds at the kernel
// level (the connection lands in the backlog, on purpose — that backlog is what
// the next owner inherits). What must NOT happen is a completed TLS handshake,
// so the assertion is made with an explicit deadline instead of a bare Dial that
// would wait forever for an accept nobody performs.
func TestTLSDrainStopsAcceptingNewConnections(t *testing.T) {
	target, stopTarget := echoTarget(t)
	defer stopTarget()

	cfg := tlsDirectConfig(t, target)
	runtime, err := BuildStream(cfg, StreamBuildDeps{})
	if err != nil {
		t.Fatalf("BuildStream: %v", err)
	}
	if err := runtime.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = runtime.Stop() }()

	start := time.Now()
	if err := runtime.Drain(50 * time.Millisecond); err != nil {
		t.Fatalf("Drain: %v", err)
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("an idle drain took %v (it must be bounded)", elapsed)
	}
	if !runtime.Running() {
		t.Fatal("a drained tunnel keeps its listener bound (the port stays reserved)")
	}

	raw, err := net.DialTimeout("tcp", cfg.ListenAddr(), 3*time.Second)
	if err != nil {
		// Connection refused is an equally valid outcome: drain may end the
		// listener's ability to complete a connect in some environments.
		return
	}
	defer func() { _ = raw.Close() }()
	_ = raw.SetDeadline(time.Now().Add(3 * time.Second))
	client := tls.Client(raw, &tls.Config{InsecureSkipVerify: true})
	if err := client.Handshake(); err == nil {
		t.Fatal("a drained tunnel must not complete a new TLS handshake")
	}
}
