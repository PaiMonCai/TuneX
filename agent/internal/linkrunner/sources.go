package linkrunner

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"
)

func probeClientSource(binary string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, binary, "-managed-source-capabilities")
	for _, env := range os.Environ() {
		name, _, _ := strings.Cut(env, "=")
		if !strings.EqualFold(name, "AUTH_SECRET") && !strings.EqualFold(name, "NODE_CREDENTIAL") {
			cmd.Env = append(cmd.Env, env)
		}
	}
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &boundedTrafficProbe{buffer: &out}, io.Discard
	if cmd.Run() != nil {
		return false
	}
	var reply struct {
		Source int `json:"managed_source"`
	}
	dec := json.NewDecoder(&out)
	dec.DisallowUnknownFields()
	return dec.Decode(&reply) == nil && dec.Decode(new(any)) == io.EOF && reply.Source == 1
}

func (m *Manager) ClientSourceSupported() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.sourceProbeDone {
		m.sourceSupport, m.sourceProbeDone = probeClientSource(m.binaryPath), true
	}
	return m.sourceSupport
}

func usesClientSource(raw json.RawMessage) bool {
	var cfg struct {
		ClientSource  json.RawMessage   `json:"clientSource"`
		ClientSources json.RawMessage   `json:"clientSources"`
		Entries       []json.RawMessage `json:"entries"`
		TargetSet     *struct {
			Strategy string `json:"strategy"`
		} `json:"targetSet"`
		TargetSets []struct {
			Strategy string `json:"strategy"`
		} `json:"targetSets"`
	}
	if json.Unmarshal(raw, &cfg) != nil {
		return false
	}
	for _, field := range []json.RawMessage{cfg.ClientSource, cfg.ClientSources} {
		if len(field) > 0 && !bytes.Equal(field, []byte("null")) {
			return true
		}
	}
	if cfg.TargetSet != nil && cfg.TargetSet.Strategy == "ip_hash" {
		return true
	}
	for _, set := range cfg.TargetSets {
		if set.Strategy == "ip_hash" {
			return true
		}
	}
	for _, entry := range cfg.Entries {
		if usesClientSource(entry) {
			return true
		}
	}
	return false
}
