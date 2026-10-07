package linkrunner

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
	"time"
	"unsafe"
)

var kernel32 = syscall.NewLazyDLL("kernel32.dll")
var createJob = kernel32.NewProc("CreateJobObjectW")
var setJob = kernel32.NewProc("SetInformationJobObject")
var assignJob = kernel32.NewProc("AssignProcessToJobObject")
var consoleBreak = kernel32.NewProc("GenerateConsoleCtrlEvent")
var moveFile = kernel32.NewProc("MoveFileExW")

type jobBasicLimits struct {
	ProcessTime, JobTime         int64
	Flags                        uint32
	MinWorkingSet, MaxWorkingSet uintptr
	ActiveProcesses              uint32
	Affinity                     uintptr
	Priority, Scheduling         uint32
}
type jobExtendedLimits struct {
	Basic                                                      jobBasicLimits
	IO                                                         [6]uint64
	ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory uintptr
}

func containProcess(cmd *exec.Cmd) (func() error, func(), error) {
	job, _, err := createJob.Call(0, 0)
	if job == 0 {
		return nil, nil, err
	}
	release := func() { _ = syscall.CloseHandle(syscall.Handle(job)) }
	limits := jobExtendedLimits{}
	limits.Basic.Flags = 0x2000 // KILL_ON_JOB_CLOSE
	ok, _, err := setJob.Call(job, 9, uintptr(unsafe.Pointer(&limits)), unsafe.Sizeof(limits))
	if ok == 0 {
		release()
		return nil, nil, err
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x200} // New console process group.
	attach := func() error {
		h, err := syscall.OpenProcess(0x0100|0x0001, false, uint32(cmd.Process.Pid)) // SET_QUOTA | TERMINATE
		if err != nil {
			return err
		}
		defer syscall.CloseHandle(h)
		ok, _, err := assignJob.Call(job, uintptr(h))
		if ok == 0 {
			return err
		}
		return nil
	}
	return attach, release, nil
}

func signalStop(p *os.Process) error {
	ok, _, err := consoleBreak.Call(1, uintptr(p.Pid)) // CTRL_BREAK_EVENT, isolated group only.
	if ok == 0 {
		return err
	}
	return nil
}

func replaceFile(from, to string) error {
	f, err := syscall.UTF16PtrFromString(from)
	if err != nil {
		return err
	}
	t, err := syscall.UTF16PtrFromString(to)
	if err != nil {
		return err
	}
	// FXP's private file reader can briefly hold a Windows handle without
	// FILE_SHARE_DELETE. Keep atomic replacement, retry only transient sharing
	// or access errors within a bounded interval, and never unlink first.
	deadline := time.Now().Add(500 * time.Millisecond)
	for {
		ok, _, moveErr := moveFile.Call(uintptr(unsafe.Pointer(f)), uintptr(unsafe.Pointer(t)), 0x1|0x8)
		if ok != 0 {
			return nil
		}
		if !time.Now().Before(deadline) || !(errors.Is(moveErr, syscall.Errno(32)) || errors.Is(moveErr, syscall.Errno(33)) || errors.Is(moveErr, syscall.Errno(5))) {
			return moveErr
		}
		time.Sleep(5 * time.Millisecond)
	}
}
