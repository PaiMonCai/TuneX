package restore

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

type HTTPSource struct {
	PanelURL string
	Credential string
	Client *http.Client
}

func (s HTTPSource) FetchSnapshot(ctx context.Context) (*Snapshot, error) {
	base := strings.TrimRight(strings.TrimSpace(s.PanelURL), "/")
	cred := strings.TrimSpace(s.Credential)
	if base == "" || cred == "" { return nil, ErrNoPanel }
	client := s.Client
	if client == nil { client = &http.Client{Timeout: FetchTimeout} }
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/api/internal/node/desired", nil)
	if err != nil { return nil, err }
	req.Header.Set("Authorization", "Bearer "+cred)
	resp, err := client.Do(req)
	if err != nil { return nil, err }
	defer resp.Body.Close()
	if resp.StatusCode >= 300 { return nil, fmt.Errorf("restore: desired snapshot status %d", resp.StatusCode) }
	var body struct {
		Data struct {
			Snapshot *Snapshot `json:"snapshot"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil { return nil, err }
	if body.Data.Snapshot == nil { return &Snapshot{}, nil }
	return body.Data.Snapshot, nil
}

var _ Source = HTTPSource{}
