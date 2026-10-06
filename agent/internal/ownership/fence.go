// Package ownership implements the Agent side of multi-ingress ownership,
// fencing, and placement leases.
//
// It owns exactly two mechanisms, and nothing else:
//
//   - the EPOCH FENCE: the node remembers, durably, the highest ownership
//     generation it has ever seen for each tunnel, and refuses to activate one
//     at a lower generation. This is the last line of defence against split
//     brain: it is what still works when the panel misjudges, the network
//     partitions and both nodes are listening. It is deliberately a LOCAL,
//     persisted fact — a node that forgets its epoch after a restart is exactly
//     the node that will serve stale ownership during the next partition;
//   - the LEASE CLOCK: once `lease_expires_at` passes with no newer config
//     arriving, the node stops serving that tunnel. Lease expiry means STOP
//     (fail-safe), because "there may be another owner" is more dangerous than
//     a brief interruption.
//
// What it deliberately does NOT do:
//
//   - it never rewrites desired state. The epoch and the lease are panel facts
//     *about* a tunnel, never a second version of what the tunnel is;
//   - it never guesses an absent field. A config without ownership facts is an
//     older panel and behaves as an unfenced assignment (no refusal, no
//     tracking, no clock) — see forwarder.TunnelConfig's field comment;
//   - it never stops a tunnel for any reason other than a lease the panel
//     itself set and then stopped renewing.
//
// Standard library only, like the rest of the agent module.
package ownership

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// fenceSchemaVersion guards against reading a file this build cannot interpret.
// A mismatch is treated as corrupt (start empty, report), never guessed at.
const fenceSchemaVersion = 1

// MaxFencedTunnels bounds the fence file and the in-memory map. A node serving
// more tunnels than this is far outside the product's shape, and an unbounded
// map written from a control-plane message would be a memory-growth primitive.
const MaxFencedTunnels = 4096

// maxFenceBytes bounds the file read. The fence is a few dozen bytes per tunnel;
// anything near this is corruption or an attack on the state directory.
const maxFenceBytes = 1 << 20

// Fence errors. All non-fatal: an unreadable fence degrades safety, it does not
// stop the node (see OpenFence).
var (
	// ErrFenceCorrupt: the file exists but cannot be interpreted.
	ErrFenceCorrupt = errors.New("ownership: epoch fence is corrupt")
	// ErrFenceIdentityMismatch: the file belongs to another agent id.
	ErrFenceIdentityMismatch = errors.New("ownership: epoch fence belongs to another agent")
	// ErrFenceNotDurable: the fence cannot be persisted (no path configured).
	ErrFenceNotDurable = errors.New("ownership: epoch fence has no durable path")
)

// Fence is the per-tunnel high-water mark of ownership epochs this node has seen.
//
// It is keyed by TUNNEL ID, not by node: an epoch is a generation of one
// Forward's placement lease (placement_lease.tunnel_id is unique), so tunnel B's
// epoch 1 is not "older" than tunnel A's epoch 9. A single node-wide counter
// would refuse freshly created tunnels on any node that had ever served a busy
// one — a self-inflicted outage, not fencing.
//
// The zero value is unusable; call OpenFence.
type Fence struct {
	// Path is the durable file. Empty disables persistence, and then the fence
	// lives only as long as the process — a real degradation, reported by
	// Durable()/LoadError() rather than silently swallowed.
	Path string
	// AgentID keys the file to this agent, so a copied/restored file from
	// another node is refused instead of adopting someone else's generations.
	AgentID string

	mu       sync.Mutex
	highest  map[string]int64
	loaded   bool
	loadErr  error
	refusals int64
	// writes counts durable raises, so a test (and an operator reading /health)
	// can tell "the fence rose and was persisted" from "it only ever changed in
	// memory".
	writes int64
}

// fenceFile is the on-disk record.
type fenceFile struct {
	SchemaVersion int              `json:"schema_version"`
	AgentID       string           `json:"agent_id"`
	Highest       map[string]int64 `json:"highest_epoch"`
	UpdatedAt     string           `json:"updated_at,omitempty"`
}

