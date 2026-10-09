package main

import (
	"os"
	"syscall"
)

func openManagedTrafficControl(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
}
