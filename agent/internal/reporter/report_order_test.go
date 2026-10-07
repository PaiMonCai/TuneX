package reporter

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/tunex/agent/internal/linkrunner"
	"github.com/tunex/agent/internal/manager"
	"github.com/tunex/agent/internal/portlease"
)

func TestMutationReportWaitsForPeriodicReportAndCollectsFreshPorts(t *testing.T) {
	ports := manager.NewTunnelManager(nil, "127.0.0.1")
	if err := ports.ReserveExternal("link-A", []portlease.Binding{portlease.New("tcp", 22000, "127.0.0.1")}); err != nil {
		t.Fatal(err)
	}
	firstPost := make(chan struct{})
	finishFirst := make(chan struct{})
	var unblock sync.Once
	defer unblock.Do(func() { close(finishFirst) })
	secondPost := make(chan StatePayload, 1)
	posts := 0
	r := New(Config{PanelURL: "http://panel.invalid", Credential: "fixture"},
		WithPorts(ports),
		WithLinkPlacements(func() []linkrunner.Observation { return []linkrunner.Observation{} }),
		WithPost(func(ctx context.Context, _ string, body []byte, _ map[string]string) error {
			var payload StatePayload
			if err := json.Unmarshal(body, &payload); err != nil {
				return err
			}
			posts++
			if posts == 1 {
				if len(payload.UsedPorts) != 1 || payload.UsedPorts[0] != 22000 {
					t.Error("periodic report lost its actual old port facts")
				}
				close(firstPost)
				select {
				case <-finishFirst:
				case <-ctx.Done():
					return ctx.Err()
				}
			} else {
				secondPost <- payload
			}
			return nil
		}),
	)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	periodicDone := make(chan struct{})
	go func() { r.sendState(ctx); close(periodicDone) }()
	select {
	case <-firstPost:
	case <-ctx.Done():
		t.Fatal("periodic report did not start")
	}
	mutationDone := make(chan error, 1)
	go func() { mutationDone <- r.ReportOnce(ctx) }()
	select {
	case <-secondPost:
		t.Fatal("mutation report overtook the in-flight periodic report")
	case <-time.After(40 * time.Millisecond):
	}
	// Change the actual guard while the old report is in flight. Collection
	// must happen after serialization, otherwise the second body still claims A.
	ports.ReleaseExternal("link-A")
	unblock.Do(func() { close(finishFirst) })
	select {
	case payload := <-secondPost:
		if len(payload.UsedPorts) != 0 || payload.LinkPlacements == nil {
			t.Fatalf("fresh report retained deleted port facts: %+v", payload)
		}
	case <-ctx.Done():
		t.Fatal("mutation report did not complete")
	}
	if err := <-mutationDone; err != nil {
		t.Fatal(err)
	}
	<-periodicDone
}
