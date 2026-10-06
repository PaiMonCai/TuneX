package forwarder

import (
	"bytes"
	"net"
	"strings"
	"testing"
	"time"
)

// Protocol diagnostics tests.
//
// The claim these must make good on: a protocol front reports FACTS about itself,
// and those facts are (a) accurate, (b) bounded and safe to ship to the panel,
// and (c) absent — not zeroed — for a protocol that has nothing to say.

func diagOf(t *testing.T, runtime StreamRuntime) (ProtocolDiagnostics, bool) {
	t.Helper()
	d, ok := runtime.(Diagnostician)
	if !ok {
		t.Fatal("every stream runtime must answer the diagnostics question")
	}
	return d.ProtocolDiagnostics()
}

// A plain TCP tunnel has no protocol-specific facts, and must not pretend
// otherwise: "no facts" and "all counters zero" are different statements.
func TestTCPRuntimeReportsNoProtocolDiagnostics(t *testing.T) {
	target, stopTarget := echoTarget(t)
	defer stopTarget()
	host, port := splitTarget(t, target)
	runtime, err := BuildStream(TunnelConfig{
		ID: "tunex-1-direct", Mode: ModeDirect, IngressPort: freePort(t),
		RemoteHost: host, RemotePort: port, Revision: 1,
	}, StreamBuildDeps{})
	if err != nil {
		t.Fatalf("BuildStream: %v", err)
	}
	if _, ok := diagOf(t, runtime); ok {
		t.Fatal("a TCP tunnel has no protocol-specific facts and must say so")
	}
}

