package linkrunner

import (
	"errors"
	"strings"
	"syscall"
	"testing"
	"time"
)

func lockTrafficSnapshot(t *testing.T, path string) syscall.Handle {
	t.Helper()
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := syscall.CreateFile(name, syscall.GENERIC_READ, 0, nil, syscall.OPEN_EXISTING, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	return handle
}

func TestTrafficWindowsTransientAndPersistentSharingViolations(t *testing.T) {
	for _, transient := range []bool{true, false} {
		t.Run(map[bool]string{true: "transient", false: "persistent"}[transient], func(t *testing.T) {
			m := enabledTrafficManager(t, t.TempDir())
			id := persistTrafficFixture(t, m, trafficIngress(t, 1, 101), strings.Repeat("a", 32), trafficTotals(101, "1"))
			handle := lockTrafficSnapshot(t, m.traffic.path(id, trafficSnapshotSuffix))
			if transient {
				released := make(chan struct{})
				go func() { time.Sleep(10 * time.Millisecond); _ = syscall.CloseHandle(handle); close(released) }()
				samples, err := m.TrafficSamples()
				<-released
				if err != nil || len(samples) != 1 {
					t.Fatal("transient sharing race rejected", samples, err)
				}
			} else {
				_, err := m.TrafficSamples()
				_ = syscall.CloseHandle(handle)
				if !errors.Is(err, ErrTraffic) {
					t.Fatal("persistent unreadability ignored", err)
				}
				if err := m.AckTraffic(nil); err != nil {
					t.Fatal(err)
				}
			}
			assertTrafficFiles(t, m, id, true)
		})
	}
}
