// Package diag implements the bounded, side-channel probes behind the
// `diagnose_tunnel` control action.
//
// What it is for: answering "which segment of this forward is not working?"
// without the operator having to guess. The panel supplies the probe list from
// the tunnel's own *authorized desired state* — never from user input — and this
// package reports what a plain TCP connect observes from the node.
//
// What it deliberately is NOT:
//
//   - not a shell: nothing here reads files, runs commands or resolves arbitrary
//     paths. The only inputs are host/port pairs the control plane already owns.
//   - not an end-to-end application test: a TCP connect proves L3/L4 reachability
//     from this node to that endpoint. It says nothing about whether the peer
//     speaks the right protocol, and it must not be reported as such.
//   - not a business-data path: the probe dials the TARGET directly, so it does
//     not traverse the tunnel's listener, does not create business connections
//     and does not enter bandwidth accounting. (Dialling the business EGRESS
//     listener would do all three, which is why the panel asks the egress node to
//     probe its own targets instead.)
//
// Everything is capped: targets, per-attempt timeout, total timeout and result
// size. A probe that can be made to run long is a denial-of-service primitive.
package diag

import (
	"context"
	"errors"
	"net"
	"strconv"
	"strings"
	"time"
)

// Hard caps. They are constants, not configuration: an operator-tunable probe
// budget is a way to turn a diagnostic into an outage.
const (
	// MaxTargets bounds one probe request.
	MaxTargets = 8
	// MaxTimeoutMS bounds the per-attempt deadline.
	MaxTimeoutMS = 5000
	// DefaultTimeoutMS is used when the request does not specify one.
	DefaultTimeoutMS = 3000
	// TotalBudgetMS bounds the whole request, whatever the individual timeouts.
	TotalBudgetMS = 15000
	// MaxDetailChars bounds the human-readable detail per result.
	MaxDetailChars = 160
)

// Status is the machine-readable outcome of one probe. The vocabulary is closed
// so the panel (and the user) never has to parse prose.
type Status string

const (
	// StatusReachable — the TCP handshake completed.
	StatusReachable Status = "reachable"
	// StatusRefused — the peer (or something in front of it) actively refused.
	StatusRefused Status = "refused"
	// StatusTimeout — no answer inside the deadline (silent drop / firewall).
	StatusTimeout Status = "timeout"
	// StatusDNSError — the name could not be resolved from this node.
	StatusDNSError Status = "dns_error"
	// StatusInvalidTarget — the spec itself was unusable (bad port/host).
	StatusInvalidTarget Status = "invalid_target"
	// StatusError — anything else, with Detail explaining it.
	StatusError Status = "error"
	// StatusUnsupported — the request asked for something this agent cannot do.
	StatusUnsupported Status = "unsupported"
)

// Target is one endpoint to probe. Host may be a name or a literal address.
type Target struct {
	Host string `json:"host"`
	Port int    `json:"port"`
}

// Request is the payload of a diagnose command.
type Request struct {
	// TimeoutMS is the per-attempt deadline; 0 means DefaultTimeoutMS.
	TimeoutMS int `json:"timeout_ms,omitempty"`
	// Targets is capped at MaxTargets; extra entries are refused, not truncated
	// silently (a probe list the caller did not ask for is a surprise).
	Targets []Target `json:"targets"`
}

// Result is the outcome of one probe, with the facts the panel renders.
type Result struct {
	Host       string `json:"host"`
	Port       int    `json:"port"`
	Status     Status `json:"status"`
	ElapsedMS  int64  `json:"elapsed_ms"`
	ResolvedIP string `json:"resolved_ip,omitempty"`
	Detail     string `json:"detail,omitempty"`
}

// DialFunc is the injectable dialer (tests substitute a fake; production uses
// the standard dialer with the same deadline).
type DialFunc func(ctx context.Context, network, address string) (net.Conn, error)

// ErrTooManyTargets is returned (as a per-request error) when the request asks
// for more probes than one command may run.
var ErrTooManyTargets = errors.New("diag: too many targets")

