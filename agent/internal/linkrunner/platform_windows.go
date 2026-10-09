package linkrunner

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"sync"
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
var thread32First = kernel32.NewProc("Thread32First")
var thread32Next = kernel32.NewProc("Thread32Next")
var openThread = kernel32.NewProc("OpenThread")
var threadProcessID = kernel32.NewProc("GetProcessIdOfThread")
var resumeThread = kernel32.NewProc("ResumeThread")

type threadEntry32 struct {
	Size, Usage, ThreadID, OwnerProcessID uint32
	BasePriority, DeltaPriority           int32
	Flags                                 uint32
}

type jobBasicLimits struct {
	ProcessTime, JobTime         int64
	Flags                        uint32
	MinWorkingSet, MaxWorkingSet uintptr
	ActiveProcesses              uint32
	Affinity                     uintptr
	Priority, Scheduling         uint32
}
type jobExtendedLimits struct {
	Basic jobBasicLimits
	// Win32 aligns the basic limits to 8 bytes; Go/386 only aligns int64 to 4.
	_                                                          [8 - unsafe.Sizeof(uintptr(0))]byte
	IO                                                         [6]uint64
	ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory uintptr
}

func containProcess(cmd *exec.Cmd) (func() error, func(), error) {
	for _, proc := range []*syscall.LazyProc{createJob, setJob, assignJob, thread32First, thread32Next, openThread, threadProcessID, resumeThread} {
		if err := proc.Find(); err != nil {
			return nil, nil, err
		}
	}
	job, _, err := createJob.Call(0, 0)
	if job == 0 {
		return nil, nil, windowsCallError("CreateJobObjectW", err)
	}
	var released sync.Once
	release := func() { released.Do(func() { _ = syscall.CloseHandle(syscall.Handle(job)) }) }
	limits := jobExtendedLimits{}
	limits.Basic.Flags = 0x2000 // KILL_ON_JOB_CLOSE
	ok, _, err := setJob.Call(job, 9, uintptr(unsafe.Pointer(&limits)), unsafe.Sizeof(limits))
	if ok == 0 {
		release()
		return nil, nil, windowsCallError("SetInformationJobObject", err)
	}
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.HideWindow = true
	// Start must not execute child code before attach has established containment.
	// Go closes the initial thread handle, so attach reopens it below.
	cmd.SysProcAttr.CreationFlags |= 0x200 | 0x4 // CREATE_NEW_PROCESS_GROUP | CREATE_SUSPENDED
	attach := func() error {
		if cmd.Process == nil {
			return errors.New("cannot bind an unstarted child")
		}
		h, err := syscall.OpenProcess(0x0100|0x0001, false, uint32(cmd.Process.Pid)) // SET_QUOTA | TERMINATE
		if err != nil {
			return err
		}
		defer syscall.CloseHandle(h)
		ok, _, err := assignJob.Call(job, uintptr(h))
		if ok == 0 {
			return windowsCallError("AssignProcessToJobObject", err)
		}
		return resumeInitialThread(uint32(cmd.Process.Pid))
	}
	return attach, release, nil
}

func windowsCallError(operation string, err error) error {
	if err == nil || errors.Is(err, syscall.Errno(0)) {
		return fmt.Errorf("%s failed without an error code", operation)
	}
	return fmt.Errorf("%s: %w", operation, err)
}

func initialThreadID(pid uint32) (uint32, error) {
	snapshot, err := syscall.CreateToolhelp32Snapshot(syscall.TH32CS_SNAPTHREAD, 0)
	if err != nil {
		return 0, err
	}
	defer syscall.CloseHandle(snapshot)
	var id uint32
	for proc := thread32First; ; proc = thread32Next {
		entry := threadEntry32{Size: uint32(unsafe.Sizeof(threadEntry32{}))}
		ok, _, err := proc.Call(uintptr(snapshot), uintptr(unsafe.Pointer(&entry)))
		if ok == 0 {
			if errors.Is(err, syscall.ERROR_NO_MORE_FILES) {
				break
			}
			return 0, windowsCallError("enumerate child threads", err)
		}
		if entry.Size < uint32(unsafe.Offsetof(entry.OwnerProcessID)+unsafe.Sizeof(entry.OwnerProcessID)) {
			return 0, errors.New("incomplete child thread entry")
		}
		if entry.OwnerProcessID == pid {
			if id != 0 || entry.ThreadID == 0 {
				return 0, errors.New("child does not have exactly one initial thread")
			}
			id = entry.ThreadID
		}
	}
	if id == 0 {
		return 0, errors.New("child initial thread not found")
	}
	return id, nil
}

func resumeInitialThread(pid uint32) error {
	id, err := initialThreadID(pid)
	if err != nil {
		return err
	}
	thread, _, err := openThread.Call(0x0002|0x0800, 0, uintptr(id)) // SUSPEND_RESUME | QUERY_LIMITED_INFORMATION
	if thread == 0 {
		return windowsCallError("OpenThread", err)
	}
	defer syscall.CloseHandle(syscall.Handle(thread))
	owner, _, err := threadProcessID.Call(thread)
	if owner == 0 {
		return windowsCallError("GetProcessIdOfThread", err)
	}
	if uint32(owner) != pid {
		return errors.New("child initial thread owner changed")
	}
	count, _, err := resumeThread.Call(thread)
	if uint32(count) == 0xffffffff {
		return windowsCallError("ResumeThread", err)
	}
	if count != 1 {
		return fmt.Errorf("unexpected child initial thread suspend count: %d", count)
	}
	return nil
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