// OpenFence loads the fence for agentID from path.
//
// It NEVER fails: a missing file is a fresh node, and a corrupt or foreign file
// is reported through LoadError() and then treated as empty. Refusing every
// activation instead would turn a damaged 40-byte file into a whole-node outage,
// and the authority for ownership is the panel's lease table anyway — what the
// fence adds is memory across restarts, which is worth having but not worth
// bricking a node for. The degradation is made visible in three places instead:
// durable=false/load_error in the diag facts, a loud log at startup, and the
// error ledger (so the panel's `last_error` carries it too).
func OpenFence(path, agentID string) *Fence {
	f := &Fence{
		Path:    strings.TrimSpace(path),
		AgentID: strings.TrimSpace(agentID),
		highest: make(map[string]int64),
	}
	f.load()
	return f
}

// load reads the file, folding every failure into loadErr.
func (f *Fence) load() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.loaded = true
	if f.Path == "" {
		f.loadErr = ErrFenceNotDurable
		return
	}
	info, err := os.Lstat(f.Path)
	if err != nil {
		if os.IsNotExist(err) {
			// A fresh node has seen nothing. Not an error.
			return
		}
		f.loadErr = err
		return
	}
	if !info.Mode().IsRegular() {
		f.loadErr = fmt.Errorf("%w: %s is not a regular file", ErrFenceCorrupt, f.Path)
		return
	}
	if info.Size() > maxFenceBytes {
		f.loadErr = fmt.Errorf("%w: %d bytes exceeds %d", ErrFenceCorrupt, info.Size(), maxFenceBytes)
		return
	}
	raw, err := os.ReadFile(f.Path)
	if err != nil {
		f.loadErr = err
		return
	}
	var file fenceFile
	if err := json.Unmarshal(raw, &file); err != nil {
		f.loadErr = fmt.Errorf("%w: %v", ErrFenceCorrupt, err)
		return
	}
	if file.SchemaVersion != fenceSchemaVersion {
		f.loadErr = fmt.Errorf("%w: schema version %d", ErrFenceCorrupt, file.SchemaVersion)
		return
	}
	// A foreign file is refused, not adopted: adopting it would raise this
	// node's fence to a generation from another node's history and could make
	// it refuse activations the panel legitimately sends.
	if f.AgentID != "" && strings.TrimSpace(file.AgentID) != f.AgentID {
		f.loadErr = ErrFenceIdentityMismatch
		return
	}
	if len(file.Highest) > MaxFencedTunnels {
		f.loadErr = fmt.Errorf("%w: %d tunnels exceeds %d", ErrFenceCorrupt, len(file.Highest), MaxFencedTunnels)
		return
	}
	for id, epoch := range file.Highest {
		name := strings.TrimSpace(id)
		if name == "" || name != id || len(name) > 255 || epoch < 0 {
			f.loadErr = fmt.Errorf("%w: invalid entry %q", ErrFenceCorrupt, id)
			f.highest = make(map[string]int64)
			return
		}
		f.highest[name] = epoch
	}
}

