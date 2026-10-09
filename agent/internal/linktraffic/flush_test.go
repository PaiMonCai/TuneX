package linktraffic

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/tunex/agent/internal/linkrunner"
)

type fixtureStore struct {
	samples   []linkrunner.TrafficSample
	readErr   error
	ackErr    error
	acks      [][]linkrunner.TrafficSample
	emptyAcks int
}

func (s *fixtureStore) TrafficSamples() ([]linkrunner.TrafficSample, error) {
	return append([]linkrunner.TrafficSample(nil), s.samples...), s.readErr
}

func (s *fixtureStore) AckTraffic(samples []linkrunner.TrafficSample) error {
	if s.ackErr != nil {
		return s.ackErr
	}
	if len(samples) == 0 {
		s.emptyAcks++
		return nil
	}
	s.acks = append(s.acks, append([]linkrunner.TrafficSample(nil), samples...))
	return nil
}

func flushFixture(producer string, forward int, day string) linkrunner.TrafficSample {
	s := sampleFixture()
	s.ProducerID, s.ForwardID, s.Date = producer, int64(forward), day
	return s
}

func TestFlushKeepsWholeProducerTogetherAndAcknowledgesExactFacts(t *testing.T) {
	a, b := strings.Repeat("a", 32), strings.Repeat("b", 32)
	store := &fixtureStore{samples: []linkrunner.TrafficSample{
		flushFixture(b, 9, "2026-10-07"), flushFixture(a, 7, "2026-10-07"),
		flushFixture(a, 6, "2026-10-08"), flushFixture(b, 8, "2026-10-07"),
		flushFixture(a, 6, "2026-10-07"),
	}}
	want := [][]linkrunner.TrafficSample{
		{flushFixture(a, 6, "2026-10-07"), flushFixture(a, 6, "2026-10-08"), flushFixture(a, 7, "2026-10-07")},
		{flushFixture(b, 8, "2026-10-07"), flushFixture(b, 9, "2026-10-07")},
	}
	var calls [][]linkrunner.TrafficSample
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Samples []linkrunner.TrafficSample `json:"samples"`
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			t.Error(err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		calls = append(calls, input.Samples)
		_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"accepted": input.Samples}})
	}))
	defer panel.Close()
	if err := Flush(context.Background(), Client{PanelURL: func() string { return panel.URL }, Credential: "fixture"}, store); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(calls, want) || !reflect.DeepEqual(store.acks, want) || store.emptyAcks != 1 {
		t.Fatalf("producer split, reordered or facts changed: calls=%v acks=%v", calls, store.acks)
	}
}

func TestFlushRetryAcknowledgesOnlyPersistedProducer(t *testing.T) {
	a, b := strings.Repeat("a", 32), strings.Repeat("b", 32)
	store := &fixtureStore{samples: []linkrunner.TrafficSample{flushFixture(b, 8, "2026-10-07"), flushFixture(a, 6, "2026-10-07")}}
	failB := true
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Samples []linkrunner.TrafficSample `json:"samples"`
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil || len(input.Samples) != 1 {
			t.Error("malformed report")
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if input.Samples[0].ProducerID == b && failB {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"accepted": input.Samples}})
	}))
	defer panel.Close()
	c := Client{PanelURL: func() string { return panel.URL }, Credential: "fixture"}
	if err := Flush(context.Background(), c, store); !errors.Is(err, ErrUnavailable) {
		t.Fatal("failed transaction was accepted", err)
	}
	if len(store.acks) != 1 || store.acks[0][0].ProducerID != a || store.emptyAcks != 0 {
		t.Fatal("unpersisted producer was acknowledged")
	}
	failB = false
	if err := Flush(context.Background(), c, store); err != nil {
		t.Fatal(err)
	}
	if len(store.acks) != 3 || store.acks[2][0] != store.samples[0] || store.emptyAcks != 1 {
		t.Fatal("retry changed cumulative samples or lost failed producer")
	}
}

func TestFlushDoesNotDeleteOnInvalidACKOrLocalFailure(t *testing.T) {
	local := errors.New("fixture spool error")
	for _, tc := range []struct {
		name   string
		store  fixtureStore
		answer string
		want   error
		calls  int
	}{
		{"read failure", fixtureStore{readErr: local}, "", local, 0},
		{"empty", fixtureStore{}, "", nil, 0},
		{"HTTP success is not ACK", fixtureStore{samples: []linkrunner.TrafficSample{sampleFixture()}}, `{}`, ErrInvalid, 1},
		{"local durable ACK failure", fixtureStore{samples: []linkrunner.TrafficSample{sampleFixture()}, ackErr: local}, "echo", local, 1},
		{"oversize producer cannot be split", fixtureStore{samples: make([]linkrunner.TrafficSample, maxSamples+1)}, "", ErrInvalid, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				if tc.answer != "echo" {
					_, _ = w.Write([]byte(tc.answer))
					return
				}
				var input struct {
					Samples []linkrunner.TrafficSample `json:"samples"`
				}
				if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
					t.Error(err)
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"accepted": input.Samples}})
			}))
			defer panel.Close()
			err := Flush(context.Background(), Client{PanelURL: func() string { return panel.URL }, Credential: "fixture"}, &tc.store)
			if !errors.Is(err, tc.want) || len(tc.store.acks) != 0 || calls != tc.calls {
				t.Fatalf("unsafe cleanup or request: err=%v acks=%v calls=%d", err, tc.store.acks, calls)
			}
			wantEmpty := 0
			if tc.name == "empty" {
				wantEmpty = 1
			}
			if tc.store.emptyAcks != wantEmpty {
				t.Fatalf("empty cleanup calls: got %d want %d", tc.store.emptyAcks, wantEmpty)
			}
		})
	}
}
