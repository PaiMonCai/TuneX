// Datagram hop framing for UDP RELAY.
//
// The relay wire contract defines this framing;
// read the framing contract before changing anything here. The shape it
// freezes, and the reasons each field exists:
//
//	client ══UDP══> ingress ──[16-byte hop header + payload]──> egress ──> target
//	client <══UDP══  ingress <──[same header, echoed back]──── egress <── target
//
// The hop is a datagram hop, not a framed stream: one datagram in, one datagram
// out, no retransmission, no ordering (contract §3.3 — a length-prefixed TCP hop
// was rejected as a second cross-node transport). What the header therefore does
// NOT carry is as important as what it does:
//
//   - **No destination, ever.** The exit resolves the target from its own
//     configured pool, so a forged source address (trivial over UDP, unlike TCP)
//     cannot turn an egress into an open relay. This is the same invariant the
//     Forwardx FXP runtime states for its exit side.
//   - **No length.** UDP preserves the datagram boundary, so the payload is
//     "everything after the header"; a length field could only disagree with it.
//   - **No checksum/sequence.** There is no retransmission and no reassembly in
//     v1, so a sequence number would be a field nobody reads (fragmentation, if
//     it is ever added, brings its own fields behind the version byte).
//
// What the header DOES carry, and why each is structurally required:
//
//   - `mapping_id`: the ingress keeps ONE socket toward the egress, so every
//     client's datagrams arrive from the same address and the egress cannot
//     demultiplex by source port. The mapping identity must be in-band.
//   - `generation`: mapping ids restart after a runtime restart, so without a
//     per-runtime generation a late reply from a previous incarnation could be
//     delivered to a client that got the same id. The ingress drops any reply
//     whose generation is not its own; the egress replaces a mapping whose
//     generation differs (the newer incarnation owns that id).
package forwarder

import (
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"sync/atomic"
)

const (
	// datagramHopMTU is the wire budget for one hop packet.
	//
	// 1280 is the IPv6 minimum MTU, so a hop packet of this size is carried by
	// ANY public path without relying on IP fragmentation (which is exactly what
	// breaks on paths with a smaller MTU or filtering middleboxes). Frozen in
	// contract §9.1; v1 does not fragment, so this is a hard ceiling, not a
	// threshold that gets worked around.
	datagramHopMTU = 1280

	// datagramHopHeaderSize is the fixed header size (contract §9.1).
	//
	//	magic(4) + version(1) + reserved(3) + mapping_id(4) + generation(4)
	//
	// The 3 reserved bytes exist so a future field (fragmentation) can be added
	// inside the same size, which keeps the MTU math and every offset stable.
	datagramHopHeaderSize = 16

	// datagramHopMaxPayload is the largest payload that fits the hop budget. A
	// datagram whose payload exceeds it is DROPPED AND COUNTED by the caller —
	// silently truncating it would look like a working tunnel until the one large
	// response that matters arrives (the same reasoning as datagramMaxPayload's
	// comment for the DIRECT path).
	//
	// It covers EDNS0 (1232) and the common case; QUIC-sized payloads need the
	// fragmentation work that the current contract deliberately defers.
	datagramHopMaxPayload = datagramHopMTU - datagramHopHeaderSize

	// datagramHopVersion is the framing version. A version this binary does not
	// know is refused rather than guessed at: the header layout is what makes
	// every offset meaningful.
	datagramHopVersion = 1
)

// datagramHopMagic is the first four bytes of every hop packet. It is not there
// to authenticate anything (v1 has no hop authentication by design, because the
// plain-TCP hop does not either — contract §9.1); it is there so that stray
// traffic on a reused port from a previous tunnel incarnation, or from a
// misconfigured neighbour, is rejected instead of being forwarded to a target.
var datagramHopMagic = [4]byte{'T', 'X', 'U', '1'}

var (
	// errDatagramHopShort means the packet cannot even hold the header.
	errDatagramHopShort = errors.New("forwarder: datagram hop packet is shorter than the hop header")
	// errDatagramHopMagic means the packet is not a hop packet at all.
	errDatagramHopMagic = errors.New("forwarder: datagram hop magic mismatch")
	// errDatagramHopVersion means the peer speaks a framing this binary does not.
	errDatagramHopVersion = errors.New("forwarder: datagram hop version not supported")
	// errDatagramHopPayload means the payload exceeds the MTU-safe ceiling.
	errDatagramHopPayload = errors.New("forwarder: datagram hop payload exceeds the MTU-safe ceiling")
)

// datagramHopHeader is the routing part of a hop packet: which mapping it belongs
// to, in which runtime incarnation.
type datagramHopHeader struct {
	// MappingID identifies one client mapping within one generation. It is never
	// reused inside a runtime's lifetime (see datagramHopIdentity.nextMappingID).
	MappingID uint32
	// Generation identifies the ingress runtime incarnation that allocated
	// MappingID.
	Generation uint32
}

