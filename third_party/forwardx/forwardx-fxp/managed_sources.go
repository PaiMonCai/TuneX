package main

// TuneX adapts the upstream PROXY codec and IP_HASH selector, not HTTP headers.
// Only the identified ingress is trusted to attest a client's source address.
import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/netip"
	"reflect"
	"strconv"
	"strings"
	"time"
)

const managedSourceTimeout = 5 * time.Second
const managedSourceHeaderMax = 536

// Shared by all entry rules in this process, not 128 slots per each of 500 rules.
var managedSourceHandshakes = make(chan struct{}, 128)

type managedClientSource struct {
	Version      int      `json:"version"`
	RuleID       int      `json:"ruleId,omitempty"`
	ReceiveProxy bool     `json:"receiveProxy"`
	TrustedCIDRs []string `json:"trustedCIDRs"`
	SendProxy    string   `json:"sendProxy"`
}

func (source *managedClientSource) UnmarshalJSON(data []byte) error {
	type plain managedClientSource
	var decoded plain
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&decoded); err != nil {
		return err
	}
	if dec.Decode(new(any)) != io.EOF {
		return errors.New("invalid source policy JSON")
	}
	*source = managedClientSource(decoded)
	return nil
}

func enableManagedSources(cfg *config, enabled bool) {
	cfg.managedSourcesV1 = enabled
	for i := range cfg.Entries {
		enableManagedSources(&cfg.Entries[i], enabled)
	}
}

func validManagedSource(source managedClientSource) bool {
	if source.Version != 1 || (source.SendProxy != "off" && source.SendProxy != "v1" && source.SendProxy != "v2") ||
		len(source.TrustedCIDRs) > 32 || (source.ReceiveProxy != (len(source.TrustedCIDRs) > 0)) {
		return false
	}
	seen := map[string]bool{}
	for _, text := range source.TrustedCIDRs {
		prefix, err := netip.ParsePrefix(text)
		if err != nil || prefix.Bits() == 0 || prefix.Addr().Is4In6() || prefix.Masked().String() != text || seen[text] {
			return false
		}
		seen[text] = true
	}
	return true
}

func managedSourceFor(cfg config, rule int) *managedClientSource {
	for i := range cfg.ClientSources {
		if cfg.ClientSources[i].RuleID == rule {
			return &cfg.ClientSources[i]
		}
	}
	return nil
}

func validateManagedSources(cfg config) error {
	bad := func() error { return errors.New("invalid managed client source policy") }
	if cfg.ClientSource != nil || len(cfg.ClientSources) > 0 {
		if !cfg.managedSourcesV1 || cfg.TunnelID <= 0 || cfg.ProxyProtocolReceive || cfg.ProxyProtocolSend || cfg.ProxyProtocolExitReceive || cfg.ProxyProtocolExitSend {
			return bad()
		}
	}
	if cfg.ClientSource != nil && (cfg.Role != "entry" || cfg.Protocol != "tcp" || cfg.RuleID <= 0 ||
		cfg.ClientSource.RuleID != 0 || !validManagedSource(*cfg.ClientSource) || len(cfg.ClientSources) > 0) {
		return bad()
	}
	if len(cfg.ClientSources) > 0 {
		if cfg.Role != "exit" || !cfg.RequireBindingAuth || len(cfg.ClientSources) > managedTargetMaxRules {
			return bad()
		}
		seen := map[int]bool{}
		for _, source := range cfg.ClientSources {
			if !validManagedSource(source) || source.RuleID <= 0 || seen[source.RuleID] {
				return bad()
			}
			seen[source.RuleID] = true
			bound := false
			for _, binding := range cfg.AllowedBindings {
				if binding.RuleID == source.RuleID {
					if binding.Protocol != "tcp" {
						return bad()
					}
					bound = true
				}
			}
			if !bound {
				return bad()
			}
		}
	}
	if cfg.TargetSet != nil && cfg.TargetSet.Strategy == "ip_hash" && (cfg.ClientSource == nil || cfg.Protocol != "tcp" || !cfg.managedSourcesV1) {
		return bad()
	}
	for _, set := range cfg.TargetSets {
		if set.Strategy == "ip_hash" && (set.Protocol != "tcp" || managedSourceFor(cfg, set.RuleID) == nil || !cfg.managedSourcesV1) {
			return bad()
		}
	}
	for _, entry := range cfg.Entries {
		if err := validateManagedSources(entry); err != nil {
			return err
		}
	}
	return nil
}

