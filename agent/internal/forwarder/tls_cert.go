package forwarder

import (
	"crypto/tls"
	"fmt"
	"os"
	"sync"
)

// Certificate loading for a TLS front (V5-WP5-A1, hardened after V5-G1A.6).
//
// The first implementation loaded the certificate once, when the listener was
// built. That satisfies "the node serves the certificate it was told to serve"
// only until the operator rotates it: replacing the file changed nothing,
// because the panel's hot-reload path classifies a target change as an upstream
// swap and therefore never rebuilds the listener — so no code path ever re-read
// the file. Gate V5-G1A.6 caught exactly that ("new connections are served the
// NEW certificate" failed while every other reload check passed).
//
// Rotation semantics that follow from the contract and from V4 durability:
//
//   - replacing the files is picked up by the NEXT handshake, with no config
//     revision and no listener rebuild (certificates are node-local files owned
//     by the operator; making rotation require a config change would mean a
//     credential-like operation is driven by the control plane);
//   - live connections are untouched: they keep the certificate they negotiated
//     with, which is what "a normal config update must not kill live connections"
//     means for TLS;
//   - a BROKEN replacement does not take a working tunnel down: the last good
//     certificate keeps serving and the failure is reported. That is the same
//     rule the LKG cache follows — an operator's bad write must not become a
//     customer-visible outage — and it is the reason reload errors are logged
//     rather than returned to the handshake.
type certReloader struct {
	certPath string
	keyPath  string
	// report is called when a reload is attempted and fails. Nil is silent;
	// production passes a logger so the failure is observable.
	report func(error)
	// onLoad is called with every successfully loaded pair (V5-WP5-A3), so the
	// diagnostics can report the certificate's subject, expiry and rotation count
	// without reading the file a second time.
	onLoad func(cert *tls.Certificate, rotated bool)

	mu    sync.Mutex
	cert  *tls.Certificate
	stamp fileStamp
	// loaded is false until the first successful load, so the first one is not
	// reported as a rotation.
	loaded bool
}

// fileStamp identifies the file state a loaded certificate was read from.
type fileStamp struct {
	certSize  int64
	certModNs int64
	keySize   int64
	keyModNs  int64
}

func stampOf(certPath, keyPath string) (fileStamp, error) {
	cs, err := os.Stat(certPath)
	if err != nil {
		return fileStamp{}, err
	}
	ks, err := os.Stat(keyPath)
	if err != nil {
		return fileStamp{}, err
	}
	return fileStamp{
		certSize:  cs.Size(),
		certModNs: cs.ModTime().UnixNano(),
		keySize:   ks.Size(),
		keyModNs:  ks.ModTime().UnixNano(),
	}, nil
}

// newCertReloader loads the pair once, so a bad certificate configuration fails
// at BUILD time — before any listener exists (the ordering V5-G1A.3 checks).
func newCertReloader(
	certPath, keyPath string,
	report func(error),
	onLoad func(cert *tls.Certificate, rotated bool),
) (*certReloader, error) {
	r := &certReloader{certPath: certPath, keyPath: keyPath, report: report, onLoad: onLoad}
	if err := r.reloadLocked(); err != nil {
		return nil, fmt.Errorf("forwarder: tls certificate: %w", err)
	}
	return r, nil
}

// GetCertificate is the tls.Config hook: called once per handshake, so a rotated
// file is picked up without touching the listener or the running connections.
func (r *certReloader) GetCertificate(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	stamp, err := stampOf(r.certPath, r.keyPath)
	if err == nil && stamp == r.stamp {
		return r.cert, nil
	}
	if err := r.reloadLocked(); err != nil {
		// Keep the last good certificate. A failed rotation is an operational
		// error to surface, never a reason to stop terminating TLS.
		if r.report != nil {
			r.report(err)
		}
		return r.cert, nil
	}
	return r.cert, nil
}

// reloadLocked reads the pair and remembers the stamp it was read from.
//
// The stamp is captured AFTER a successful load: taking it before would let a
// write that lands mid-read be recorded as "already seen", and the rotation
// would be silently missed until the next one.
func (r *certReloader) reloadLocked() error {
	pair, err := tls.LoadX509KeyPair(r.certPath, r.keyPath)
	if err != nil {
		return err
	}
	stamp, err := stampOf(r.certPath, r.keyPath)
	if err != nil {
		return err
	}
	r.cert = &pair
	r.stamp = stamp
	if r.onLoad != nil {
		// `rotated` distinguishes the first load (the listener starting) from a
		// genuine rotation: an operator asking "has this certificate been replaced
		// since the node started" needs the second number, not the first.
		r.onLoad(&pair, r.loaded)
	}
	r.loaded = true
	return nil
}
