package selfinfo

import (
	"os"
	"path/filepath"

	"github.com/tunex/agent/internal/restore"
)

// LKGProbe describes the last-known-good cache WITHOUT reading its contents.
//
// It exists so the bundle can answer "is my durable state there and plausible?"
// while never turning a diagnostic into a file-reading primitive: the only path
// it will ever touch is the LKG path the agent itself owns.
type LKGProbe struct {
	Cache restore.LKG
	// AgentID is required to validate the cache: the file is bound to this
	// agent's identity, so loading it with an empty id would always report
	// "invalid" and turn a normal node into a false finding.
	AgentID string
}

// Describe implements StateDirProbe.
func (p LKGProbe) Describe() (StateDirFacts, error) {
	out := StateDirFacts{Configured: p.Cache.Enabled()}
	if !p.Cache.Enabled() {
		return out, nil
	}
	out.Path = p.Cache.Path
	dir := filepath.Dir(p.Cache.Path)
	if info, err := os.Stat(dir); err == nil && info.IsDir() {
		out.DirExists = true
	}

	info, err := os.Lstat(p.Cache.Path)
	if err != nil {
		// Absent (or unreadable) is a fact the operator needs, not an error: a
		// node that has never cached anything is a normal first-boot state.
		return out, nil
	}
	if !info.Mode().IsRegular() {
		// A symlink or device here is a real finding: the agent refuses to write
		// through it, so the node's durability is compromised.
		return out, nil
	}
	out.CachePresent = true
	out.CacheModTime = info.ModTime().UTC().Format("2006-01-02T15:04:05Z07:00")

	// Validation runs the SAME check the restart path runs, with the node's own
	// identity, so "valid" here really means "this node would come back from an
	// outage with this state".
	if p.AgentID != "" {
		if snap, err := p.Cache.Load(p.AgentID); err == nil && snap != nil {
			out.CacheValid = true
		}
	}
	return out, nil
}
