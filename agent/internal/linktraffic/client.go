// Package linktraffic delivers durable FXP payload facts over the authenticated
// Agent-to-Panel channel. It does not own counters or the accounting ledger.
package linktraffic

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/tunex/agent/internal/linkrunner"
)

const maxBytes = 1 << 20
const maxSamples = 2048

var (
	ErrInvalid     = errors.New("link traffic: invalid request or acknowledgement")
	ErrUnavailable = errors.New("link traffic: panel unavailable")
	ErrRejected    = errors.New("link traffic: panel rejected report")
)

type Client struct {
	// PanelURL reads the process-wide active route at the time of each request.
	PanelURL   func() string
	Credential string
	HTTP       *http.Client
}

// Post acknowledges only exactly the persisted samples returned by the panel.
// An HTTP success, missing field or mismatched sample is not a storage ACK.
func (c Client) Post(ctx context.Context, samples []linkrunner.TrafficSample) ([]linkrunner.TrafficSample, error) {
	if c.PanelURL == nil || len(samples) == 0 || len(samples) > maxSamples || strings.TrimSpace(c.Credential) == "" {
		return nil, ErrInvalid
	}
	base := strings.TrimRight(strings.TrimSpace(c.PanelURL()), "/")
	u, err := url.Parse(base)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, ErrInvalid
	}
	body, err := json.Marshal(struct {
		Samples []linkrunner.TrafficSample `json:"samples"`
	}{samples})
	if err != nil || len(body) > maxBytes {
		return nil, ErrInvalid
	}
	client := http.Client{Timeout: 12 * time.Second}
	if c.HTTP != nil {
		client = *c.HTTP
		if client.Timeout == 0 {
			client.Timeout = 12 * time.Second
		}
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/api/internal/node/link-traffic", bytes.NewReader(body))
	if err != nil {
		return nil, ErrInvalid
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(c.Credential))
	resp, err := client.Do(req)
	if err != nil {
		return nil, ErrUnavailable
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 500 {
		return nil, ErrUnavailable
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, ErrRejected
	}
	answer, err := io.ReadAll(io.LimitReader(resp.Body, maxBytes+1))
	if err != nil {
		return nil, ErrUnavailable
	}
	if len(answer) > maxBytes {
		return nil, ErrInvalid
	}
	var env struct {
		Data *struct {
			Accepted *[]linkrunner.TrafficSample `json:"accepted"`
		} `json:"data"`
	}
	decoder := json.NewDecoder(bytes.NewReader(answer))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&env) != nil || decoder.Decode(new(any)) != io.EOF || env.Data == nil || env.Data.Accepted == nil {
		return nil, ErrInvalid
	}
	accepted := *env.Data.Accepted
	if len(accepted) != len(samples) {
		return nil, ErrInvalid
	}
	// Map exact wire shapes rather than process-specific fields; this also
	// rejects duplicate input or fabricated acknowledgements.
	set := make(map[string]bool, len(samples))
	for _, sample := range samples {
		raw, _ := json.Marshal(sample)
		key := string(raw)
		if set[key] {
			return nil, ErrInvalid
		}
		set[key] = true
	}
	for _, sample := range accepted {
		raw, _ := json.Marshal(sample)
		key := string(raw)
		if !set[key] {
			return nil, ErrInvalid
		}
		delete(set, key)
	}
	return accepted, nil
}
