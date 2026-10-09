package linkrunner

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
	"unsafe"
)

// These tests execute the actual Windows test exe; the marker is child code's
// first observable side effect, rather than a mock of CreateProcess or a thread.
func windowsJobCommand(t *testing.T, mode, marker, state string) *exec.Cmd {
	t.Helper()
	return exec.Command(helperBinary(t), "-test.run=^TestWindowsJobHelper$", "--", mode, marker, state)
}

func TestWindowsJobHelper(t *testing.T) {
	var args []string
	for i, arg := range os.Args {
		if arg == "--" {
			args = os.Args[i+1:]
			break
		}
	}
	if len(args) != 3 {
		t.Skip("Windows subprocess helper")
	}
	mode, marker, state := args[0], args[1], args[2]
	if mode == "child" {
		if err := os.WriteFile(marker, []byte("running"), 0600); err != nil {
			t.Fatal(err)
		}
	} else {
		cmd := windowsJobCommand(t, "child", marker, "")
		attach, release, err := containProcess(cmd)
		if err != nil {
			t.Fatal(err)
		}
		defer release()
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		if mode == "parent-after-bind" {
			if err := attach(); err != nil {
				_ = cmd.Process.Kill()
				_ = cmd.Wait()
				t.Fatal(err)
			}
		} else if mode != "parent-before-bind" {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
			t.Fatalf("unknown helper mode %q", mode)
		}
		if err := os.WriteFile(state, []byte(strconv.Itoa(cmd.Process.Pid)), 0600); err != nil {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
			t.Fatal(err)
		}
	}
	for {
		time.Sleep(time.Hour)
	}
}

type windowsJobChild struct {
	cmd     *exec.Cmd
	attach  func() error
	release func()
	handle  syscall.Handle
	marker  string
}

func startWindowsJobChild(t *testing.T, attrs *syscall.SysProcAttr) windowsJobChild {
	t.Helper()
	marker := filepath.Join(t.TempDir(), "child-ran")
	cmd := windowsJobCommand(t, "child", marker, "")
	cmd.SysProcAttr = attrs
	attach, release, err := containProcess(cmd)
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		release()
		t.Fatal(err)
	}
	h, err := syscall.OpenProcess(0x100000, false, uint32(cmd.Process.Pid)) // SYNCHRONIZE
	if err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		release()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		_ = syscall.CloseHandle(h)
		release()
	})
	return windowsJobChild{cmd, attach, release, h, marker}
}

