package restore

import (
	"errors"
	"fmt"
)

// FetchErrorKind classifies why a desired-state fetch failed. The classification
// is the whole point: only an outage may fall back to the local cache. A
// rejected credential, a wrong identity or a malformed payload must fail closed,
// because serving stale config in those cases would keep a node running work the
// control plane has already revoked or never authorised.
type FetchErrorKind string

const (
	// FetchUnreachable: the panel could not be reached (dial/TLS/timeout) or
	// answered 5xx. This is the only kind that permits an LKG fallback.
	FetchUnreachable FetchErrorKind = "unreachable"
	// FetchUnauthorized: 401/403/404 — the credential is invalid/revoked or the
	// node is unknown. Never falls back.
	FetchUnauthorized FetchErrorKind = "unauthorized"
	// FetchBadPayload: a 2xx body that does not satisfy the snapshot contract
	// (missing data/snapshot, non-array tunnels, oversized). Never falls back:
	// an unparseable answer is not evidence of an outage.
	FetchBadPayload FetchErrorKind = "bad_payload"
)

// FetchError carries the classification plus the underlying cause.
type FetchError struct {
	Kind   FetchErrorKind
	Status int
	Err    error
}

func (e *FetchError) Error() string {
	if e == nil {
		return "restore: fetch failed"
	}
	if e.Status > 0 {
		return fmt.Sprintf("restore: %s (status %d)", e.Kind, e.Status)
	}
	return fmt.Sprintf("restore: %s", e.Kind)
}

func (e *FetchError) Unwrap() error { return e.Err }

// IsOutage reports whether err means "the panel is not answering right now".
// Everything else (auth, identity, malformed payload) is a decision the agent
// must honour, not an outage to paper over with cached state.
func IsOutage(err error) bool {
	var fe *FetchError
	return errors.As(err, &fe) && fe.Kind == FetchUnreachable
}

// MaxSnapshotBytes bounds a desired snapshot body so a broken or hostile panel
// cannot make the agent allocate without limit.
const MaxSnapshotBytes = 1 << 20 // 1 MiB

// MaxSnapshotTunnels bounds how many tunnels one node will accept. The real
// limit is policy-driven (max_tunnels); this is a transport sanity ceiling.
const MaxSnapshotTunnels = 4096
