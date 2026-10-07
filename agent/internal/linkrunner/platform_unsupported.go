//go:build !linux && !windows

package linkrunner

import (
	"os"
	"os/exec"
)

// Keep native Agent builds portable without pretending to provide the process
// containment or durable replacement guarantees required by managed FXP.
func containProcess(*exec.Cmd) (func() error, func(), error) {
	return nil, nil, ErrStartFailed
}

func signalStop(*os.Process) error     { return ErrProcessExited }
func replaceFile(string, string) error { return ErrCache }