func waitWindowsJobFile(t *testing.T, path string) []byte {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		data, err := os.ReadFile(path)
		if err == nil && len(data) > 0 {
			return data
		}
		if err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
		if !time.Now().Before(deadline) {
			t.Fatalf("child did not publish %s", filepath.Base(path))
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func assertWindowsJobNotRunning(t *testing.T, marker string) {
	t.Helper()
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("child executed before containment: stat error %v", err)
	}
}

func waitWindowsJobExit(t *testing.T, handle syscall.Handle) {
	t.Helper()
	result, err := syscall.WaitForSingleObject(handle, 5000)
	if err != nil || result != syscall.WAIT_OBJECT_0 {
		t.Fatalf("child survived termination: wait result=%d error=%v", result, err)
	}
}

func TestWindowsJobSuspendsUntilAssigned(t *testing.T) {
	attrs := &syscall.SysProcAttr{CreationFlags: 0x4000} // BELOW_NORMAL_PRIORITY_CLASS
	child := startWindowsJobChild(t, attrs)
	if child.cmd.SysProcAttr != attrs || attrs.CreationFlags&0x4204 != 0x4204 || !attrs.HideWindow {
		t.Fatalf("lost caller process attributes: %+v", child.cmd.SysProcAttr)
	}
	// Start has returned and closed its thread handle, yet child code cannot run.
	time.Sleep(100 * time.Millisecond)
	assertWindowsJobNotRunning(t, child.marker)
	if err := child.attach(); err != nil {
		t.Fatal(err)
	}
	waitWindowsJobFile(t, child.marker)
	child.release()
	waitWindowsJobExit(t, child.handle)
	child.release() // Cleanup must not close a reused handle.
}

func TestWindowsJobLimitsABI(t *testing.T) {
	var limits jobExtendedLimits
	wantSize, wantIO := uintptr(144), uintptr(64)
	if unsafe.Sizeof(uintptr(0)) == 4 {
		wantSize, wantIO = 112, 48
	}
	if unsafe.Sizeof(limits) != wantSize || unsafe.Offsetof(limits.IO) != wantIO || unsafe.Offsetof(limits.Basic.Flags) != 16 {
		t.Fatalf("wrong Windows job ABI: size=%d IO=%d flags=%d", unsafe.Sizeof(limits), unsafe.Offsetof(limits.IO), unsafe.Offsetof(limits.Basic.Flags))
	}
}

func TestWindowsJobBindFailureKeepsChildSuspended(t *testing.T) {
	child := startWindowsJobChild(t, nil)
	child.release() // Force AssignProcessToJobObject to fail with a closed job.
	if err := child.attach(); err == nil {
		t.Fatal("binding a closed job succeeded")
	}
	assertWindowsJobNotRunning(t, child.marker)
	if _, err := initialThreadID(uint32(child.cmd.Process.Pid)); err != nil {
		t.Fatalf("failed bind changed the suspended child's thread: %v", err)
	}
	// The production caller follows this same kill/wait path on attach errors.
	if err := child.cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	waitWindowsJobExit(t, child.handle)
	assertWindowsJobNotRunning(t, child.marker)
}

func TestWindowsJobRejectsUnexpectedSuspendCount(t *testing.T) {
	child := startWindowsJobChild(t, nil)
	id, err := initialThreadID(uint32(child.cmd.Process.Pid))
	if err != nil {
		t.Fatal(err)
	}
	h, _, callErr := openThread.Call(0x0002, 0, uintptr(id))
	if h == 0 {
		t.Fatal(windowsCallError("OpenThread", callErr))
	}
	defer syscall.CloseHandle(syscall.Handle(h))
	count, _, callErr := kernel32.NewProc("SuspendThread").Call(h)
	if count != 1 {
		t.Fatalf("could not add suspension: count=%d error=%v", count, callErr)
	}
	if err := child.attach(); err == nil || !strings.Contains(err.Error(), "suspend count: 2") {
		t.Fatalf("unexpected suspend count accepted: %v", err)
	}
	assertWindowsJobNotRunning(t, child.marker)
	child.release()
	waitWindowsJobExit(t, child.handle)
}

func TestWindowsJobRejectsMissingOrMultipleThreads(t *testing.T) {
	// The running Go test exe has multiple threads and must never be resumed as
	// a freshly suspended child; an absent PID must also fail closed.
	for _, pid := range []uint32{uint32(os.Getpid()), ^uint32(0)} {
		if _, err := initialThreadID(pid); err == nil {
			t.Fatalf("accepted noninitial threads for PID %d", pid)
		}
	}
}

func TestWindowsJobParentExit(t *testing.T) {
	for _, mode := range []string{"parent-before-bind", "parent-after-bind"} {
		t.Run(mode, func(t *testing.T) {
			dir := t.TempDir()
			marker, state := filepath.Join(dir, "child-ran"), filepath.Join(dir, "child-pid")
			parent := windowsJobCommand(t, mode, marker, state)
			var output bytes.Buffer
			parent.Stdout, parent.Stderr = &output, &output
			if err := parent.Start(); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				_ = parent.Process.Kill()
				_ = parent.Wait()
			})
			pid, err := strconv.ParseUint(string(waitWindowsJobFile(t, state)), 10, 32)
			if err != nil {
				t.Fatal(err)
			}
			h, err := syscall.OpenProcess(0x100000|0x0001, false, uint32(pid)) // SYNCHRONIZE | TERMINATE
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				_ = syscall.TerminateProcess(h, 1)
				_ = syscall.CloseHandle(h)
			})
			if mode == "parent-after-bind" {
				waitWindowsJobFile(t, marker)
			}
			if err := parent.Process.Kill(); err != nil {
				t.Fatal(err)
			}
			if err := parent.Wait(); err == nil {
				t.Fatal("parent was not forcibly terminated")
			}
			if mode == "parent-after-bind" {
				waitWindowsJobExit(t, h)
			} else {
				// Before binding, parent death can leave an unbound process object,
				// but it cannot execute or write statistics. Cleanup kills it above.
				time.Sleep(100 * time.Millisecond)
				assertWindowsJobNotRunning(t, marker)
				if _, err := initialThreadID(uint32(pid)); err != nil {
					t.Fatal(fmt.Errorf("unbound child did not remain suspended: %w", err))
				}
			}
		})
	}
}
