package agentconfig

import (
	"strconv"
	"strings"
)

// applyYAML applies a *minimal* subset of YAML to cfg.
//
// Supported (enough for $HOME/.tunex-agent.yaml):
//
//	node-id: node-01
//	role: BOTH
//	debug: true
//	panel-http-url: http://panel:3001
//	agent-admin-port: 9090
//	agent-admin-token: xxxxxxxx
//	ingress-range: 10000-30000
//	egress-range: 30001-60000
//	node-credential: xxxxxxxx
//
// It intentionally does not support nested maps, anchors or multi-document
// files — the agent config is flat. Unknown keys are ignored, so a config file
// written before WP15 still loads; its legacy keys (server, token, port-range,
// the per-protocol fixed ports, connect-ip) simply have no effect any more
// because the legacy data plane they configured no longer exists.
func applyYAML(cfg *Config, text string) {
	lines := strings.Split(text, "\n")
	for i := 0; i < len(lines); i++ {
		line := stripComment(lines[i])
		if strings.TrimSpace(line) == "" {
			continue
		}
		key, val, ok := splitKey(line)
		if !ok {
			continue
		}
		key = normalizeKey(key)
		val = strings.TrimSpace(val)
		if val == "" {
			continue
		}
		// A trailing "- item" list block belongs to a previous key; the v3
		// config is flat with no list values, so these lines carry nothing.
		if strings.HasPrefix(strings.TrimSpace(line), "- ") {
			continue
		}
		setScalar(cfg, key, unquote(val))
	}
}

// setScalar applies the survivors of the legacy/​v3 key merge: the v3 runtime's
// own configuration only.
func setScalar(cfg *Config, key, val string) {
	switch key {
	case "node-id", "node_id":
		cfg.NodeID = val
	case "debug":
		cfg.Debug = parseBool(val)
	case "listen-ip", "listen_ip":
		cfg.ListenIP = val
	case "role":
		cfg.Role = val
	case "panel-http-url", "panel_http_url":
		cfg.PanelHTTPURL = val
	case "agent-admin-token", "agent_admin_token":
		cfg.AgentAdminToken = val
	case "agent-admin-port", "agent_admin_port":
		cfg.AgentAdminPort = atoi(val)
	case "ingress-range", "ingress_range":
		cfg.IngressRange = val
	case "egress-range", "egress_range":
		cfg.EgressRange = val
	case "node-credential", "node_credential":
		cfg.NodeCredential = val
	}
}

func atoi(s string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(s))
	return n
}

func parseBool(s string) bool {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "true", "1", "yes", "on":
		return true
	}
	return false
}

func splitKey(line string) (key, val string, ok bool) {
	idx := strings.Index(line, ":")
	if idx < 0 {
		return "", "", false
	}
	return line[:idx], line[idx+1:], true
}

func normalizeKey(k string) string {
	return strings.Trim(strings.TrimSpace(k), `"'`)
}

func unquote(s string) string {
	s = strings.TrimSpace(s)
	if len(s) >= 2 {
		if (s[0] == '"' && s[len(s)-1] == '"') || (s[0] == '\'' && s[len(s)-1] == '\'') {
			return s[1 : len(s)-1]
		}
	}
	return s
}

func stripComment(line string) string {
	inSingle, inDouble := false, false
	for i := 0; i < len(line); i++ {
		switch line[i] {
		case '\'':
			if !inDouble {
				inSingle = !inSingle
			}
		case '"':
			if !inSingle {
				inDouble = !inDouble
			}
		case '#':
			if !inSingle && !inDouble && (i == 0 || line[i-1] == ' ' || line[i-1] == '\t') {
				return line[:i]
			}
		}
	}
	return line
}
