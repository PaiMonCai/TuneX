package netutil

import "syscall"

// syscallStatfs mirrors the fields we need from syscall.Statfs_t so diskUsage
// stays platform-agnostic at the call site.
type syscallStatfs struct {
	Blocks uint64
	Bavail uint64
	Bsize  uint64
}

func statfs(path string, out *syscallStatfs) error {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return err
	}
	out.Blocks = st.Blocks
	out.Bavail = st.Bavail
	out.Bsize = uint64(st.Bsize)
	return nil
}
