package linkrunner

import (
	"os"
	"syscall"
)

// A rename may replace the name but cannot change this pinned handle. Reject
// a symlink swapped in between the caller's Lstat and this open at the kernel.
func openTrafficFile(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
}
