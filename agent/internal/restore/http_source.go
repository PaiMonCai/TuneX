package restore

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// HTTPSource fetches the node's canonical desired state over the same outbound
// per-node credential the command loop uses.
//
// It is strict on purpose:
//
//   - a transport failure or 5xx is an OUTAGE (the only fallback-eligible case);
//   - 401/403/404 is an AUTHORIZATION failure: the credential or the node
//     identity is no good, and cached state must not be served;
//   - a 2xx body that does not carry `data.snapshot` as an object is a BAD
//     PAYLOAD. An explicitly empty tunnel list is authoritative "nothing runs
//     here"; a *missing* snapshot key is a contract violation, and the two must
//     never be conflated — conflating them is how a node silently drops every
//     listener while the panel is merely misbehaving.
type HTTPSource struct {
	PanelURL   string
	Credential string
	Client     *http.Client
	// MaxBytes overrides MaxSnapshotBytes (tests use a small value).
	MaxBytes int64
}

// desiredEnvelope decodes the panel's response with the tunnels slice behind a
// pointer: nil means "the key was absent" (bad payload), while a pointer to an
// empty slice means "this node has no desired tunnels" (valid).
type desiredEnvelope struct {
	Data *struct {
		Snapshot *struct {
			Version string           `json:"version"`
			Tunnels *[]tunnelPayload `json:"tunnels"`
		} `json:"snapshot"`
	} `json:"data"`
}

// tunnelPayload mirrors forwarder.TunnelConfig's wire shape, but keeping it
// local lets the decoder demand the fields the contract requires.
type tunnelPayload struct {
	ID          string `json:"id"`
	Mode        string `json:"mode"`
	IngressPort int    `json:"ingress_port"`
	EgressPort  int    `json:"egress_port"`
	RemoteHost  string `json:"remote_host"`
	RemotePort  int    `json:"remote_port"`
	NextHop     string `json:"next_hop"`
	Targets     []struct {
		Host   string `json:"host"`
		Port   int    `json:"port"`
		Weight int    `json:"weight"`
		Order  int    `json:"order"`
		Remark string `json:"remark"`
	} `json:"targets"`
	LBStrategy string `json:"lb_strategy"`
	Protocol   string `json:"protocol"`
	SpeedLimit int64  `json:"speed_limit"`
	Revision   int64  `json:"revision"`
	ListenHost string `json:"listen_host"`
	// The TLS front's certificate paths. They MUST be decoded here: this payload
	// is the desired-state snapshot an Agent pulls after every restart, and a
	// decoder that drops them turns a working tls Forward into an unbuildable
	// one; omitting them would leave the listener unable to recover after a
	// node restart while create and hot reload were fine).
	TLSCertPath string `json:"tls_cert_path"`
	TLSKeyPath  string `json:"tls_key_path"`
	// Ownership facts. They MUST be decoded here for the fourth
	// delivery path as protocol, TLS paths, and health; this
	// payload is what an Agent rebuilds from after every restart, and a decoder
	// that drops the epoch resets the "highest seen" to nothing — so a demoted
	// node that restarts during a partition would happily serve again. The
	// deadline matters just as much: without it a restored tunnel has no lease
	// clock and would keep serving past the authorisation the panel granted.
	//
	// Absent means "the panel sent no ownership information" (an older panel),
	// and the Agent then behaves as an unfenced assignment.
	OwnershipEpoch int64  `json:"ownership_epoch"`
	LeaseExpiresAt string `json:"lease_expires_at"`

	// Health facts travel with the desired targets.
	//
	// They MUST be decoded here whenever a new fact
	// needed adding on a second path (the protocol, then the tls paths, now health):
	// this payload is what an Agent rebuilds from after every restart, so a decoder
	// that drops the field turns a working circuit breaker into a silent 50/50 split
	// onto a target the panel already called unhealthy — which is precisely what
	// A missing decoder here would silently drop health after restart.
	TargetHealth []targetHealthPayload `json:"target_health"`
}

// targetHealthPayload is one entry of the parallel health array.
type targetHealthPayload struct {
	Host      string `json:"host"`
	Port      int    `json:"port"`
	State     string `json:"state"`
	LatencyMS *int64 `json:"latency_ms"`
	AgeMS     *int64 `json:"age_ms"`
	Evidence  bool   `json:"evidence"`
}

// FetchSnapshot implements Source with the strict classification above.
func (s HTTPSource) FetchSnapshot(ctx context.Context) (*Snapshot, error) {
	base := strings.TrimRight(strings.TrimSpace(s.PanelURL), "/")
	cred := strings.TrimSpace(s.Credential)
	if base == "" || cred == "" {
		return nil, ErrNoPanel
	}
	client := s.Client
	if client == nil {
		client = &http.Client{Timeout: FetchTimeout}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/api/internal/node/desired", nil)
	if err != nil {
		return nil, &FetchError{Kind: FetchBadPayload, Err: err}
	}
	req.Header.Set("Authorization", "Bearer "+cred)
	resp, err := client.Do(req)
	if err != nil {
		return nil, &FetchError{Kind: FetchUnreachable, Err: err}
	}
	defer resp.Body.Close()

	switch {
	case resp.StatusCode >= 500:
		return nil, &FetchError{Kind: FetchUnreachable, Status: resp.StatusCode}
	case resp.StatusCode == http.StatusUnauthorized, resp.StatusCode == http.StatusForbidden, resp.StatusCode == http.StatusNotFound:
		return nil, &FetchError{Kind: FetchUnauthorized, Status: resp.StatusCode}
	case resp.StatusCode >= 300:
		return nil, &FetchError{Kind: FetchBadPayload, Status: resp.StatusCode}
	}

	limit := s.MaxBytes
	if limit <= 0 {
		limit = MaxSnapshotBytes
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		// A truncated read mid-body is a network problem, not a bad contract.
		return nil, &FetchError{Kind: FetchUnreachable, Err: err}
	}
	if int64(len(body)) > limit {
		return nil, &FetchError{Kind: FetchBadPayload, Err: fmt.Errorf("snapshot exceeds %d bytes", limit)}
	}

	var env desiredEnvelope
	if err := json.Unmarshal(body, &env); err != nil {
		return nil, &FetchError{Kind: FetchBadPayload, Err: err}
	}
	if env.Data == nil || env.Data.Snapshot == nil || env.Data.Snapshot.Tunnels == nil {
		return nil, &FetchError{Kind: FetchBadPayload, Err: ErrMalformedSnapshot}
	}
	if len(*env.Data.Snapshot.Tunnels) > MaxSnapshotTunnels {
		return nil, &FetchError{Kind: FetchBadPayload, Err: fmt.Errorf("snapshot has more than %d tunnels", MaxSnapshotTunnels)}
	}
	snap, err := decodeSnapshot(env.Data.Snapshot.Version, *env.Data.Snapshot.Tunnels)
	if err != nil {
		// A payload that parses as JSON but violates the tunnel contract is a
		// bad payload, and must not be reported as an outage: it is a decision
		// to fail closed on, not a reason to serve cached state.
		return nil, &FetchError{Kind: FetchBadPayload, Err: err}
	}
	return snap, nil
}

var _ Source = HTTPSource{}
