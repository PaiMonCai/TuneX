package restore

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// LKG is the node's last-known-good desired state on disk.
//
// Why a cache at all: a node that restarts while the panel is unreachable would
// otherwise come up with no listeners at all, turning a panel outage into a
// customer-visible outage on a machine that is still healthy. The cache is
// therefore a *restart* convenience, never an authority:
//
//   - it is written only from state that actually applied (the caller passes
//     what the manager is running, so a failed apply is never cached);
//   - it is read only when the panel is unreachable (see FetchError.IsOutage);
//   - it is keyed to the immutable agent id, so a copied/restored file on a
//     different agent is rejected instead of adopting someone else's tunnels;
//   - it never stores a credential: only the desired tunnel list and a
//     schema version live in it.
//
// On-disk discipline: directory 0700, file 0600, written through a temp file in
// the same directory followed by fsync + rename, so a crash mid-write leaves
// either the old file or the new one — never a truncated one.
type LKG struct {
	// Path is the cache file. Empty disables the cache entirely.
	Path string
	// MaxBytes bounds the file read from disk (defaults to MaxSnapshotBytes).
	MaxBytes int64
}

// lkgSchemaVersion guards against reading a file written by an incompatible
// agent. A mismatch is corruption from this build's point of view: the file is
// ignored (and left in place for forensics), not guessed at.
const lkgSchemaVersion = 1

// lkgEnvelope is the on-disk record. The agent id is part of it so a cache file
// carried over from another node cannot be adopted.
type lkgEnvelope struct {
	SchemaVersion int      `json:"schema_version"`
	AgentID       string   `json:"agent_id"`
	SavedAt       string   `json:"saved_at"`
	Snapshot      Snapshot `json:"snapshot"`
}

// Cache errors. They are all non-fatal at startup: a broken cache means "no
// cached state", which the caller reports and continues from.
var (
	// ErrLKGDisabled: no path configured.
	ErrLKGDisabled = errors.New("restore: lkg cache is disabled")
	// ErrLKGEmpty: the cache file does not exist yet.
	ErrLKGEmpty = errors.New("restore: lkg cache is empty")
	// ErrLKGCorrupt: the file exists but is unreadable, oversized, of another
	// schema version, or does not satisfy the snapshot contract.
	ErrLKGCorrupt = errors.New("restore: lkg cache is corrupt")
	// ErrLKGIdentityMismatch: the cache belongs to another agent id.
	ErrLKGIdentityMismatch = errors.New("restore: lkg cache belongs to another agent")
)

// Enabled reports whether a path is configured.
func (l LKG) Enabled() bool { return strings.TrimSpace(l.Path) != "" }

// Save atomically writes snap as the node's last known good state.
//
// An EMPTY snapshot is a real answer and IS written ("this node runs nothing"),
// because that is what makes remove-last and suspend-last safe: without it the
// cache keeps the deleted forward and the next panel outage resurrects it.
// `nil` is different — it means "we do not know" — and is refused so a failed
// fetch can never erase the last state that actually worked.
func (l LKG) Save(agentID string, snap *Snapshot) error {
	if !l.Enabled() {
		return ErrLKGDisabled
	}
	id := strings.TrimSpace(agentID)
	if id == "" {
		return fmt.Errorf("%w: agent id is required", ErrLKGIdentityMismatch)
	}
	if snap == nil {
		return ErrLKGEmpty
	}
	if err := snap.Validate(); err != nil {
		return err
	}

	payload, err := json.Marshal(lkgEnvelope{
		SchemaVersion: lkgSchemaVersion,
		AgentID:       id,
		SavedAt:       time.Now().UTC().Format(time.RFC3339),
		Snapshot:      *snap,
	})
	if err != nil {
		return err
	}
	if limit := l.limit(); int64(len(payload)) > limit {
		return fmt.Errorf("%w: %d bytes exceeds %d", ErrLKGCorrupt, len(payload), limit)
	}

	dir := filepath.Dir(l.Path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	// Refuse to write through a symlink: the cache must not be an arbitrary
	// write primitive for whoever can create a file next to it.
	if info, err := os.Lstat(l.Path); err == nil && !info.Mode().IsRegular() {
		return fmt.Errorf("%w: %s is not a regular file", ErrLKGCorrupt, l.Path)
	}

	tmp, err := os.CreateTemp(dir, ".lkg-*.tmp")
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
	// fsync the data before the rename so the rename cannot point at a file
	// whose contents are still in the page cache.
	if err := tmp.Sync(); err != nil {
		cleanup()
		return err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpName)
		return err
	}
	if err := os.Rename(tmpName, l.Path); err != nil {
		_ = os.Remove(tmpName)
		return err
	}
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		_ = d.Close()
	}
	return nil
}

// Load reads and validates the cache for this agent id.
func (l LKG) Load(agentID string) (*Snapshot, error) {
	if !l.Enabled() {
		return nil, ErrLKGDisabled
	}
	info, err := os.Lstat(l.Path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, ErrLKGEmpty
		}
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("%w: %s is not a regular file", ErrLKGCorrupt, l.Path)
	}
	limit := l.limit()
	if info.Size() > limit {
		return nil, fmt.Errorf("%w: %d bytes exceeds %d", ErrLKGCorrupt, info.Size(), limit)
	}

	raw, err := os.ReadFile(l.Path)
	if err != nil {
		return nil, err
	}
	var env lkgEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrLKGCorrupt, err)
	}
	if env.SchemaVersion != lkgSchemaVersion {
		return nil, fmt.Errorf("%w: schema version %d", ErrLKGCorrupt, env.SchemaVersion)
	}
	if strings.TrimSpace(env.AgentID) != strings.TrimSpace(agentID) || strings.TrimSpace(env.AgentID) == "" {
		return nil, ErrLKGIdentityMismatch
	}
	if err := env.Snapshot.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrLKGCorrupt, err)
	}
	snap := env.Snapshot
	return snap.Clone(), nil
}

// Clear removes the cache. It is the explicit "forget the cached state" action
// (used when an operator wants a node to come up empty rather than stale).
func (l LKG) Clear() error {
	if !l.Enabled() {
		return ErrLKGDisabled
	}
	if err := os.Remove(l.Path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func (l LKG) limit() int64 {
	if l.MaxBytes > 0 {
		return l.MaxBytes
	}
	return MaxSnapshotBytes
}
