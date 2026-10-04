package manager

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// V5-WP2 "D. Manager 不复制" guard.
//
// The runtime abstraction is only worth having if it stays an abstraction. The
// failure mode it is meant to prevent is concrete and easy to fall into: the
// first datagram protocol (V5.1b UDP) arrives, someone adds a UDPManager beside
// TunnelManager because "UDP is different", and from then on there are two
// revision ledgers, two port owners and two reconcile paths — which is exactly
// what V4's frozen baseline forbids (§1.1: no second DIRECT engine, no second
// RELAY engine, no second port ownership, no second desired-state truth).
//
// This is a source-level guard on purpose. A type-level assertion cannot see a
// type that does not exist yet; a reviewer can miss it in a large diff; a grep
// cannot be forgotten. Same technique the web contract tests use for the
// frontend error-code table.
var forbiddenManagerTypes = regexp.MustCompile(`(?m)^type\s+(UDP|TCP|TLS|WS|WSS|QUIC|Datagram|Stream|Second)\w*Manager\b`)

func TestNoPerProtocolManagerTypes(t *testing.T) {
	for _, dir := range []string{".", "../forwarder", "../control", "../restore"} {
		entries, err := os.ReadDir(dir)
		if err != nil {
			t.Fatalf("read %s: %v", dir, err)
		}
		for _, entry := range entries {
			name := entry.Name()
			if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
				continue
			}
			path := filepath.Join(dir, name)
			src, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("read %s: %v", path, err)
			}
			if m := forbiddenManagerTypes.FindString(string(src)); m != "" {
				t.Fatalf("%s declares %q: per-protocol managers are forbidden — "+
					"a new protocol must reuse TunnelManager's desired state, revision, "+
					"lease and reconcile ownership, forking only inside runtime construction "+
					"(forwarder.BuildStream / the runtime factory)", path, m)
			}
		}
	}
}

// There must be exactly one tunnel manager type in the whole agent. Two of them
// would mean two registries, i.e. two answers to "what is running here".
func TestExactlyOneTunnelManager(t *testing.T) {
	count := 0
	root := filepath.Join("..", "..")
	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		src, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if regexp.MustCompile(`(?m)^type TunnelManager\b`).MatchString(string(src)) {
			count++
			if !strings.HasSuffix(path, filepath.Join("manager", "tunnel.go")) {
				t.Fatalf("TunnelManager declared in %s; it is the single runtime registry and must live in manager/tunnel.go", path)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
	if count != 1 {
		t.Fatalf("found %d TunnelManager declarations, want exactly 1", count)
	}
}
