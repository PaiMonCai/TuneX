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

// Protocol-specific diagnostics.
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

	// ── udp (datagram) only ──
	//
	// The names below are frozen as a wire contract (the
	// panel stores the diag object as-is), so they are not free to be renamed:
	//
	//   mappings             live mappings right now
	//   mappings_expired     mappings that ended by idle timeout (cumulative)
	//   packets_in/out       client -> target / target -> client
	//   bytes_in/out         the delivered bytes of those directions
	//   drops                every accepted datagram that was NOT delivered
	//   idle_timeout_seconds the effective idle timeout this runtime is using
	//
	// They travel in this per-tunnel `diag` object on purpose: runtime_counts is
	// a CLOSED key set on the panel side, and an unknown key there makes the
	// panel reject the ENTIRE state report — telemetry, ports and health with it.
	//
	// There is deliberately NO connection count here or anywhere else for a
	// datagram tunnel: "connections" is not a smaller version of this truth, it
	// is a different (and wrong) one. `mappings` is the in-flight-work fact that
	// replaces it.
	//
	// packets_* / bytes_* / mappings_expired are CUMULATIVE FOR THIS RUNTIME and
	// reset when the agent restarts (a mapping is runtime state that is never
	// persisted, §2.2④). They are an observation of this process, never a
	// lifetime total.
	//
	// Zero values are omitted, which is the same absent-versus-empty rule the
	// rest of this struct follows: a udp tunnel's diag object is PRESENT (this
	// protocol has facts), and a counter absent inside it reads as 0 — exactly
	// how handshake_failures behaves for tls.
	Mappings           int64 `json:"mappings,omitempty"`
	MappingsExpired    int64 `json:"mappings_expired,omitempty"`
	PacketsIn          int64 `json:"packets_in,omitempty"`
	PacketsOut         int64 `json:"packets_out,omitempty"`
	BytesIn            int64 `json:"bytes_in,omitempty"`
	BytesOut           int64 `json:"bytes_out,omitempty"`

	// HopLocalAddr is the RELAY ingress's own endpoint on the hop: `ip:port` of the
	// socket it carries client mappings through for datagram relay traffic.
	//
	// It exists because that address must be LEARNED, not dictated. The exit attests
	// the paired ingress by address, and "the ingress node's address" is ambiguous the
	// moment a node is multi-homed: the hop's source address is chosen by the kernel
	// from the route, and it can be a network the panel knows nothing about. Two
	// measurements from the real topology settled it:
	//
	//   · a dual-homed ingress sent from its egress-network address while the panel had
	//     told the exit to accept its ingress-network address → every hop packet was
	//     dropped (ingress packets_in=1 / exit drops=1 and packets_in=0);
	//   · binding the source to the address the exit expects does NOT work either: the
	//     bound-source probe got no answer at all (a cross-subnet source address is
	//     dropped as a martian), so the fix cannot be "tell the ingress which source
	//     address to use".
	//
	// So the ingress publishes the endpoint and the panel hands it to the exit — exactly
	// how `next_hop` travels the other way (exit → panel → ingress). It is an ADDRESS
	// fact, never a credential: it says where the hop comes from, not who may send on it.
	HopLocalAddr string `json:"hop_local_addr,omitempty"`
	Drops              int64 `json:"drops,omitempty"`
	IdleTimeoutSeconds int64 `json:"idle_timeout_seconds,omitempty"`
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

	// ── datagram (udp) counters ──
	// One recorder per runtime, so these are the ONLY copy of the numbers: the
	// runtime's Stats() and the state report's diag are two renderings of the
	// same atomics, not two ledgers that can drift.
	mappingsCreated  atomic.Int64
	mappingsExpired  atomic.Int64
	mappingsRejected atomic.Int64

	packetsIn  atomic.Int64
	bytesIn    atomic.Int64
	packetsOut atomic.Int64
	bytesOut   atomic.Int64

	dropsUnknownSource atomic.Int64
	dropsCeiling       atomic.Int64
	dropsSendError     atomic.Int64
	dropsMalformed     atomic.Int64

	lastActivityAt atomic.Int64
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

// ── datagram facts ──────────────────────────────────────────────────────────
//
// Each note* method is called from exactly one place in datagram.go, next to the
// event it records. Counting at the event — and only on the delivered side — is
// what makes these numbers answer "what did this tunnel actually do", not "what
// did it see".

func (d *diagRecorder) noteMappingCreated() { d.mappingsCreated.Add(1) }

func (d *diagRecorder) noteMappingsExpired(n int) {
	if n <= 0 {
		return
	}
	d.mappingsExpired.Add(int64(n))
}

