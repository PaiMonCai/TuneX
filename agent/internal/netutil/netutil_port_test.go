package netutil

import (
	"net"
	"testing"
)

// bindTCP grabs a TCP port and returns it with a closer.
func bindTCP(t *testing.T) (int, net.Listener) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("bind tcp: %v", err)
	}
	return ln.Addr().(*net.TCPAddr).Port, ln
}

func TestIsPortFreeProtoIsProtocolAware(t *testing.T) {
	port, ln := bindTCP(t)
	defer ln.Close()

	// The port is taken on TCP but free on UDP (independent kernel spaces).
	if isPortFreeProto("tcp", port) {
		t.Fatalf("expected tcp:%d to be busy", port)
	}
	if !isPortFreeProto("udp", port) {
		t.Fatalf("expected udp:%d to be free", port)
	}
}

func TestGetFreePortByRangeProtoStaysInRangeAndExcludes(t *testing.T) {
	pr := ParsePortRange("49800-49899")
	if pr.Empty() {
		t.Fatal("range parsed empty")
	}

	p1 := pr.GetFreePortByRangeProto("tcp", nil)
	if p1 < 49800 || p1 > 49899 {
		t.Fatalf("port %d out of range", p1)
	}
	p2 := pr.GetFreePortByRangeProto("tcp", map[int]bool{p1: true})
	if p2 == 0 {
		t.Fatal("no second port found")
	}
	if p2 == p1 {
		t.Fatalf("excluded port %d was returned again", p1)
	}
}

func TestGetFreePortProtoReturnsValidPorts(t *testing.T) {
	if p := GetFreePortProto("tcp"); p <= 0 {
		t.Fatalf("tcp ephemeral port invalid: %d", p)
	}
	if p := GetFreePortProto("udp"); p <= 0 {
		t.Fatalf("udp ephemeral port invalid: %d", p)
	}
}
