//go:build !linux && !windows

package main

import (
	"errors"
	"os"
)

func openManagedTrafficControl(string) (*os.File, error) {
	return nil, errors.New("managed traffic rotation unsupported on this platform")
}