// noteMappingRejected records one datagram that would have created a mapping but
// the ceiling refused it. It is a per-datagram count because the runtime has no
// bounded way to remember "I already refused this source" — remembering would be
// the very unbounded state the ceiling exists to prevent (§2.4). Whether a
// single client got unlucky or a scan is hitting the listener is exactly the
// distinction drops_ceiling + mappings_rejected are here to make observable
// agent-side; the wire carries their sum in `drops`.
func (d *diagRecorder) noteMappingRejected() {
	d.mappingsRejected.Add(1)
	d.dropsCeiling.Add(1)
}

// noteDatagramDeliveredToTarget counts a client → target datagram that the
// target socket really accepted.
func (d *diagRecorder) noteDatagramDeliveredToTarget(bytes int) {
	d.packetsIn.Add(1)
	d.bytesIn.Add(int64(bytes))
	d.lastActivityAt.Store(time.Now().Unix())
}

// noteDatagramDeliveredToClient counts a target → client datagram that the
// ingress socket really sent.
func (d *diagRecorder) noteDatagramDeliveredToClient(bytes int) {
	d.packetsOut.Add(1)
	d.bytesOut.Add(int64(bytes))
	d.lastActivityAt.Store(time.Now().Unix())
}

// noteUnknownSource records a datagram from a client address with no mapping
// while the runtime refuses to create new ones (drain / close-listener). The
// packets are dropped on purpose: admitting them would mean the "stop taking new
// work" phase was not real.
func (d *diagRecorder) noteUnknownSource() { d.dropsUnknownSource.Add(1) }

// noteDatagramSendError records a datagram that could not be delivered: the
// mapping's socket to the target refused the write (unresolvable target, an
// unreachable network, a full send buffer). UDP gives no synchronous signal for
// an unreachable peer, so this is the honest count of "we could not send it",
// never a claim that the peer received anything.
func (d *diagRecorder) noteDatagramSendError() { d.dropsSendError.Add(1) }

// noteDatagramMalformed records a datagram the runtime could not read or key at
// all. It is defensive: payload bytes are opaque here, so a datagram with
// garbage CONTENT is forwarded rather than counted here.
func (d *diagRecorder) noteDatagramMalformed() { d.dropsMalformed.Add(1) }

// datagramDrops is the single wire total behind the four classified reasons.
func (d *diagRecorder) datagramDrops() int64 {
	return d.dropsUnknownSource.Load() + d.dropsCeiling.Load() +
		d.dropsSendError.Load() + d.dropsMalformed.Load()
}

// datagramStats renders the same atomics for the runtime's structured Stats().
// activeMappings is the live table size, which lives in the runtime (the
// recorder owns counters, never the mapping table itself).
func (d *diagRecorder) datagramStats(activeMappings int64) DatagramStats {
	return DatagramStats{
		Mappings:           activeMappings,
		MappingsCreated:    d.mappingsCreated.Load(),
		MappingsExpired:    d.mappingsExpired.Load(),
		MappingsRejected:   d.mappingsRejected.Load(),
		PacketsIn:          d.packetsIn.Load(),
		BytesIn:            d.bytesIn.Load(),
		PacketsOut:         d.packetsOut.Load(),
		BytesOut:           d.bytesOut.Load(),
		Drops:              d.datagramDrops(),
		DropsUnknownSource: d.dropsUnknownSource.Load(),
		DropsCeiling:       d.dropsCeiling.Load(),
		DropsSendError:     d.dropsSendError.Load(),
		DropsMalformed:     d.dropsMalformed.Load(),
		LastActivityAt:     d.lastActivityAt.Load(),
	}
}

// ProtocolDiagnostics renders the counters for one protocol front.
//
// Mappings and IdleTimeoutSeconds are left at their zero value here on purpose:
// neither is a counter. The live mapping count lives in the runtime's locked
// mapping table and the idle timeout is configuration, so the datagram runtime
// that owns both fills them in (DatagramForwarder.ProtocolDiagnostics). A bare
// recorder cannot invent either, and reporting 0 mappings by default would be
// exactly the "unknown said as zero" failure this channel exists to prevent.
func (d *diagRecorder) ProtocolDiagnostics() ProtocolDiagnostics {
	out := ProtocolDiagnostics{
		Protocol:             string(d.protocol),
		HandshakeFailures:    d.handshakeFailures.Load(),
		UpgradeRefused:       d.upgradeRefused.Load(),
		CertRotations:        d.certRotations.Load(),
		CertNotAfter:         d.certNotAfter.Load(),
		LastHandshakeErrorAt: d.lastHandshakeErrAt.Load(),

		MappingsExpired: d.mappingsExpired.Load(),
		PacketsIn:       d.packetsIn.Load(),
		PacketsOut:      d.packetsOut.Load(),
		BytesIn:         d.bytesIn.Load(),
		BytesOut:        d.bytesOut.Load(),
		Drops:           d.datagramDrops(),
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
