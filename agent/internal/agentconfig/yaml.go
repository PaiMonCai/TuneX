package agentconfig

import (
	"strconv"
	"strings"
)

// applyYAML applies a *minimal* subset of YAML to cfg.
//
// Supported (enough for $HOME/.tunex-agent.yaml):
//
//	server: https://tunex.example.com:3000
//	token: xxxxxxxx
//	node-id: node-01
//	debug: true
//	pprof-port: 6060
//	connect-ip: ["1.2.3.4", "5.6.7.8"]   # or a bare scalar
//	connect-ip:
//	  - 1.2.3.4
//	  - 5.6.7.8
//
// It intentionally does not support nested maps, anchors or multi-document
// files — the agent config is flat. Unknown keys are ignored.
func applyYAML(cfg *Config, text string) {
	lines := strings.Split(text, "\n")
	for i := 0; i < len(lines); i++ {
		raw := lines[i]
		line := stripComment(raw)
		if strings.TrimSpace(line) == "" {
			continue
		}
		// A leading "- item" continues the previous list key.
		if strings.HasPrefix(strings.TrimSpace(line), "- ") {
			// handled inline below when the key line set pendingList
			continue
		}
		key, val, ok := splitKey(line)
		if !ok {
			continue
		}
		key = normalizeKey(key)
		val = strings.TrimSpace(val)

		// Block list form: key with empty value followed by "- item" lines.
		if val == "" {
			var items []string
			for j := i + 1; j < len(lines); j++ {
				nxt := strings.TrimSpace(stripComment(lines[j]))
				if strings.HasPrefix(nxt, "- ") {
					items = append(items, unquote(strings.TrimSpace(strings.TrimPrefix(nxt, "- "))))
					i = j
					continue
				}
				break
			}
			if len(items) > 0 {
				setList(cfg, key, items)
			}
			continue
		}

		// Inline list [a, b] or scalar.
		if strings.HasPrefix(val, "[") && strings.HasSuffix(val, "]") {
			inner := strings.TrimSuffix(strings.TrimPrefix(val, "["), "]")
			var items []string
			for _, p := range strings.Split(inner, ",") {
				p = unquote(strings.TrimSpace(p))
				if p != "" {
					items = append(items, p)
				}
			}
			setList(cfg, key, items)
			continue
		}
		setScalar(cfg, key, unquote(val))
	}
}

func setScalar(cfg *Config, key, val string) {
	switch key {
	case "server":
		cfg.Server = val
	case "token":
		cfg.Token = val
	case "node-id", "node_id":
		cfg.NodeID = val
	case "debug":
		cfg.Debug = parseBool(val)
	case "listen-ip", "listen_ip":
		cfg.ListenIP = val
	case "port-range", "port_range":
		cfg.PortRange = val
	case "out-interface", "out_interface":
		cfg.OutInterface = val
	case "vnstat-interface", "vnstat_interface":
		cfg.VnstatInterface = val
	case "pprof-port", "pprof_port":
		if n, err := strconv.Atoi(val); err == nil {
			cfg.PprofPort = n
		}
	case "tcp-port":
		cfg.TCPPort = atoi(val)
	case "udp-port":
		cfg.UDPPort = atoi(val)
	case "tls-port":
		cfg.TLSPort = atoi(val)
	case "wss-port":
		cfg.WSSPort = atoi(val)
	case "mtcp-port":
		cfg.MTCPPort = atoi(val)
	case "mtls-port":
		cfg.MTLSPort = atoi(val)
	case "mwss-port":
		cfg.MWSSPort = atoi(val)
	case "quic-port":
		cfg.QUICPort = atoi(val)
	case "tunex-port":
		cfg.TunexPort = atoi(val)
	case "connect-ip", "connect_ip":
		cfg.ConnectIP = []string{val}
	}
}

func setList(cfg *Config, key string, items []string) {
	switch key {
	case "connect-ip", "connect_ip":
		cfg.ConnectIP = items
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