// appendDatagramHop appends one hop packet (header + payload) to dst and returns
// the extended slice.
//
// Appending rather than allocating is deliberate: this runs once per datagram in
// the ingress loop, and the buffer is reusable per mapping.
func appendDatagramHop(dst []byte, h datagramHopHeader, payload []byte) ([]byte, error) {
	if len(payload) > datagramHopMaxPayload {
		return dst, fmt.Errorf("%w: %d > %d", errDatagramHopPayload, len(payload), datagramHopMaxPayload)
	}
	start := len(dst)
	dst = append(dst, make([]byte, datagramHopHeaderSize)...)
	hdr := dst[start : start+datagramHopHeaderSize]
	copy(hdr[0:4], datagramHopMagic[:])
	hdr[4] = datagramHopVersion
	// hdr[5:8] stays zero: reserved, and zero is what a future reader expects.
	binary.BigEndian.PutUint32(hdr[8:12], h.MappingID)
	binary.BigEndian.PutUint32(hdr[12:16], h.Generation)
	return append(dst, payload...), nil
}

// parseDatagramHop splits a hop packet into its header and payload. The payload
// aliases pkt, so callers must not reuse pkt before they are done with it.
func parseDatagramHop(pkt []byte) (datagramHopHeader, []byte, error) {
	if len(pkt) < datagramHopHeaderSize {
		return datagramHopHeader{}, nil, fmt.Errorf("%w: %d bytes", errDatagramHopShort, len(pkt))
	}
	if [4]byte(pkt[0:4]) != datagramHopMagic {
		return datagramHopHeader{}, nil, errDatagramHopMagic
	}
	if pkt[4] != datagramHopVersion {
		return datagramHopHeader{}, nil, fmt.Errorf("%w: %d", errDatagramHopVersion, pkt[4])
	}
	payload := pkt[datagramHopHeaderSize:]
	// The ceiling is enforced on parse as well as on build: the ingress cannot
	// know how big the peer's budget is, and a packet that arrived over a path
	// with a larger MTU must not be forwarded into a payload the exit cannot
	// reply to symmetrically.
	if len(payload) > datagramHopMaxPayload {
		return datagramHopHeader{}, nil, fmt.Errorf("%w: %d > %d", errDatagramHopPayload, len(payload), datagramHopMaxPayload)
	}
	return datagramHopHeader{
		MappingID:  binary.BigEndian.Uint32(pkt[8:12]),
		Generation: binary.BigEndian.Uint32(pkt[12:16]),
	}, payload, nil
}

// datagramHopIdentity is one relay runtime's hop identity: the generation seed
// every packet carries, plus the mapping-id allocator behind it.
//
// It is plain data owned by the runtime; it deliberately has no sockets and no
// goroutines so it can be unit-tested without a data plane (the framing and the
// allocator are the two parts of B2 that are pure logic — everything else about
// the hop needs a real socket, which is why the contract puts those properties in
// the Gate rather than in a mock).
type datagramHopIdentity struct {
	generation uint32
	next       atomic.Uint32
}

// newDatagramHopIdentity seeds a runtime's generation from the OS CSPRNG.
//
// A failure is returned instead of swallowed: a generation nobody can predict is
// not a security boundary in v1 (there is no hop authentication), but a
// generation that silently collapses to a constant would make two concurrent
// incarnations indistinguishable, and that IS a correctness boundary (stale
// replies must never reach a live client).
func newDatagramHopIdentity() (*datagramHopIdentity, error) {
	var seed [4]byte
	if _, err := rand.Read(seed[:]); err != nil {
		return nil, fmt.Errorf("forwarder: seed datagram hop generation: %w", err)
	}
	generation := binary.BigEndian.Uint32(seed[:])
	if generation == 0 {
		// 0 is kept out of the space so a zero-valued header is never a valid
		// packet: it makes "unset" detectable in tests and in logs.
		generation = 1
	}
	return &datagramHopIdentity{generation: generation}, nil
}

// nextMappingID returns the next mapping id, or false when the id space is
// exhausted.
//
// Ids start at 1 and are never reused inside one runtime: a reused id is what
// would let a late reply for a recycled mapping be delivered to a NEW client
// (contract §9.1). Exhaustion is refused rather than wrapped — dropping a new
// datagram is a bounded, countable failure, while wrapping silently breaks the
// "never reused" invariant that the return path depends on.
func (id *datagramHopIdentity) nextMappingID() (uint32, bool) {
	for {
		cur := id.next.Load()
		next := cur + 1
		if next == 0 {
			return 0, false
		}
		if id.next.CompareAndSwap(cur, next) {
			return next, true
		}
	}
}
