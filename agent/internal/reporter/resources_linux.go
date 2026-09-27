//go:build linux

// Linux host sampler: syscall.Sysinfo for load/memory/uptime,
// syscall.Statfs for the data filesystem and /proc/self/statm for the agent's
// own RSS. All standard library, per the agent's "stdlib only" rule — the
// alternative (gopsutil) would add a dependency for four numbers.
//
// Failure discipline: every group is all-or-nothing. A failed statfs yields no
// disk fields rather than "0 bytes total", because the panel thresholds a ratio
// and a zero denominator would be read as a critical node.
package reporter

import (
	"os"
	"runtime"
	"strconv"
	"strings"
	"syscall"
)

// siLoadShift converts syscall.Sysinfo's fixed-point load averages to floats
// (SI_LOAD_SHIFT, linux/bsd ABI constant — not exported by the syscall package).
const siLoadShift = 16

// SystemSampler samples the real host.
type SystemSampler struct {
	// DiskPath is the filesystem whose usage is reported (defaults to "/").
	DiskPath string
}

// NewSystemSampler builds the production sampler. diskPath may be empty.
func NewSystemSampler(diskPath string) *SystemSampler {
	if strings.TrimSpace(diskPath) == "" {
		diskPath = "/"
	}
	return &SystemSampler{DiskPath: diskPath}
}

// Identity reports hostname/OS/arch. Hostname failure is non-fatal: a node in a
// container with no hostname still reports OS/arch.
func (s *SystemSampler) Identity() Identity {
	host, err := os.Hostname()
	if err != nil {
		host = ""
	}
	return Identity{Hostname: host, OS: runtime.GOOS, Arch: runtime.GOARCH}
}

// Sample collects one lightweight snapshot. It never returns an error: a
// partially-available host simply reports fewer fields.
func (s *SystemSampler) Sample() HostStats {
	out := HostStats{CPUCount: runtime.NumCPU()}

	var si syscall.Sysinfo_t
	if err := syscall.Sysinfo(&si); err == nil {
		unit := uint64(si.Unit)
		if unit == 0 {
			unit = 1
		}
		out.Load1 = float64(si.Loads[0]) / (1 << siLoadShift)
		out.Load5 = float64(si.Loads[1]) / (1 << siLoadShift)
		out.Load15 = float64(si.Loads[2]) / (1 << siLoadShift)
		out.LoadValid = true

		total := uint64(si.Totalram) * unit
		free := uint64(si.Freeram) * unit
		if total > 0 {
			out.MemoryTotal = total
			// Guard against a caller-visible negative: Freeram > Totalram has
			// been observed on exotic kernels/containers.
			if free > total {
				free = total
			}
			out.MemoryUsed = total - free
			out.MemoryValid = true
		}
		if si.Uptime > 0 {
			out.HostUptime = uint64(si.Uptime)
			out.HostUpValid = true
		}
	}

	path := s.DiskPath
	if path == "" {
		path = "/"
	}
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err == nil && st.Bsize > 0 {
		bsize := uint64(st.Bsize)
		total := st.Blocks * bsize
		// Bavail (not Bfree) is "available to an unprivileged process", which
		// is the number that actually predicts a write failing.
		free := st.Bavail * bsize
		if total > 0 {
			out.DiskPath = path
			out.DiskTotal = total
			out.DiskFree = free
			out.DiskValid = true
		}
	}

	if rss, ok := processRSSBytes(); ok {
		out.ProcessRSS = rss
		out.ProcessValid = true
	}
	return out
}

// processRSSBytes reads the agent's resident set size from /proc/self/statm
// (field 2 = resident pages). Best effort: no /proc (chroot, exotic runtime)
// just means no process_rss field.
func processRSSBytes() (uint64, bool) {
	raw, err := os.ReadFile("/proc/self/statm")
	if err != nil {
		return 0, false
	}
	fields := strings.Fields(string(raw))
	if len(fields) < 2 {
		return 0, false
	}
	pages, err := strconv.ParseUint(fields[1], 10, 64)
	if err != nil {
		return 0, false
	}
	return pages * uint64(os.Getpagesize()), true
}
