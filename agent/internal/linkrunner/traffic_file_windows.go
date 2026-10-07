package linkrunner

import (
	"os"
	"syscall"
)

// Pin one inode without following a leaf reparse point, and allow the FXP
// writer to atomically rename while it is being read. os.Open does not grant
// FILE_SHARE_DELETE; path-derived Lstat identities are also loaded lazily by
// os.SameFile on Windows and can describe a subsequent replacement instead.
func openTrafficFile(path string) (*os.File, error) {
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	handle, err := syscall.CreateFile(name, syscall.GENERIC_READ,
		syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE,
		nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(handle), path), nil
}
