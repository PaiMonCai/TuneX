// Package engine implements the data plane: it parses the Fernet-decrypted gost
// config pushed by the control plane and runs the described listeners and
// forwarders.
//
// Config shape (from tunex-clone src/crypto/node-config.ts and the original
// server's getInNodeConfig / getOutNodeConfig):
//
//	{
//	  "log": {"level": "fatal"},
//	  "tls": {"validity": "8760h", "commonName": "..", "organization": ".."},
//	  "services": [
//	    {"name":"tcp-<id>", "addr":":8080"|":WAIT_LISTEN20000-30000",
//	     "handler": {"type":"tcp", "chain":"<chainName>", "metadata":{..}},
//	     "listener": {"type":"tcp"},
//	     "forwarder": {"nodes":[{"name":"..","addr":"host:port"}], "selector":{"strategy":"round"}},
//	     "metadata": {"enableStats":true, ...}}
//	  ],
//	  "chains": [{"name":"<id>", "hops":[{"name":"..","selector":{..},"nodes":[..]}]}],
//	  "climiters": [...], "limiters": [...], "bypasses": [...], "admissions": [...],
//	  "observers": [{"name":"observer","plugin":{"type":"http","addr":"<site>/api/tunnel/observer"}}]
//	}
//
// Only the fields this agent acts on are modelled; unknown fields are preserved
// as raw JSON so nothing breaks when the server adds new keys.
package engine

import "encoding/json"

// Config is the top-level gost config.
type Config struct {
	Log        *LogConfig       `json:"log,omitempty"`
	TLS        json.RawMessage  `json:"tls,omitempty"`
	Services   []*ServiceConfig `json:"services,omitempty"`
	Chains     []*ChainConfig   `json:"chains,omitempty"`
	Climiters  json.RawMessage  `json:"climiters,omitempty"`
	Limiters   json.RawMessage  `json:"limiters,omitempty"`
	Bypasses   json.RawMessage  `json:"bypasses,omitempty"`
	Admissions json.RawMessage  `json:"admissions,omitempty"`
	Observers  json.RawMessage  `json:"observers,omitempty"`
}

// LogConfig models the log section.
type LogConfig struct {
	Level  string `json:"level,omitempty"`
	Format string `json:"format,omitempty"`
	Output string `json:"output,omitempty"`
}

// ServiceConfig is one listener + route.
type ServiceConfig struct {
	Name      string          `json:"name"`
	Addr      string          `json:"addr"`
	Handler   *HandlerConfig  `json:"handler,omitempty"`
	Listener  *ListenerConfig `json:"listener,omitempty"`
	Forwarder *ForwarderGroup `json:"forwarder,omitempty"`
	Metadata  map[string]any  `json:"metadata,omitempty"`
}

// HandlerConfig describes how accepted connections are handled/routed.
type HandlerConfig struct {
	Type     string         `json:"type,omitempty"`
	Chain    string         `json:"chain,omitempty"`
	Auth     *AuthConfig    `json:"auth,omitempty"`
	Metadata map[string]any `json:"metadata,omitempty"`
}

// ListenerConfig describes the listener protocol.
type ListenerConfig struct {
	Type string `json:"type,omitempty"`
}

// AuthConfig carries optional proxy credentials.
type AuthConfig struct {
	Username string `json:"username,omitempty"`
	Password string `json:"password,omitempty"`
}

// ForwarderGroup is a set of forward destinations with a load-balance strategy.
type ForwarderGroup struct {
	Nodes    []*ForwarderNode `json:"nodes,omitempty"`
	Selector *Selector        `json:"selector,omitempty"`
}

// ForwarderNode is a single forward destination.
type ForwarderNode struct {
	Name      string           `json:"name,omitempty"`
	Addr      string           `json:"addr"`
	Metadata  map[string]any   `json:"metadata,omitempty"`
	Filter    *ForwarderFilter `json:"filter,omitempty"`
	Connector json.RawMessage  `json:"connector,omitempty"`
	Dialer    json.RawMessage  `json:"dialer,omitempty"`
}

// ForwarderFilter constrains which hosts a node may serve.
type ForwarderFilter struct {
	Host string `json:"host,omitempty"`
}

// Selector is a load-balance strategy.
type Selector struct {
	Strategy string `json:"strategy,omitempty"`
}

// ChainConfig is a named chain of hops (used by tunex/hop chains).
type ChainConfig struct {
	Name string `json:"name"`
	Hops []*Hop `json:"hops,omitempty"`
}

// Hop is one hop of a chain.
type Hop struct {
	Name     string     `json:"name,omitempty"`
	Selector *Selector  `json:"selector,omitempty"`
	Nodes    []*HopNode `json:"nodes,omitempty"`
}

// HopNode is one node in a hop.
type HopNode struct {
	Name      string          `json:"name,omitempty"`
	Addr      string          `json:"addr"`
	Connector json.RawMessage `json:"connector,omitempty"`
	Dialer    json.RawMessage `json:"dialer,omitempty"`
	Metadata  map[string]any  `json:"metadata,omitempty"`
}

// ParseConfig decodes a gost config from JSON.
func ParseConfig(raw []byte) (*Config, error) {
	var c Config
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, err
	}
	return &c, nil
}

// ForwardAddrs returns the plain forward destination addresses of the service.
// When the service description carries a known proxy protocol (hop-forwarder)
// there is no plain forwarder and this returns nil.
func (s *ServiceConfig) ForwardAddrs() []*ForwarderNode {
	if s.Forwarder == nil {
		return nil
	}
	return s.Forwarder.Nodes
}

// IsUDP reports whether the service is a UDP/relay-UDP listener.
func (s *ServiceConfig) IsUDP() bool {
	if s.Listener != nil {
		switch s.Listener.Type {
		case "udp":
			return true
		}
	}
	if s.Handler != nil {
		switch s.Handler.Type {
		case "udp", "ssu":
			return false // ssu is a relay handler, not a raw UDP echo
		}
	}
	return false
}
