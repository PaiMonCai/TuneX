// Package linkrunner manages standalone FXP executables. It does not own
// compiler, control-plane, resource-guard or legacy LKG integration.
package linkrunner

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Config is one complete placement, never a partial binding update. RunnerConfig
// contains secrets and must stay out of legacy LKG, diagnostics and error logs.
type Config struct {
	ID             string          `json:"id"`
	LinkID         int64           `json:"link_id"`
	WorkspaceID    int64           `json:"workspace_id"`
	NodeID         int64           `json:"node_id"`
	Role           string          `json:"role"`
	Generation     int64           `json:"generation"`
	LeaseExpiresAt string          `json:"lease_expires_at"`
	ConfigDigest   string          `json:"config_digest"`
	RunnerConfig   json.RawMessage `json:"runner_config"`
	RuntimeIDs     []string        `json:"runtime_ids"`
	Ports          []Port          `json:"ports"`
}

// Port is the exact listener claim for the caller's resource guard. TCP and UDP
// on the same number are independent claims. An empty host is a wildcard.
type Port struct {
	Protocol string `json:"protocol"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
}

// Observation never includes runner JSON or arbitrary child output. Generation
// is the durable command fence; ObservedGeneration identifies the running config
// and can be lower after a failed update has rolled back.
type Observation struct {
	UpdateMode          string         `json:"update_mode"`
	ID                  string         `json:"id"`
	LinkID              int64          `json:"link_id"`
	WorkspaceID         int64          `json:"workspace_id"`
	NodeID              int64          `json:"node_id"`
	Role                string         `json:"role"`
	Generation          int64          `json:"generation"`
	ObservedGeneration  int64          `json:"observed_generation"`
	ConfigDigest        string         `json:"config_digest"`
	DesiredConfigDigest string         `json:"desired_config_digest"`
	LeaseExpiresAt      string         `json:"lease_expires_at"`
	RuntimeIDs          []string       `json:"runtime_ids"`
	Ports               []Port         `json:"ports"`
	State               string         `json:"state"`
	Ready               bool           `json:"ready"`
	PID                 int            `json:"pid,omitempty"`
	LastError           string         `json:"last_error,omitempty"`
	Logs                []string       `json:"logs,omitempty"`
	TrafficStatus       *TrafficStatus `json:"traffic_status,omitempty"`
	TargetStatus        []TargetStatus `json:"target_status,omitempty"`
}

// Accounting receipt is independent of runtime readiness. Counts describe
// retained private epochs; no producer identities or paths are exposed.
type TrafficStatus struct {
	RotationSupported bool    `json:"rotation_supported"`
	ProducerCount     int     `json:"producer_count"`
	SampleCount       int     `json:"sample_count"`
	RuleCount         int     `json:"rule_count"`
	SpoolBytes        int64   `json:"spool_bytes"`
	LastAckAt         *string `json:"last_ack_at"`
	State             string  `json:"state"`
}

var (
	ErrInvalidConfig      = errors.New("linkrunner: invalid config")
	ErrTargetCapability   = errors.New("agent_fxp_targets_capability_missing")
	ErrSourceCapability   = errors.New("agent_fxp_source_capability_missing")
	ErrDigestMismatch     = errors.New("linkrunner: config digest mismatch")
	ErrStaleGeneration    = errors.New("linkrunner: stale generation")
	ErrGenerationConflict = errors.New("linkrunner: generation content conflict")
	ErrIdentityMismatch   = errors.New("linkrunner: placement identity mismatch")
	ErrAgentMismatch      = errors.New("linkrunner: cache belongs to another agent")
	ErrLeaseExpired       = errors.New("linkrunner: lease expired")
	ErrLeaseRegression    = errors.New("linkrunner: lease regressed")
	ErrPortConflict       = errors.New("linkrunner: listener conflict")
	ErrCache              = errors.New("linkrunner: private cache unavailable or corrupt")
	ErrClosed             = errors.New("linkrunner: manager closed")
	ErrStartFailed        = errors.New("linkrunner: process start failed")
	ErrProcessExited      = errors.New("linkrunner: process exited")
	ErrReadyTimeout       = errors.New("linkrunner: listener readiness timed out")
	ErrReloadRejected     = errors.New("linkrunner: managed reload rejected")
	ErrReloadTimeout      = errors.New("linkrunner: managed reload acknowledgement timed out")
	ErrConfigTampered     = errors.New("linkrunner: unauthorized running config change")
)

const maxConfigBytes = 1 << 20

// CanonicalRunnerConfig matches the compiler's sorted JSON object encoding for
// FXP configs. Digest always hashes these exact bytes, which are also written to
// the executable's private config file. Object insertion order on the wire is
// immaterial. FXP numeric fields must be integers within JS's safe range.
func CanonicalRunnerConfig(raw json.RawMessage) (json.RawMessage, error) {
	if len(raw) == 0 {
		raw = json.RawMessage("null")
	}
	if len(raw) > maxConfigBytes {
		return nil, ErrInvalidConfig
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var value any
	if dec.Decode(&value) != nil {
		return nil, ErrInvalidConfig
	}
	if dec.Decode(new(any)) != io.EOF {
		return nil, ErrInvalidConfig
	}
	var out bytes.Buffer
	var encode func(any) error
	stringJSON := func(s string) {
		var b bytes.Buffer
		e := json.NewEncoder(&b)
		e.SetEscapeHTML(false)
		_ = e.Encode(s)
		x := strings.TrimSuffix(b.String(), "\n")
		x = strings.ReplaceAll(strings.ReplaceAll(x, `\u2028`, "\u2028"), `\u2029`, "\u2029")
		out.WriteString(x)
	}
	encode = func(v any) error {
		switch x := v.(type) {
		case nil:
			out.WriteString("null")
		case bool:
			out.WriteString(strconv.FormatBool(x))
		case string:
			stringJSON(x)
		case json.Number:
			n, err := x.Int64()
			if err != nil || n < -9007199254740991 || n > 9007199254740991 {
				return ErrInvalidConfig
			}
			out.WriteString(strconv.FormatInt(n, 10))
		case []any:
			out.WriteByte('[')
			for i, item := range x {
				if i > 0 {
					out.WriteByte(',')
				}
				if err := encode(item); err != nil {
					return err
				}
			}
			out.WriteByte(']')
		case map[string]any:
			keys := make([]string, 0, len(x))
			for key := range x {
				keys = append(keys, key)
			}
			sort.Strings(keys)
			out.WriteByte('{')
			for i, key := range keys {
				if i > 0 {
					out.WriteByte(',')
				}
				stringJSON(key)
				out.WriteByte(':')
				if err := encode(x[key]); err != nil {
					return err
				}
			}
			out.WriteByte('}')
		default:
			return ErrInvalidConfig
		}
		return nil
	}
	if err := encode(value); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func Digest(raw json.RawMessage) (string, error) {
	canonical, err := CanonicalRunnerConfig(raw)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(canonical)
	return hex.EncodeToString(sum[:]), nil
}

type runnerShape struct {
	Role          string        `json:"role"`
	TunnelID      int64         `json:"tunnelId"`
	RuleID        int64         `json:"ruleId"`
	ListenPort    int           `json:"listenPort"`
	UDPListenPort int           `json:"udpListenPort"`
	ListenHost    string        `json:"listenHost"`
	Protocol      string        `json:"protocol"`
	Key           string        `json:"key"`
	Entries       []runnerShape `json:"entries"`
}

type listener struct {
	Role, Protocol string
	Port           int
	Tunnel, Rule   int64
}

func validateConfig(cfg *Config) (time.Time, []listener, error) {
	if cfg.ID == "" || len(cfg.ID) > 256 || cfg.LinkID <= 0 || cfg.WorkspaceID <= 0 || cfg.NodeID <= 0 || cfg.Generation <= 0 || (cfg.Role != "ingress" && cfg.Role != "egress") || len(cfg.Ports) > 1000 || len(cfg.RuntimeIDs) > 1000 {
		return time.Time{}, nil, ErrInvalidConfig
	}
	deadline, err := time.Parse(time.RFC3339Nano, cfg.LeaseExpiresAt)
	if err != nil {
		return time.Time{}, nil, fmt.Errorf("%w: lease must be RFC3339", ErrInvalidConfig)
	}
	canonical, err := CanonicalRunnerConfig(cfg.RunnerConfig)
	if err != nil {
		return time.Time{}, nil, err
	}
	digest, _ := Digest(canonical)
	if cfg.ConfigDigest != digest {
		return time.Time{}, nil, ErrDigestMismatch
	}
	cfg.RunnerConfig = canonical
	seenIDs := make(map[string]bool)
	for _, id := range cfg.RuntimeIDs {
		if id == "" || len(id) > 256 || seenIDs[id] {
			return time.Time{}, nil, ErrInvalidConfig
		}
		seenIDs[id] = true
	}
	if bytes.Equal(canonical, []byte("null")) {
		if cfg.Role != "ingress" || len(cfg.Ports) != 0 || len(cfg.RuntimeIDs) != 0 {
			return time.Time{}, nil, ErrInvalidConfig
		}
		return deadline, nil, nil
	}
	var shape runnerShape
	if json.Unmarshal(canonical, &shape) != nil || shape.TunnelID != cfg.LinkID {
		return time.Time{}, nil, ErrInvalidConfig
	}
	var shapes []runnerShape
	if cfg.Role == "ingress" {
		if shape.Role != "entry-group" || len(shape.Entries) == 0 || len(shape.Entries) > 1000 {
			return time.Time{}, nil, ErrInvalidConfig
		}
		shapes = shape.Entries
	} else {
		if shape.Role != "exit" || len(shape.Entries) != 0 {
			return time.Time{}, nil, ErrInvalidConfig
		}
		shapes = []runnerShape{shape}
	}
	var expected []listener
	var ports []Port
	for _, s := range shapes {
		if s.TunnelID != cfg.LinkID || s.Key == "" || (cfg.Role == "ingress" && (s.Role != "entry" || s.RuleID <= 0)) || (s.ListenHost != "" && s.ListenHost != "127.0.0.1" && s.ListenHost != "::1") {
			return time.Time{}, nil, ErrInvalidConfig
		}
		protocol := strings.ToLower(strings.TrimSpace(s.Protocol))
		if protocol == "" {
			protocol = "tcp"
		}
		if protocol == "tcp+udp" {
			protocol = "both"
		}
		if protocol != "tcp" && protocol != "udp" && protocol != "both" {
			return time.Time{}, nil, ErrInvalidConfig
		}
		for _, p := range []string{"tcp", "udp"} {
			if protocol != p && protocol != "both" {
				continue
			}
			port := s.ListenPort
			if p == "udp" && s.UDPListenPort > 0 {
				port = s.UDPListenPort
			}
			if port <= 0 || port > 65535 {
				return time.Time{}, nil, ErrInvalidConfig
			}
			lane := Port{Protocol: p, Host: s.ListenHost, Port: port}
			for _, old := range ports {
				if portsConflict(old, lane) {
					return time.Time{}, nil, ErrPortConflict
				}
			}
			ports = append(ports, lane)
			expected = append(expected, listener{s.Role, p, port, s.TunnelID, s.RuleID})
		}
	}
	if len(ports) != len(cfg.Ports) {
		return time.Time{}, nil, fmt.Errorf("%w: ports do not match runner listeners", ErrInvalidConfig)
	}
	matched := make([]bool, len(ports))
	for _, lane := range cfg.Ports {
		found := false
		for i, want := range ports {
			if !matched[i] && lane.Protocol == want.Protocol && lane.Port == want.Port && lane.Host == want.Host {
				matched[i] = true
				found = true
				break
			}
		}
		if !found {
			return time.Time{}, nil, fmt.Errorf("%w: ports do not match runner listeners", ErrInvalidConfig)
		}
	}
	return deadline, expected, nil
}

func portsConflict(a, b Port) bool {
	return a.Protocol == b.Protocol && a.Port == b.Port && (a.Host == "" || b.Host == "" || a.Host == b.Host)
}

func cloneConfig(cfg Config) Config {
	cfg.RunnerConfig = append(json.RawMessage(nil), cfg.RunnerConfig...)
	cfg.RuntimeIDs = append([]string(nil), cfg.RuntimeIDs...)
	cfg.Ports = append([]Port(nil), cfg.Ports...)
	return cfg
}

func fingerprint(cfg Config) string {
	cfg.LeaseExpiresAt = ""
	cfg.Generation = 0
	cfg.RunnerConfig = nil // Already represented by ConfigDigest.
	b, _ := json.Marshal(cfg)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}
