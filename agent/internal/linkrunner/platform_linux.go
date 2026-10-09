package linkrunner

import (
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
)

func containProcess(cmd *exec.Cmd) (func() error, func(), error) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
	return func() error { return nil }, func() {}, nil
}

func signalStop(p *os.Process) error { return p.Signal(syscall.SIGTERM) }

func replaceFile(from, to string) error {
	if err := os.Rename(from, to); err != nil {
		return err
	}
	d, err := os.Open(filepath.Dir(to))
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