// LoadError reports why the durable fence is missing or was ignored (nil when
// the file loaded cleanly, was absent, or persistence is simply not configured —
// see Durable for the last case).
func (f *Fence) LoadError() error {
	if f == nil {
		return nil
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if errors.Is(f.loadErr, ErrFenceNotDurable) {
		return nil
	}
	return f.loadErr
}

// Durable reports whether raises are persisted. False means the fence only
// survives within this process — which an operator (and the panel) must be able
// to see, because it is exactly the case a restart turns into "never saw an
// epoch".
func (f *Fence) Durable() bool {
	if f == nil {
		return false
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.Path != "" && f.durableLocked()
}

// durableLocked reports whether persistence is available (a path is configured
// and nothing has gone permanently wrong with it).
func (f *Fence) durableLocked() bool { return f.Path != "" }

// Highest returns the highest epoch this node has seen for one tunnel (0 = none).
func (f *Fence) Highest(tunnelID string) int64 {
	if f == nil {
		return 0
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.highest[tunnelID]
}

// Refusals returns how many activations this fence has refused since the process
// started. It is the counter behind "a refusal is a fact, not a silent ignore".
func (f *Fence) Refusals() int64 {
	if f == nil {
		return 0
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.refusals
}

// Observe raises the fence for tunnelID to epoch if that is higher, persisting
// the new floor before returning.
//
// It returns the (possibly unchanged) highest value and whether it moved. A
// raise that cannot be persisted is an ERROR and the in-memory floor is left
// alone: remembering a generation we cannot prove we remember is worse than
// failing the activation, because the whole point is surviving a restart. The
// caller decides (the guard refuses the activation) — see Admit.
//
// Lower or equal epochs are a no-op: an epoch is monotone per tunnel, and a
// lower one is exactly what the fence exists to remember.
func (f *Fence) Observe(tunnelID string, epoch int64) (highest int64, moved bool, err error) {
	if f == nil || strings.TrimSpace(tunnelID) == "" || epoch <= 0 {
		return f.Highest(tunnelID), false, nil
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	cur := f.highest[tunnelID]
	if epoch <= cur {
		return cur, false, nil
	}
	if err := f.persistLocked(tunnelID, epoch); err != nil {
		return cur, false, err
	}
	f.highest[tunnelID] = epoch
	f.writes++
	return epoch, true, nil
}

// persistLocked writes the current map plus the new entry, atomically.
//
// The file is written the same way restore.LKG writes the desired-state cache
// (dir 0700, temp file in the same directory, fsync, rename, dir sync): a crash
// mid-write must leave either the old fence or the new one. A fence that is
// half-written is a fence that lies, and it is read on exactly the restart this
// mechanism exists for.
func (f *Fence) persistLocked(tunnelID string, epoch int64) error {
	if f.Path == "" {
		// No durable home configured: the caller still gets the in-memory
		// raise, and Durable()==false plus the diag facts say so.
		return nil
	}
	if f.AgentID == "" {
		return fmt.Errorf("%w: agent id is required to key the fence", ErrFenceCorrupt)
	}
	next := make(map[string]int64, len(f.highest)+1)
	for id, e := range f.highest {
		next[id] = e
	}
	next[tunnelID] = epoch
	if len(next) > MaxFencedTunnels {
		return fmt.Errorf("%w: %d tunnels exceeds %d", ErrFenceCorrupt, len(next), MaxFencedTunnels)
	}
	payload, err := json.Marshal(fenceFile{
		SchemaVersion: fenceSchemaVersion,
		AgentID:       f.AgentID,
		Highest:       next,
		UpdatedAt:     time.Now().UTC().Format(time.RFC3339),
	})
	if err != nil {
		return err
	}

	dir := filepath.Dir(f.Path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if info, err := os.Lstat(f.Path); err == nil && !info.Mode().IsRegular() {
		return fmt.Errorf("%w: %s is not a regular file", ErrFenceCorrupt, f.Path)
	}
	tmp, err := os.CreateTemp(dir, ".epoch-fence-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	cleanup := func() {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
	}
	if err := tmp.Chmod(0o600); err != nil {
		cleanup()
		return err
	}
	if _, err := tmp.Write(payload); err != nil {
		cleanup()
		return err
	}
	if err := tmp.Sync(); err != nil {
		cleanup()
		return err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpName)
		return err
	}
	if err := os.Rename(tmpName, f.Path); err != nil {
		_ = os.Remove(tmpName)
		return err
	}
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		_ = d.Close()
	}
	return nil
}

// FenceFact is one tunnel's fencing state, for logs and the local diag surface.
type FenceFact struct {
	TunnelID     string `json:"tunnel_id"`
	HighestEpoch int64  `json:"highest_epoch"`
}

// Facts returns the fence's state for diagnostics, bounded and sorted.
func (f *Fence) Facts() []FenceFact {
	if f == nil {
		return []FenceFact{}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	ids := make([]string, 0, len(f.highest))
	for id := range f.highest {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	out := make([]FenceFact, 0, len(ids))
	for _, id := range ids {
		out = append(out, FenceFact{TunnelID: id, HighestEpoch: f.highest[id]})
	}
	return out
}

// Writes returns how many durable raises this fence has performed.
func (f *Fence) Writes() int64 {
	if f == nil {
		return 0
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.writes
}
