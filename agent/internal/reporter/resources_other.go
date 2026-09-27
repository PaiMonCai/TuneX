//go:build !linux

// Fallback host sampler for non-Linux builds (darwin dev boxes / CI matrices).
//
// The production target is linux (see Dockerfile and the release cross-compile
// step); this file exists so `go build ./...` and `go test ./...` stay green on
// a developer's machine. It reports identity plus the portable CPU count and
// nothing else — a node on a non-linux platform reports *fewer facts*, never
// invented ones.
package reporter

import (
	"os"
	"runtime"
)

// SystemSampler is the non-linux sampler: identity + CPU count only.
type SystemSampler struct {
	// DiskPath is ignored here; kept so the constructor signature matches the
	// linux implementation and main can stay platform-agnostic.
	DiskPath string
}

// NewSystemSampler builds the fallback sampler.
func NewSystemSampler(diskPath string) *SystemSampler {
	return &SystemSampler{DiskPath: diskPath}
}

// Identity reports hostname/OS/arch.
func (s *SystemSampler) Identity() Identity {
	host, err := os.Hostname()
	if err != nil {
		host = ""
	}
	return Identity{Hostname: host, OS: runtime.GOOS, Arch: runtime.GOARCH}
}

// Sample reports the CPU count only: no load averages, memory or disk facts
// are available through the standard library off linux.
func (s *SystemSampler) Sample() HostStats {
	return HostStats{CPUCount: runtime.NumCPU()}
}
