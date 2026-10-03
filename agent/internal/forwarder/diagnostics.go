package forwarder

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"io"
	"net"
	"sync/atomic"
	"time"
)

// Protocol-specific diagnostics (V5-WP5-A3).
//
// TCP has nothing protocol-specific to say about a healthy tunnel: bytes moved,
// or they did not. TLS and WebSocket do, and the two facts an operator actually
// needs when a front misbehaves are exactly the ones a generic "bytes in / bytes
// out" view cannot show:
//
//   - **when does the certificate expire**, and is it still the one that was
//     installed: the failure mode is a tunnel that works today and takes a
//     client-visible outage in a week;
//   - **why are clients being refused**: failed handshakes and refused upgrades
//     are normal traffic from scanners and probes, but a rising rate is the first
//     symptom of a misconfigured client or a rotation that did not land.
//
// Everything here is a fact the runtime observed about itself. The counts live in
// the runtime that saw the events and travel on the existing state report; the
// panel infers nothing and keeps no second copy.
//
// Redaction (§14): every string here is produced by this package from paths and
// standard-library errors. No key material, no payload bytes, no client data —
// a diagnostic that leaks the thing it is diagnosing is worse than none.
type ProtocolDiagnostics struct {
	// The front this tunnel terminates: tcp / tls / ws.
	Protocol string `json:"protocol"`
	// Terminal handshake failures (TLS negotiation, WS upgrade). A non-zero
	// number is normal; a change in RATE is the signal.
	HandshakeFailures int64 `json:"handshake_failures,omitempty"`
	// The most recent handshake failure, bounded and redacted.
	LastHandshakeError string `json:"last_handshake_error,omitempty"`
	// Unix seconds of that failure (0 = never).
	LastHandshakeErrorAt int64 `json:"last_handshake_error_at,omitempty"`

	// ── tls only ──
	// The certificate currently being served, as a client would see it.
	CertSubject string `json:"cert_subject,omitempty"`
	// Certificate expiry, unix seconds. The single most useful TLS fact: a tunnel
	// that works today and stops working on a known date is an outage the
	// operator can still prevent.
	CertNotAfter int64 `json:"cert_not_after,omitempty"`
	// How many times the certificate was re-read because the files changed.
	CertRotations int64 `json:"cert_rotations,omitempty"`
	// The most recent rotation failure. The tunnel keeps serving the last good
	// certificate, so this string is the only signal that a rotation did not land.
	CertLastReloadError string `json:"cert_last_reload_error,omitempty"`

	// ── ws only ──
	// Connections that were not a WebSocket client (plain HTTP, scanners,
	// garbage). Counted apart from handshake failures because it is usually NOT a
	// fault: every listener gets these.
	UpgradeRefused int64 `json:"upgrade_refused,omitempty"`
}

// diagErrMaxChars bounds a diagnostic string before it leaves the process. The
// bound is deliberate: these values travel to the panel and into support bundles,
// and a diagnostic field must not become a log-flooding or log-forging vector.
const diagErrMaxChars = 200

// diagRecorder accumulates what one runtime observed.
//
// A plain TCP tunnel keeps a zero recorder and does NOT implement
// Diagnostician, which is how "this protocol has no facts" stays distinguishable
// from "all counters are zero" — the same absent-versus-empty rule the panel's
// capability facts follow.
type diagRecorder struct {
	protocol ForwardProtocol

	handshakeFailures  atomic.Int64
	lastHandshakeErr   atomic.Pointer[string]
	lastHandshakeErrAt atomic.Int64

	upgradeRefused atomic.Int64

	certRotations     atomic.Int64
	certLastReloadErr atomic.Pointer[string]
	certSubject       atomic.Pointer[string]
	certNotAfter      atomic.Int64
}

func (d *diagRecorder) noteHandshakeFailure(err error) {
	if err == nil {
		return
	}
	d.handshakeFailures.Add(1)
	msg := sanitizeDiagText(err.Error())
	d.lastHandshakeErr.Store(&msg)
	d.lastHandshakeErrAt.Store(time.Now().Unix())
}

