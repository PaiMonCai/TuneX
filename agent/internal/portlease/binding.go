// Package portlease describes socket bind conflicts. It owns no registry or
// lifecycle state; the tunnel manager derives reservations from its runtimes.
package portlease

import (
	"net/netip"
	"strconv"
	"strings"
)

// Binding is a socket protocol, numeric port and normalized listen host.
type Binding struct {
	Network string
	Port    int
	Host    string
}

func New(protocol string, port int, host string) Binding {
	network := strings.ToLower(strings.TrimSpace(protocol))
	switch network {
	case "", "tcp", "tls", "ws":
		network = "tcp"
	}
	return Binding{Network: network, Port: port, Host: NormalizeHost(host)}
}

// NormalizeHost preserves the host handed to the socket while removing spelling
// differences: brackets, IPv6 expansion and IPv4-mapped IPv6 aliases. Hostnames
// stay unresolved, so overlap checks do not depend on a changing DNS answer.
func NormalizeHost(host string) string {
	host = strings.TrimSpace(host)
	if len(host) > 2 && strings.HasPrefix(host, "[") && strings.HasSuffix(host, "]") {
		host = host[1 : len(host)-1]
	}
	if host == "*" {
		return ""
	}
	if addr, err := netip.ParseAddr(host); err == nil {
		return addr.Unmap().String()
	}
	// Preserve DNS's root dot: removing it could change resolver search rules.
	return strings.ToLower(host)
}

// HostsOverlap is conservative because the runtime does not attest IPV6_V6ONLY
// or its resolved socket family. Either wildcard (including 0.0.0.0) may bind
// dual stack through Go's generic tcp/udp listeners. An unresolved host can
// resolve to either family. Only distinct concrete IPs prove disjoint scopes.
func HostsOverlap(a, b string) bool {
	a, b = NormalizeHost(a), NormalizeHost(b)
	x, xerr := netip.ParseAddr(a)
	y, yerr := netip.ParseAddr(b)
	if xerr != nil || yerr != nil || x.IsUnspecified() || y.IsUnspecified() {
		return true
	}
	// Different zone names can alias one interface; without socket evidence we
	// cannot use them to prove that the same IPv6 address is disjoint.
	return x.WithZone("") == y.WithZone("")
}

// Conflicts keeps TCP and UDP independent; stream fronts share TCP's namespace.
// Unknown protocol namespaces cannot establish independence and fail closed.
func (b Binding) Conflicts(other Binding) bool {
	b, other = New(b.Network, b.Port, b.Host), New(other.Network, other.Port, other.Host)
	if b.Port != other.Port {
		return false
	}
	known := func(n string) bool { return n == "tcp" || n == "udp" }
	if known(b.Network) && known(other.Network) && b.Network != other.Network {
		return false
	}
	return HostsOverlap(b.Host, other.Host)
}

// Key includes scope so releasing one listener cannot release another address
// or protocol on the same number. It is a derived reservation key, not an owner.
func (b Binding) Key() string {
	b = New(b.Network, b.Port, b.Host)
	return b.Network + ":" + strconv.Itoa(b.Port) + "@" + b.Host
}

// ParseKey also reads legacy protocol:port keys as an unknown wildcard scope.
func ParseKey(key string) (Binding, bool) {
	network, rest, ok := strings.Cut(key, ":")
	if !ok || (network != "tcp" && network != "udp") {
		return Binding{}, false
	}
	portText, host, _ := strings.Cut(rest, "@")
	port, err := strconv.Atoi(portText)
	if err != nil || port <= 0 || port > 65535 {
		return Binding{}, false
	}
	return New(network, port, host), true
}
