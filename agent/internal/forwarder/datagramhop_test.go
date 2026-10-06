package forwarder

import (
	"bytes"
	"errors"
	"math"
	"sync"
	"testing"
)

// ---------------------------------------------------------------------------
// Datagram hop framing.
//
// These tests pin the datagram relay wire framing.
//
// These cover the two parts of the relay hop that are pure logic: the wire
// framing and the mapping identity allocator. Everything else about the hop
// (source attestation, target selection, reply routing) only exists on a socket,
// so those assertions belong to the Gate — see the contract's §12.3 list.
// ---------------------------------------------------------------------------

func TestDatagramHopRoundTrip(t *testing.T) {
	id, err := newDatagramHopIdentity()
	if err != nil {
		t.Fatalf("newDatagramHopIdentity: %v", err)
	}
	header := datagramHopHeader{MappingID: 41, Generation: id.generation}

	for _, size := range []int{0, 1, 512, datagramHopMaxPayload} {
		payload := bytes.Repeat([]byte{0xA5}, size)
		wire, err := appendDatagramHop(nil, header, payload)
		if err != nil {
			t.Fatalf("appendDatagramHop(size=%d): %v", size, err)
		}
		// The wire size is derived, never stored: one datagram in, one out.
		if want := datagramHopHeaderSize + size; len(wire) != want {
			t.Fatalf("wire size = %d, want %d", len(wire), want)
		}
		if len(wire) > datagramHopMTU {
			t.Fatalf("wire size %d exceeds the MTU budget %d", len(wire), datagramHopMTU)
		}

		got, gotPayload, err := parseDatagramHop(wire)
		if err != nil {
			t.Fatalf("parseDatagramHop(size=%d): %v", size, err)
		}
		if got != header {
			t.Fatalf("header = %+v, want %+v", got, header)
		}
		if !bytes.Equal(gotPayload, payload) {
			t.Fatalf("payload for size %d did not survive the hop", size)
		}
	}
}

// A hop packet must never claim a size the exit cannot answer symmetrically: the
// ceiling is enforced when building AND when parsing, because the two ends can
// have different budgets.
func TestDatagramHopRejectsOversize(t *testing.T) {
	header := datagramHopHeader{MappingID: 7, Generation: 9}
	oversize := bytes.Repeat([]byte{0x01}, datagramHopMaxPayload+1)

	if _, err := appendDatagramHop(nil, header, oversize); !errors.Is(err, errDatagramHopPayload) {
		t.Fatalf("appendDatagramHop(oversize) err = %v, want errDatagramHopPayload", err)
	}

	// A packet that is well-formed but too large for our budget is refused on
	// parse as well.
	wire, err := appendDatagramHop(nil, header, bytes.Repeat([]byte{0x02}, 8))
	if err != nil {
		t.Fatalf("appendDatagramHop: %v", err)
	}
	wire = append(wire, oversize...) // pad the payload past the ceiling
	if _, _, err := parseDatagramHop(wire); !errors.Is(err, errDatagramHopPayload) {
		t.Fatalf("parseDatagramHop(oversize) err = %v, want errDatagramHopPayload", err)
	}
}

func TestDatagramHopRejectsMalformed(t *testing.T) {
	valid, err := appendDatagramHop(nil, datagramHopHeader{MappingID: 1, Generation: 2}, []byte("hello"))
	if err != nil {
		t.Fatalf("appendDatagramHop: %v", err)
	}

	cases := []struct {
		name string
		pkt  []byte
		want error
	}{
		{"empty", nil, errDatagramHopShort},
		{"header minus one byte", valid[:datagramHopHeaderSize-1], errDatagramHopShort},
		{"bad magic", append([]byte{'X', 'X', 'X', 'X'}, valid[4:]...), errDatagramHopMagic},
		{"bad version", append(append([]byte(nil), valid[:4]...), append([]byte{datagramHopVersion + 1}, valid[5:]...)...), errDatagramHopVersion},
	}
	for _, tc := range cases {
		if _, _, err := parseDatagramHop(tc.pkt); !errors.Is(err, tc.want) {
			t.Errorf("%s: err = %v, want %v", tc.name, err, tc.want)
		}
	}
}

// Reserved bytes are part of the frozen layout: a future field uses them, so
// today they must be written as zero and must not affect parsing.
func TestDatagramHopReservedBytesAreZeroAndIgnored(t *testing.T) {
	wire, err := appendDatagramHop(nil, datagramHopHeader{MappingID: 3, Generation: 4}, nil)
	if err != nil {
		t.Fatalf("appendDatagramHop: %v", err)
	}
	if !bytes.Equal(wire[5:8], []byte{0, 0, 0}) {
		t.Fatalf("reserved bytes = %v, want zeros", wire[5:8])
	}
	wire[5], wire[6], wire[7] = 0xFF, 0xFF, 0xFF
	got, _, err := parseDatagramHop(wire)
	if err != nil {
		t.Fatalf("parseDatagramHop with non-zero reserved: %v", err)
	}
	if got.MappingID != 3 || got.Generation != 4 {
		t.Fatalf("reserved bytes leaked into the header: %+v", got)
	}
}