func (d *diagRecorder) noteUpgradeRefused() { d.upgradeRefused.Add(1) }

func (d *diagRecorder) noteCertLoaded(cert *tls.Certificate, rotated bool) {
	if rotated {
		d.certRotations.Add(1)
	}
	if cert == nil || len(cert.Certificate) == 0 {
		return
	}
	leaf, err := x509.ParseCertificate(cert.Certificate[0])
	if err != nil {
		// An unparseable leaf is not a reason to lose the rotation count; only the
		// descriptive facts are skipped.
		return
	}
	subject := sanitizeDiagText(leaf.Subject.String())
	d.certSubject.Store(&subject)
	d.certNotAfter.Store(leaf.NotAfter.Unix())
}

func (d *diagRecorder) noteCertReloadError(err error) {
	if err == nil {
		return
	}
	msg := sanitizeDiagText(err.Error())
	d.certLastReloadErr.Store(&msg)
}

// ProtocolDiagnostics renders the counters for one protocol front.
func (d *diagRecorder) ProtocolDiagnostics() ProtocolDiagnostics {
	out := ProtocolDiagnostics{
		Protocol:             string(d.protocol),
		HandshakeFailures:    d.handshakeFailures.Load(),
		UpgradeRefused:       d.upgradeRefused.Load(),
		CertRotations:        d.certRotations.Load(),
		CertNotAfter:         d.certNotAfter.Load(),
		LastHandshakeErrorAt: d.lastHandshakeErrAt.Load(),
	}
	if p := d.lastHandshakeErr.Load(); p != nil {
		out.LastHandshakeError = *p
	}
	if p := d.certLastReloadErr.Load(); p != nil {
		out.CertLastReloadError = *p
	}
	if p := d.certSubject.Load(); p != nil {
		out.CertSubject = *p
	}
	return out
}

// sanitizeDiagText bounds and cleans a diagnostic string.
func sanitizeDiagText(s string) string {
	out := make([]rune, 0, len(s))
	for _, r := range s {
		// Control characters (newlines included) are dropped: a diagnostic field
		// is one line, and a value that can break the log format is a forging
		// vector.
		if r < 0x20 || r == 0x7f {
			continue
		}
		out = append(out, r)
		if len(out) >= diagErrMaxChars {
			return string(out) + "…"
		}
	}
	return string(out)
}

// Diagnostician is implemented by every stream runtime, and answers whether it
// has protocol-specific facts at all.
//
// The bool is the whole absent-versus-empty rule in one place: a plain TCP tunnel
// returns `false` ("this protocol has nothing to say"), while a TLS front with no
// failures yet returns `true` with zero counts ("nothing went wrong yet"). A
// caller that collapses the two would render "unknown" as "healthy".
type Diagnostician interface {
	ProtocolDiagnostics() (ProtocolDiagnostics, bool)
}

// observedConn records what happens on the first read of a front-terminated
// connection.
//
// TLS negotiates on the first read, so a failed handshake surfaces exactly there.
// Counting it there — rather than handshaking eagerly in the accept loop, which
// would let one slow client stall every other connection — is this wrapper's
// whole purpose.
type observedConn struct {
	net.Conn
	diag      *diagRecorder
	firstName atomic.Bool
}

func (c *observedConn) Read(p []byte) (int, error) {
	n, err := c.Conn.Read(p)
	if err != nil && c.firstName.CompareAndSwap(false, true) && isHandshakeFailure(err) {
		c.diag.noteHandshakeFailure(err)
	}
	return n, err
}

// isHandshakeFailure distinguishes "this client did not manage to speak TLS" from
// "this client went away".
//
// EOF is explicitly not a failure: probes and port scanners connect and close
// constantly, and counting them would drown the signal the count exists for.
func isHandshakeFailure(err error) bool {
	if err == nil || errors.Is(err, io.EOF) {
		return false
	}
	return true
}