// A TLS front reports the certificate it is actually serving, including expiry —
// the fact that turns "works today" into "known outage date".
func TestTLSDiagnosticsReportTheServedCertificate(t *testing.T) {
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

	diag, ok := diagOf(t, runtime)
	if !ok {
		t.Fatal("a TLS front must report protocol-specific facts")
	}
	if diag.Protocol != "tls" {
		t.Fatalf("protocol = %q, want tls", diag.Protocol)
	}
	// testCertFiles sets CN=127.0.0.1 and a 24h validity.
	if !strings.Contains(diag.CertSubject, "127.0.0.1") {
		t.Fatalf("cert subject = %q, want it to name the served certificate", diag.CertSubject)
	}
	if diag.CertNotAfter <= time.Now().Unix() {
		t.Fatalf("cert expiry = %d, want a future timestamp", diag.CertNotAfter)
	}
	// The first load is not a rotation.
	if diag.CertRotations != 0 {
		t.Fatalf("cert rotations = %d, want 0 before any rotation", diag.CertRotations)
	}

	// A non-TLS client is a handshake failure, counted once, with a bounded reason.
	conn, err := net.DialTimeout("tcp", cfg.ListenAddr(), 5*time.Second)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	_, _ = conn.Write([]byte("definitely not a TLS handshake\n"))
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	buf := make([]byte, 16)
	_, _ = conn.Read(buf)
	_ = conn.Close()

	deadline := time.Now().Add(5 * time.Second)
	for {
		diag, _ = diagOf(t, runtime)
		if diag.HandshakeFailures > 0 || time.Now().After(deadline) {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if diag.HandshakeFailures == 0 {
		t.Fatal("a garbage handshake must be counted as a handshake failure")
	}
	if diag.LastHandshakeError == "" || len(diag.LastHandshakeError) > diagErrMaxChars+1 {
		t.Fatalf("last handshake error must be a bounded string, got %q", diag.LastHandshakeError)
	}
	if strings.ContainsAny(diag.LastHandshakeError, "\n\r") {
		t.Fatal("a diagnostic string must not contain newlines (log forging)")
	}
	// A probe that connects and closes is NOT a handshake failure.
	before := diag.HandshakeFailures
	quiet, err := net.DialTimeout("tcp", cfg.ListenAddr(), 5*time.Second)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	_ = quiet.Close()
	time.Sleep(300 * time.Millisecond)
	diag, _ = diagOf(t, runtime)
	if diag.HandshakeFailures != before {
		t.Fatalf("a client that connects and closes must not count as a failure (%d -> %d)",
			before, diag.HandshakeFailures)
	}
}

// Rotation is visible in the diagnostics: the operator's only other signal is a
// certificate that never changes.
func TestTLSDiagnosticsCountRotations(t *testing.T) {
	target, stopTarget := echoTarget(t)
	defer stopTarget()

	certPath, keyPath := writeCertFiles(t, "diag-rotate")
	host, port := splitTarget(t, target)
	cfg := TunnelConfig{
		ID: "tunex-1-direct", Mode: ModeDirect, IngressPort: freePort(t),
		RemoteHost: host, RemotePort: port, Protocol: ProtocolTLS,
		TLSCertPath: certPath, TLSKeyPath: keyPath, Revision: 1,
	}
	runtime, err := BuildStream(cfg, StreamBuildDeps{})
	if err != nil {
		t.Fatalf("BuildStream: %v", err)
	}
	if err := runtime.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = runtime.Stop() }()

	servedCert(t, cfg.ListenAddr())
	replaceCertFiles(t, certPath, keyPath, "diag-rotate-2")
	servedCert(t, cfg.ListenAddr())

	diag, _ := diagOf(t, runtime)
	if diag.CertRotations == 0 {
		t.Fatal("a replaced certificate file must be counted as a rotation")
	}
}

// A WS front counts refused upgrades, and does NOT count them as handshake
// failures: scanners are not a misconfiguration.
func TestWSDiagnosticsCountRefusedUpgrades(t *testing.T) {
	target, stopTarget := echoTarget(t)
	defer stopTarget()

	cfg := wsConfig(t, target)
	runtime, err := BuildStream(cfg, StreamBuildDeps{HandshakeTimeout: 300 * time.Millisecond})
	if err != nil {
		t.Fatalf("BuildStream: %v", err)
	}
	if err := runtime.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = runtime.Stop() }()

	diag, ok := diagOf(t, runtime)
	if !ok || diag.Protocol != "ws" {
		t.Fatalf("a WS front must report ws diagnostics, got %+v", diag)
	}

	conn, err := net.DialTimeout("tcp", cfg.ListenAddr(), 5*time.Second)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	_, _ = conn.Write([]byte("GET / HTTP/1.1\r\nHost: x\r\n\r\n"))
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, _ = conn.Read(make([]byte, 32))
	_ = conn.Close()

	deadline := time.Now().Add(5 * time.Second)
	for {
		diag, _ = diagOf(t, runtime)
		if diag.UpgradeRefused > 0 || time.Now().After(deadline) {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if diag.UpgradeRefused == 0 {
		t.Fatal("a non-WS request must be counted as a refused upgrade")
	}
	if diag.HandshakeFailures != 0 {
		t.Fatalf("a refused upgrade is not a handshake failure, got %d", diag.HandshakeFailures)
	}
}

func TestSanitizeDiagTextBoundsAndStripsControlChars(t *testing.T) {
	long := strings.Repeat("x", 500)
	got := sanitizeDiagText(long)
	if len([]rune(got)) != diagErrMaxChars+1 { // +1 for the ellipsis
		t.Fatalf("bounded length = %d, want %d", len([]rune(got)), diagErrMaxChars+1)
	}
	if !strings.HasSuffix(got, "…") {
		t.Fatal("a truncated value must say so")
	}
	dirty := sanitizeDiagText("a\nb\tc\x00d")
	if strings.ContainsAny(dirty, "\n\t\x00") {
		t.Fatalf("control characters must be stripped, got %q", dirty)
	}
	if !bytes.ContainsRune([]byte(dirty), 'd') {
		t.Fatalf("stripping must not eat ordinary characters, got %q", dirty)
	}
}