func TestDatagramHopAppendReusesBuffer(t *testing.T) {
	// The ingress appends onto a per-mapping buffer; appending must not disturb
	// what was already there.
	prefix := []byte("prefix:")
	wire, err := appendDatagramHop(prefix, datagramHopHeader{MappingID: 5, Generation: 6}, []byte("payload"))
	if err != nil {
		t.Fatalf("appendDatagramHop: %v", err)
	}
	if !bytes.HasPrefix(wire, []byte("prefix:")) {
		t.Fatalf("append disturbed the destination buffer: %q", wire)
	}
	_, payload, err := parseDatagramHop(wire[len("prefix:"):])
	if err != nil {
		t.Fatalf("parseDatagramHop: %v", err)
	}
	if string(payload) != "payload" {
		t.Fatalf("payload = %q, want %q", payload, "payload")
	}
}

func TestDatagramHopIdentityGenerationIsUsable(t *testing.T) {
	id, err := newDatagramHopIdentity()
	if err != nil {
		t.Fatalf("newDatagramHopIdentity: %v", err)
	}
	// Zero is deliberately outside the space: a zero header must never be a
	// valid packet, so "unset" stays detectable.
	if id.generation == 0 {
		t.Fatal("generation must never be zero")
	}
}

// Ids are allocated monotonically and never reused: reuse is exactly what would
// let a late reply for a recycled mapping reach a new client (contract §9.1).
func TestDatagramHopIdentityIDsAreMonotonicAndUnique(t *testing.T) {
	id, err := newDatagramHopIdentity()
	if err != nil {
		t.Fatalf("newDatagramHopIdentity: %v", err)
	}

	const n = 2048
	seen := make(map[uint32]struct{}, n)
	var last uint32
	for i := 0; i < n; i++ {
		got, ok := id.nextMappingID()
		if !ok {
			t.Fatalf("allocation %d was refused before exhaustion", i)
		}
		if got == 0 {
			t.Fatal("id 0 must never be allocated")
		}
		if i > 0 && got <= last {
			t.Fatalf("id %d is not greater than the previous id %d", got, last)
		}
		if _, dup := seen[got]; dup {
			t.Fatalf("id %d was reused", got)
		}
		seen[got] = struct{}{}
		last = got
	}
}

// Exhaustion is refused, not wrapped: dropping a datagram is bounded and
// countable, while wrapping breaks the return path's safety property silently.
func TestDatagramHopIdentityRefusesExhaustionInsteadOfWrapping(t *testing.T) {
	id, err := newDatagramHopIdentity()
	if err != nil {
		t.Fatalf("newDatagramHopIdentity: %v", err)
	}
	id.next.Store(math.MaxUint32)
	if _, ok := id.nextMappingID(); ok {
		t.Fatal("the last id in the space must be refused, not handed out")
	}
	if got := id.next.Load(); got != math.MaxUint32 {
		t.Fatalf("next = %d after refusal, want it unchanged at %d", got, uint32(math.MaxUint32))
	}
}

// The allocator is shared by every mapping on the runtime, so concurrent
// allocations must not collide.
func TestDatagramHopIdentityConcurrentAllocation(t *testing.T) {
	id, err := newDatagramHopIdentity()
	if err != nil {
		t.Fatalf("newDatagramHopIdentity: %v", err)
	}

	const goroutines, perGoroutine = 16, 256
	var wg sync.WaitGroup
	results := make([][]uint32, goroutines)
	for g := 0; g < goroutines; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			out := make([]uint32, 0, perGoroutine)
			for i := 0; i < perGoroutine; i++ {
				v, ok := id.nextMappingID()
				if !ok {
					t.Errorf("allocation refused at g=%d i=%d", g, i)
					return
				}
				out = append(out, v)
			}
			results[g] = out
		}(g)
	}
	wg.Wait()

	seen := make(map[uint32]struct{}, goroutines*perGoroutine)
	for _, out := range results {
		for _, v := range out {
			if _, dup := seen[v]; dup {
				t.Fatalf("id %d was handed out twice", v)
			}
			seen[v] = struct{}{}
		}
	}
	if len(seen) != goroutines*perGoroutine {
		t.Fatalf("allocated %d unique ids, want %d", len(seen), goroutines*perGoroutine)
	}
}
