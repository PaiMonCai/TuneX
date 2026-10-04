package ownership

import "time"

// ParseDeadline parses the panel's `lease_expires_at`.
//
// It accepts exactly the shape a JavaScript `Date.toISOString()` produces
// (RFC 3339 with milliseconds and a `Z`), plus an explicit numeric offset and
// the no-fraction form, because the panel's serializer is the panel's business
// and all three are the same instant.
//
// Anything else is NOT guessed at: an unreadable deadline means this node cannot
// know how long it may serve, and the caller fails closed (Refusal
// malformed_lease) rather than substituting "forever" or "now".
func ParseDeadline(raw string) (time.Time, bool) {
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339} {
		if t, err := time.Parse(layout, raw); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}