// Probe runs the request and always returns one result per requested target, in
// order. It never returns an error for a single unreachable endpoint: "refused"
// and "timeout" are results, not failures of the probe itself.
func Probe(ctx context.Context, req Request, dial DialFunc) ([]Result, error) {
	if len(req.Targets) == 0 {
		return []Result{}, nil
	}
	if len(req.Targets) > MaxTargets {
		return nil, ErrTooManyTargets
	}
	if dial == nil {
		dialer := &net.Dialer{}
		dial = dialer.DialContext
	}
	timeout := req.TimeoutMS
	if timeout <= 0 {
		timeout = DefaultTimeoutMS
	}
	if timeout > MaxTimeoutMS {
		timeout = MaxTimeoutMS
	}

	budget, cancel := context.WithTimeout(ctx, TotalBudgetMS*time.Millisecond)
	defer cancel()

	results := make([]Result, 0, len(req.Targets))
	for _, target := range req.Targets {
		results = append(results, probeOne(budget, target, time.Duration(timeout)*time.Millisecond, dial))
	}
	return results, nil
}

func probeOne(ctx context.Context, target Target, timeout time.Duration, dial DialFunc) Result {
	result := Result{Host: strings.TrimSpace(target.Host), Port: target.Port, Status: StatusError}
	if result.Host == "" || target.Port < 1 || target.Port > 65535 {
		result.Status = StatusInvalidTarget
		result.Detail = "host and port must describe a TCP endpoint"
		return result
	}
	if err := ctx.Err(); err != nil {
		result.Status = StatusTimeout
		result.Detail = "probe budget exhausted before this target"
		return result
	}

	address := net.JoinHostPort(result.Host, strconv.Itoa(target.Port))
	started := time.Now()

	// One deadline covers resolution AND the connect. Bounding only the dial
	// would let a hanging resolver consume the whole request budget, and a
	// "5 second probe" that can take 15 is not the bound the caller asked for.
	attempt, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	// Resolve first so a name failure is reported as a name failure instead of
	// being flattened into a generic dial error: for an operator, "DNS does not
	// resolve from this node" and "the port is closed" have different fixes.
	//
	// A literal address resolves to itself, so this is safe for IP targets.
	addrs, err := net.DefaultResolver.LookupHost(attempt, result.Host)
	if err != nil {
		result.ElapsedMS = time.Since(started).Milliseconds()
		if isTimeout(err) {
			result.Status = StatusTimeout
			result.Detail = "name resolution timed out"
			return result
		}
		result.Status = StatusDNSError
		result.Detail = detail(err)
		return result
	}
	if len(addrs) > 0 {
		result.ResolvedIP = addrs[0]
		// Dial the address we actually resolved and reported, so the result and
		// the log can never disagree about which endpoint answered.
		address = net.JoinHostPort(addrs[0], strconv.Itoa(target.Port))
	}

	conn, err := dial(attempt, "tcp", address)
	result.ElapsedMS = time.Since(started).Milliseconds()
	if err != nil {
		result.Status = classifyDialError(err)
		result.Detail = detail(err)
		return result
	}
	_ = conn.Close()
	result.Status = StatusReachable
	return result
}

// classifyDialError maps a dial failure onto the closed status vocabulary.
func classifyDialError(err error) Status {
	if isTimeout(err) {
		return StatusTimeout
	}
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return StatusDNSError
	}
	var opErr *net.OpError
	if errors.As(err, &opErr) && !opErr.Timeout() && strings.Contains(strings.ToLower(opErr.Err.Error()), "refused") {
		return StatusRefused
	}
	if opErr != nil && !opErr.Timeout() {
		// ECONNREFUSED reaches here as a syscall error on most platforms.
		if strings.Contains(strings.ToLower(err.Error()), "refused") {
			return StatusRefused
		}
	}
	return StatusError
}

func isTimeout(err error) bool {
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return true
	}
	return false
}

func detail(err error) string {
	text := err.Error()
	if len(text) > MaxDetailChars {
		text = text[:MaxDetailChars]
	}
	return text
}
