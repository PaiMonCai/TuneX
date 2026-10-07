package linktraffic

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tunex/agent/internal/linkrunner"
)

func sampleFixture() linkrunner.TrafficSample {
	// Keep the fixture on the actual wire contract rather than assuming an
	// internal field spelling in the collector's representation.
	var sample linkrunner.TrafficSample
	_ = json.Unmarshal([]byte(`{"producer_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","link_id":3,"workspace_id":4,"node_id":5,"forward_id":6,"generation":7,"config_digest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","date":"2026-10-07","bytes_in":"41","bytes_out":"43","connections":"1"}`), &sample)
	return sample
}

func TestAuthenticatedTrafficUsesCurrentRouteAndExactPersistedACK(t *testing.T) {
	samples := []linkrunner.TrafficSample{sampleFixture()}
	calls := 0
	newPanel := func() *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost || r.URL.Path != "/api/internal/node/link-traffic" || r.Header.Get("Authorization") != "Bearer fixture-credential" {
				t.Error("traffic did not use authenticated node channel")
			}
			var input struct {
				Samples []linkrunner.TrafficSample `json:"samples"`
			}
			if err := json.NewDecoder(r.Body).Decode(&input); err != nil || len(input.Samples) != 1 {
				t.Error("malformed cumulative traffic body")
			}
			calls++
			_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"accepted": input.Samples}})
		}))
	}
	a, b := newPanel(), newPanel()
	defer a.Close()
	defer b.Close()
	active := a.URL
	c := Client{PanelURL: func() string { return active }, Credential: "fixture-credential"}
	for _, route := range []string{a.URL, b.URL} {
		active = route
		if accepted, err := c.Post(context.Background(), samples); err != nil || len(accepted) != 1 {
			t.Fatalf("persisted ACK rejected: %v", err)
		}
	}
	if calls != 2 {
		t.Fatal("migration route was not read on each request")
	}
}

func TestTrafficCannotAckOnHTTPStatusMissingOrAlteredFacts(t *testing.T) {
	samples := []linkrunner.TrafficSample{sampleFixture()}
	raw, _ := json.Marshal(samples)
	for _, response := range []string{
		`{}`, `{"data":{"accepted":[]}}`, `{"data":{"ok":true}}`,
		`{"data":{"accepted":` + strings.Replace(string(raw), `"41"`, `"42"`, 1) + `}}`,
		`{"data":{"accepted":` + string(raw) + `}} {}`, strings.Repeat("x", maxBytes+1),
	} {
		s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(response)) }))
		_, err := (Client{PanelURL: func() string { return s.URL }, Credential: "fixture"}).Post(context.Background(), samples)
		s.Close()
		if !errors.Is(err, ErrInvalid) {
			t.Fatal("unconfirmed response acknowledged durable usage", err)
		}
	}
}

func TestTrafficRejectsRedirectAndDoesNotLeakCredentials(t *testing.T) {
	forwarded := false
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { forwarded = true }))
	defer destination.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, destination.URL, http.StatusTemporaryRedirect)
	}))
	defer source.Close()
	_, err := (Client{PanelURL: func() string { return source.URL }, Credential: "fixture-credential", HTTP: &http.Client{}}).Post(context.Background(), []linkrunner.TrafficSample{sampleFixture()})
	if !errors.Is(err, ErrRejected) || forwarded || strings.Contains(err.Error(), "fixture-credential") {
		t.Fatal("redirect leak or unsafe error", err)
	}
}