func managedSourceDigest(source managedClientSource) string {
	source.RuleID = 0 // Binding identity is separately authenticated in Hello.
	raw, _ := json.Marshal(source)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func sourceIP(text string) (netip.Addr, bool) {
	ip, err := netip.ParseAddr(text)
	if err != nil || ip.Zone() != "" {
		return netip.Addr{}, false
	}
	ip = ip.Unmap()
	return ip, !ip.IsUnspecified() && !ip.IsMulticast()
}

func validSourceInfo(info proxyProtocolInfo) bool {
	src, ok := sourceIP(info.SourceIP)
	dst, destOK := sourceIP(info.DestIP)
	return ok && destOK && src.Is4() == dst.Is4() && info.SourcePort > 0 && info.SourcePort <= 65535 && info.DestPort > 0 && info.DestPort <= 65535
}

// Read only a header, never a payload-sized allocation. One absolute deadline
// covers all fragments; upstream's sliding read deadline is not used here.
func readManagedProxyHeader(conn net.Conn, timeout time.Duration) (proxyProtocolInfo, error) {
	if err := conn.SetReadDeadline(time.Now().Add(timeout)); err != nil {
		return proxyProtocolInfo{}, err
	}
	defer conn.SetReadDeadline(time.Time{})
	buf := make([]byte, 6)
	if _, err := io.ReadFull(conn, buf); err != nil {
		return proxyProtocolInfo{}, err
	}
	if bytes.Equal(buf, []byte("PROXY ")) {
		for !bytes.HasSuffix(buf, []byte("\r\n")) {
			if len(buf) >= 108 {
				return proxyProtocolInfo{}, errors.New("PROXY header too long")
			}
			var ch [1]byte
			if _, err := io.ReadFull(conn, ch[:]); err != nil {
				return proxyProtocolInfo{}, err
			}
			buf = append(buf, ch[0])
		}
		parts := strings.Split(string(buf[:len(buf)-2]), " ")
		for _, ch := range buf[:len(buf)-2] {
			if ch < 32 || ch > 126 {
				return proxyProtocolInfo{}, errors.New("invalid PROXY header byte")
			}
		}
		info, rest, ok, err := consumeProxyProtocolV1(buf)
		if err != nil || !ok || len(rest) != 0 || len(parts) != 6 || !validSourceInfo(info) {
			return proxyProtocolInfo{}, errors.New("invalid PROXY source")
		}
		if parts[4] != strconv.Itoa(info.SourcePort) || parts[5] != strconv.Itoa(info.DestPort) {
			return proxyProtocolInfo{}, errors.New("non-canonical PROXY port")
		}
		src, _ := sourceIP(info.SourceIP)
		if (parts[1] == "TCP4") != src.Is4() {
			return proxyProtocolInfo{}, errors.New("PROXY family mismatch")
		}
		rawSource, _ := netip.ParseAddr(parts[2])
		rawDest, _ := netip.ParseAddr(parts[3])
		if rawSource.Is4In6() || rawDest.Is4In6() {
			return proxyProtocolInfo{}, errors.New("PROXY family mismatch")
		}
		info.SourceIP = src.String()
		dst, _ := sourceIP(info.DestIP)
		info.DestIP = dst.String()
		return info, nil
	}
	if !bytes.Equal(buf, proxyProtocolV2Signature[:6]) {
		return proxyProtocolInfo{}, errors.New("missing PROXY header")
	}
	buf = append(buf, make([]byte, 10)...)
	if _, err := io.ReadFull(conn, buf[6:]); err != nil {
		return proxyProtocolInfo{}, err
	}
	length := int(binary.BigEndian.Uint16(buf[14:16]))
	if !bytes.Equal(buf[:12], proxyProtocolV2Signature) || buf[12] != 0x21 || (buf[13] != 0x11 && buf[13] != 0x21) || length > managedSourceHeaderMax-16 {
		return proxyProtocolInfo{}, errors.New("invalid PROXY v2 header")
	}
	buf = append(buf, make([]byte, length)...)
	if _, err := io.ReadFull(conn, buf[16:]); err != nil {
		return proxyProtocolInfo{}, err
	}
	info, rest, ok, err := consumeProxyProtocolV2(buf)
	if err != nil || !ok || len(rest) != 0 || !validSourceInfo(info) {
		return proxyProtocolInfo{}, errors.New("invalid PROXY source")
	}
	src, _ := sourceIP(info.SourceIP)
	dst, _ := sourceIP(info.DestIP)
	if (buf[13] == 0x11) != src.Is4() {
		return proxyProtocolInfo{}, errors.New("PROXY family mismatch")
	}
	info.SourceIP, info.DestIP = src.String(), dst.String()
	return info, nil
}

func readManagedSource(conn net.Conn, source managedClientSource) (proxyProtocolInfo, error) {
	info := proxyProtocolInfoFromConn(conn)
	if !source.ReceiveProxy {
		if !validSourceInfo(info) {
			return proxyProtocolInfo{}, errors.New("invalid socket source")
		}
		src, _ := sourceIP(info.SourceIP)
		dst, _ := sourceIP(info.DestIP)
		info.SourceIP, info.DestIP = src.String(), dst.String()
		return info, nil
	}
	peer, ok := sourceIP(info.SourceIP)
	trusted := false
	if ok {
		for _, text := range source.TrustedCIDRs {
			prefix, err := netip.ParsePrefix(text)
			if err == nil && prefix.Contains(peer) {
				trusted = true
				break
			}
		}
	}
	if !trusted {
		return proxyProtocolInfo{}, errors.New("untrusted PROXY peer")
	}
	return readManagedProxyHeader(conn, managedSourceTimeout)
}

// Called only after binding/target authorization under the managed policy lock.
// Send/version/selection are configuration authority, never Hello authority.
func authorizeManagedSource(cfg config, hello *helloFrame) error {
	source := managedSourceFor(cfg, hello.RuleID)
	if source == nil {
		if hello.SourceVersion != 0 || hello.SourcePolicy != "" {
			return errors.New("unauthorized source policy")
		}
		return nil
	}
	info := proxyProtocolInfo{hello.ProxySourceIP, hello.ProxySourcePort, hello.ProxyDestIP, hello.ProxyDestPort}
	if hello.Network != "tcp" || hello.SourceVersion != 1 || hello.SourcePolicy != managedSourceDigest(*source) || !validSourceInfo(info) {
		return errors.New("invalid authenticated client source")
	}
	src, _ := sourceIP(info.SourceIP)
	dst, _ := sourceIP(info.DestIP)
	hello.ProxySourceIP, hello.ProxyDestIP = src.String(), dst.String()
	hello.SelectionKey = src.String()
	hello.ProxyProtocolExitReceive = true
	hello.ProxyProtocolExitSend = source.SendProxy != "off"
	hello.ProxyProtocolVersion = 1
	if source.SendProxy == "v2" {
		hello.ProxyProtocolVersion = 2
	}
	return nil
}

func sourcePoliciesEqual(a, b config, rule int) bool {
	return reflect.DeepEqual(managedSourceFor(a, rule), managedSourceFor(b, rule))
}

// Linearize authorization + PROXY emission with source revocation. Never hold
// the policy lock over business payload proxying. The bounded header write ends
// before an update can complete; targets are then revoked alongside carriers.
func (s *managedExitState) prepareSourceTCP(sec *secureConn, target net.Conn, hello *helloFrame) error {
	s.mu.RLock()
	defer s.mu.RUnlock()
	policy := s.policy.Load().cfg
	rule, registered := s.clients.Load(sec.conn)
	if !registered || rule.(int) != hello.RuleID || !authorizedTarget(policy, hello.RuleID, "tcp", hello.TargetIP, hello.TargetPort) {
		return errors.New("source carrier or target revoked")
	}
	if err := authorizeManagedSource(policy, hello); err != nil {
		return err
	}
	s.tcpTargets.Store(target, hello.RuleID)
	if !hello.ProxyProtocolExitSend {
		return nil
	}
	if err := target.SetWriteDeadline(time.Now().Add(time.Second)); err != nil {
		return err
	}
	defer target.SetWriteDeadline(time.Time{})
	header := formatProxyProtocol(*hello)
	for len(header) > 0 {
		n, err := target.Write(header)
		if err != nil {
			return err
		}
		if n <= 0 {
			return io.ErrShortWrite
		}
		header = header[n:]
	}
	return nil
}

func (s *managedExitState) handleSourceTCP(sec *secureConn, hello helloFrame, target net.Conn) error {
	defer func() {
		_ = target.Close()
		s.tcpTargets.Delete(target)
	}()
	if err := s.prepareSourceTCP(sec, target, &hello); err != nil {
		return err
	}
	return proxyPlainSecure(target, sec, nil, nil, nil)
}
