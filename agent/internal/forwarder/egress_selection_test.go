package forwarder

import (
	"io"
	"net"
	"reflect"
	"strconv"
	"sync"
	"testing"
	"time"
)

type selectionOutcome struct {
	target Target
	ok     bool
}

type sourceRecordingSelector struct {
	mu          sync.Mutex
	targets     []Target
	sources     []string
	legacyCalls int
	outcomes    []selectionOutcome
}

func (s *sourceRecordingSelector) Select() Target {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.legacyCalls++
	if len(s.targets) == 0 {
		return Target{}
	}
	return s.targets[0]
}

func (s *sourceRecordingSelector) SelectForClient(source string) Target {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sources = append(s.sources, source)
	if len(s.targets) == 0 {
		return Target{}
	}
	return s.targets[(len(s.sources)-1)%len(s.targets)]
}

func (s *sourceRecordingSelector) ReportDial(target Target, ok bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.outcomes = append(s.outcomes, selectionOutcome{target, ok})
}

func (s *sourceRecordingSelector) snapshot() ([]string, int, []selectionOutcome) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.sources...), s.legacyCalls, append([]selectionOutcome(nil), s.outcomes...)
}

func TestEgressClientSourceIsExplicitAndOptional(t *testing.T) {
	up, stop := echoTarget(t)
	defer stop()
	target := Target{Host: "127.0.0.1", Port: targetPortOf(t, up)}
	for _, trusted := range []bool{false, true} {
		t.Run(map[bool]string{false: "legacy-relay", true: "trusted-direct"}[trusted], func(t *testing.T) {
			sel := &sourceRecordingSelector{targets: []Target{target}}
			opts := EgressOptions{}
			if trusted {
				opts.ClientSource = func(c net.Conn) string { return c.RemoteAddr().String() }
			}
			port := freePort(t)
			f, err := NewEgressWithOptions(TunnelConfig{
				ID: "source", Mode: ModeEgress, EgressPort: port, ListenHost: "127.0.0.1",
			}, sel, opts)
			if err != nil {
				t.Fatal(err)
			}
			if err := f.Start(); err != nil {
				t.Fatal(err)
			}
			defer f.Stop()
			c, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), time.Second)
			if err != nil {
				t.Fatal(err)
			}
			defer c.Close()
			_ = c.SetDeadline(time.Now().Add(2 * time.Second))
			if _, err := c.Write([]byte("?")); err != nil {
				t.Fatal(err)
			}
			buf := make([]byte, 1)
			if _, err := io.ReadFull(c, buf); err != nil {
				t.Fatal(err)
			}
			want := ""
			if trusted {
				want = c.LocalAddr().String()
			}
			sources, calls, outcomes := sel.snapshot()
			if !reflect.DeepEqual(sources, []string{want}) || calls != 0 {
				t.Fatalf("selection source = %v, legacy calls = %d, want [%q] / 0", sources, calls, want)
			}
			if !reflect.DeepEqual(outcomes, []selectionOutcome{{target, true}}) {
				t.Fatalf("actual dial outcomes = %+v", outcomes)
			}
		})
	}
}
