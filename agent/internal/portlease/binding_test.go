package portlease

import "testing"

func TestNormalizeHost(t *testing.T) {
	for _, tc := range []struct{ input, want string }{
		{" 127.0.0.1 ", "127.0.0.1"},
		{"[2001:0DB8:0000:0000:0000:0000:0000:0001]", "2001:db8::1"},
		{"::ffff:127.0.0.1", "127.0.0.1"},
		{"[::ffff:7f00:1]", "127.0.0.1"},
		{"[::FFFF:0.0.0.0]", "0.0.0.0"},
		{"[FE80:0::1%Ethernet]", "fe80::1%Ethernet"},
		{" [0:0:0:0:0:0:0:0] ", "::"},
		{"*", ""}, {" ", ""}, {"0.0.0.0", "0.0.0.0"},
		{" LOCALHOST. ", "localhost."}, {".", "."}, {"[]", "[]"},
	} {
		t.Run(tc.input, func(t *testing.T) {
			if got := NormalizeHost(tc.input); got != tc.want {
				t.Fatalf("NormalizeHost(%q) = %q, want %q", tc.input, got, tc.want)
			}
			if got := NormalizeHost(tc.want); got != tc.want {
				t.Fatalf("normalization is not idempotent: %q", got)
			}
		})
	}
}

func TestBindingConflicts(t *testing.T) {
	for _, tc := range []struct {
		name, leftProtocol, leftHost, rightProtocol, rightHost string
		want                                                   bool
	}{
		{"tcp and udp", "tcp", "127.0.0.1", "udp", "127.0.0.1", false},
		{"tcp and udp wildcards", "tcp", "", "udp", "::", false},
		{"tls uses tcp", "tls", "127.0.0.1", "tcp", "127.0.0.1", true},
		{"ws uses tcp", "ws", "127.0.0.1", "tls", "127.0.0.1", true},
		{"empty protocol means tcp", "", "127.0.0.1", "TCP", "127.0.0.1", true},
		{"equal ipv4", "tcp", "127.0.0.1", "tcp", "127.0.0.1", true},
		{"disjoint ipv4", "tcp", "127.0.0.1", "tcp", "127.0.0.2", false},
		{"equal ipv6 aliases", "udp", "[2001:0db8:0:0::1]", "udp", "2001:db8::1", true},
		{"disjoint ipv6", "udp", "2001:db8::1", "udp", "2001:db8::2", false},
		{"distinct concrete families", "tcp", "127.0.0.1", "tcp", "::1", false},
		{"mapped ipv4 alias", "tcp", "::ffff:127.0.0.1", "tcp", "127.0.0.1", true},
		{"mapped wildcard", "udp", "::ffff:0.0.0.0", "udp", "::1", true},
		{"empty wildcard", "tcp", "", "tcp", "127.0.0.2", true},
		{"v4 wildcard", "tcp", "0.0.0.0", "tcp", "127.0.0.1", true},
		{"v6 wildcard", "udp", "::", "udp", "2001:db8::1", true},
		{"dual stack v6 wildcard", "tcp", "::", "tcp", "127.0.0.1", true},
		{"generic v4 wildcard may be dual stack", "udp", "0.0.0.0", "udp", "::1", true},
		{"wildcards overlap", "tcp", "0.0.0.0", "tcp", "::", true},
		{"unresolved hostname", "tcp", "localhost", "tcp", "::1", true},
		{"unresolved hostnames", "udp", "a.invalid", "udp", "b.invalid", true},
		{"unknown zone identity", "udp", "fe80::1%eth0", "udp", "fe80::1%2", true},
		{"unrecognized protocol fails closed", "both", "127.0.0.1", "udp", "127.0.0.1", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			left, right := New(tc.leftProtocol, 19000, tc.leftHost), New(tc.rightProtocol, 19000, tc.rightHost)
			if got := left.Conflicts(right); got != tc.want {
				t.Fatalf("%+v conflicts %+v = %v, want %v", left, right, got, tc.want)
			}
			if got := right.Conflicts(left); got != tc.want {
				t.Fatalf("conflict comparison is not symmetric: %v", got)
			}
			right.Port++
			if left.Conflicts(right) {
				t.Fatal("distinct numeric ports must not conflict")
			}
		})
	}
}

func TestBindingKeyKeepsScopeAndSocketProtocol(t *testing.T) {
	a := New("tcp", 19000, "127.0.0.1")
	for _, b := range []Binding{New("udp", 19000, a.Host), New("tcp", 19000, "127.0.0.2"), New("tcp", 19001, a.Host)} {
		if a.Key() == b.Key() {
			t.Fatalf("distinct bindings share a key: %+v / %+v", a, b)
		}
	}
	for _, b := range []Binding{a, New("udp", 19000, "[2001:db8::1]"), New("tcp", 19000, ""), New("tls", 19000, "::ffff:127.0.0.1")} {
		got, ok := ParseKey(b.Key())
		if !ok || got != b {
			t.Fatalf("ParseKey(%q) = %+v / %v, want %+v", b.Key(), got, ok, b)
		}
	}
	if got, ok := ParseKey("udp:19000"); !ok || got.Host != "" || got.Port != 19000 || got.Network != "udp" {
		t.Fatalf("legacy key = %+v / %v", got, ok)
	}
	for _, key := range []string{"tcp", "both:19000", "udp:0", "tcp:65536@::", "tcp:bad@127.0.0.1"} {
		if _, ok := ParseKey(key); ok {
			t.Fatalf("malformed key %q accepted", key)
		}
	}
}
