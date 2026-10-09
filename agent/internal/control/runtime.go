package control

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"github.com/tunex/agent/internal/linkrunner"
)

const DefaultFXPBinary = "/usr/local/bin/tunex-fxp"

// NewLinkRuntime is deliberately opt-in. Setting a path alone does not enable
// capability advertising. It has no relationship to the public support gate.
func NewLinkRuntime(stateDir, agentID string, guard linkrunner.PortGuard) (*linkrunner.Manager, RuntimeFacts, error) {
	enabled, _ := strconv.ParseBool(strings.TrimSpace(os.Getenv("TUNEX_FXP_LINKS_ENABLED")))
	if !enabled {
		return nil, RuntimeFacts{}, nil
	}
	binary := strings.TrimSpace(os.Getenv("TUNEX_FXP_BINARY"))
	if binary == "" {
		binary = DefaultFXPBinary
	}
	info, err := os.Stat(binary)
	if err != nil || !info.Mode().IsRegular() || (runtime.GOOS != "windows" && info.Mode().Perm()&0o111 == 0) {
		return nil, RuntimeFacts{}, linkrunner.ErrStartFailed
	}
	if stateDir == "" {
		return nil, RuntimeFacts{}, linkrunner.ErrCache
	}
	links, err := linkrunner.New(binary, filepath.Join(stateDir, "linkrunner"), agentID)
	if err != nil {
		return nil, RuntimeFacts{}, err
	}
	if guard == nil {
		_ = links.Close()
		return nil, RuntimeFacts{}, linkrunner.ErrPortConflict
	}
	if err := links.SetPortGuard(guard); err != nil {
		_ = links.Close()
		return nil, RuntimeFacts{}, err
	}
	return links, RuntimeFacts{FXPLink: true}, nil
}

// RestoreLinks uses private cache only for network/5xx outages. Authorization,
// redirects, malformed snapshots and foreign identity never enable fallback.
func RestoreLinks(ctx context.Context, source linkrunner.HTTPSource, links *linkrunner.Manager) (fromCache bool, err error) {
	if links == nil {
		return false, nil
	}
	snapshot, err := source.FetchSnapshot(ctx)
	if err == nil {
		_, err = links.Reconcile(snapshot)
		return false, err
	}
	if !errors.Is(err, linkrunner.ErrPanelUnavailable) {
		return false, err
	}
	if links.NodeDBID() == 0 {
		return false, linkrunner.ErrIdentityMismatch
	}
	_, err = links.Restore()
	return true, err
}

func linkAckCode(err error) string {
	switch {
	case errors.Is(err, linkrunner.ErrStaleGeneration):
		return "stale_generation"
	case errors.Is(err, linkrunner.ErrGenerationConflict):
		return "generation_conflict"
	case errors.Is(err, linkrunner.ErrLeaseExpired):
		return "lease_expired"
	case errors.Is(err, linkrunner.ErrIdentityMismatch):
		return "identity_mismatch"
	case errors.Is(err, linkrunner.ErrPortConflict):
		return "port_conflict"
	case errors.Is(err, linkrunner.ErrCache):
		return "cache_unavailable"
	case errors.Is(err, linkrunner.ErrReloadRejected):
		return "reload_rejected"
	case errors.Is(err, linkrunner.ErrReloadTimeout):
		return "reload_timeout"
	case errors.Is(err, linkrunner.ErrConfigTampered):
		return "config_tampered"
	case errors.Is(err, linkrunner.ErrInvalidConfig), errors.Is(err, linkrunner.ErrDigestMismatch), errors.Is(err, linkrunner.ErrLeaseRegression):
		return "invalid_payload"
	default:
		return "link_failed"
	}
}
