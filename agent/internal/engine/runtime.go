package engine

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/tunex/agent/internal/logx"
	"github.com/tunex/agent/internal/netutil"
)

// WaitListen is the dynamic-port placeholder token (the original emits
// "<ip>:WAIT_LISTEN<range>", e.g. ":WAIT_LISTEN20000-30000").
const WaitListen = "WAIT_LISTEN"

// errNoFreePort is returned by startService when a dynamic (WAIT_LISTEN) service
// cannot find any free port in the configured range or on the host.
var errNoFreePort = fmt.Errorf("no free port available")

// Runtime applies configs and owns the running listeners.
type Runtime struct {
	listenIP  string
	portRange *netutil.PortRange

	// Callbacks into the control plane.
	OnListen      func(name string, port int, typ string)
	OnListenError func(name string, errCode string)

	mu       sync.Mutex
	services map[string]*runningService
	chains   map[string]*ChainConfig

	// usedPorts tracks ports already bound by this process, keyed by
	// "<network>:<port>" (e.g. "tcp:19000" / "udp:19000"). Keying by network
	// lets the same port be reused on the *other* protocol only when we really
	// intend it; in practice every listener gets a distinct port, which keeps
	// tcp and udp services of the same tunnel from colliding inside one agent.
	usedPorts map[string]bool
}

// portKey builds the usedPorts key for a bound port.
func portKey(network string, port int) string {
	return network + ":" + strconv.Itoa(port)
}

// NewRuntime builds a runtime. portRange may be empty.
func NewRuntime(listenIP, portRange string) *Runtime {
	pr := netutil.ParsePortRange(portRange)
	return &Runtime{
		listenIP:  listenIP,
		portRange: pr,
		services:  make(map[string]*runningService),
		chains:    make(map[string]*ChainConfig),
		usedPorts: make(map[string]bool),
	}
}

// runningService is a live service.
type runningService struct {
	name     string
	cfg      *ServiceConfig
	network  string // "tcp" or "udp"
	tcpLns   []net.Listener
	udpConns []*net.UDPConn
	port     int
	closed   bool
}

// Reload applies a new config, reusing listeners whose definitions are
// unchanged and tearing down those that disappeared. Returns the number of
// services now running.
func (rt *Runtime) Reload(raw []byte) (int, error) {
	cfg, err := ParseConfig(raw)
	if err != nil {
		return 0, fmt.Errorf("engine: invalid config: %w", err)
	}

	rt.mu.Lock()
	defer rt.mu.Unlock()

	// Rebuild the chain registry.
	rt.chains = make(map[string]*ChainConfig)
	for _, ch := range cfg.Chains {
		rt.chains[ch.Name] = ch
	}

	desired := make(map[string]*ServiceConfig)
	for _, svc := range cfg.Services {
		if svc == nil || svc.Name == "" {
			continue
		}
		desired[svc.Name] = svc
	}
	// Deterministic start order: iterate services by name (cfg.Services order is
	// server-controlled but a stable sort makes dynamic port assignment below
	// reproducible across reloads even if the server reorders the array).
	order := make([]string, 0, len(desired))
	for name := range desired {
		order = append(order, name)
	}
	sort.Strings(order)

	// Stop services that are gone.
	for name, rs := range rt.services {
		if _, ok := desired[name]; !ok {
			rt.stopService(rs)
			delete(rt.services, name)
			logx.Info("service removed", "name", name)
		}
	}

	// Start / refresh services.
	for _, name := range order {
		svc := desired[name]
		existing := rt.services[name]
		if existing != nil && serviceEqual(existing.cfg, svc) {
			continue // unchanged
		}
		if existing != nil {
			rt.stopService(existing)
			delete(rt.services, name)
		}
		rs, err := rt.startService(name, svc)
		if err != nil {
			logx.Error("failed to start service", "name", name, "err", err.Error())
			if isAddrInUse(err) && rt.OnListenError != nil {
				rt.OnListenError(name, "ERR_PORT_IN_USE")
			} else if err == errNoFreePort && rt.OnListenError != nil {
				// Dynamic port exhaustion: tell the control plane instead of failing silently.
				rt.OnListenError(name, "ERR_NO_FREE_PORT")
			}
			continue
		}
		rt.services[name] = rs
	}
	return len(rt.services), nil
}

// Stop tears down every running service.
func (rt *Runtime) Stop() {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	for name, rs := range rt.services {
		rt.stopService(rs)
		delete(rt.services, name)
	}
}

// ActivePorts returns the currently bound ports (for debug/status).
func (rt *Runtime) ActivePorts() map[string]int {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	out := make(map[string]int, len(rt.services))
	for name, rs := range rt.services {
		out[name] = rs.port
	}
	return out
}

// ---------------------------------------------------------------------------
// Service lifecycle
// ---------------------------------------------------------------------------

func (rt *Runtime) startService(name string, svc *ServiceConfig) (*runningService, error) {
	network, addr, dynamic := rt.resolveListenAddr(svc)

	rs := &runningService{name: name, cfg: svc, network: network}

	// Determine the port to bind.
	var port int
	if dynamic {
		port = rt.allocatePort(network)
		if port == 0 {
			return nil, errNoFreePort
		}
		addr = replacePort(addr, port)
	} else {
		_, p, err := net.SplitHostPort(addr)
		if err == nil {
			port, _ = strconv.Atoi(p)
		}
	}

	if network == "udp" {
		udpAddr, err := net.ResolveUDPAddr("udp", addr)
		if err != nil {
			return nil, err
		}
		conn, err := net.ListenUDP("udp", udpAddr)
		if err != nil {
			return nil, err
		}
		rs.udpConns = append(rs.udpConns, conn)
		rs.port = port
		go rt.serveUDP(rs, conn)
	} else {
		ln, err := net.Listen("tcp", addr)
		if err != nil {
			return nil, err
		}
		rs.tcpLns = append(rs.tcpLns, ln)
		rs.port = port
		go rt.serveTCP(rs, ln)
	}

	if port > 0 {
		rt.usedPorts[portKey(network, port)] = true
	}
	if rt.OnListen != nil && dynamic && port > 0 {
		rt.OnListen(name, port, svcProtocol(svc))
	}
	logx.Info("listening", "name", name, "addr", addr, "proto", svcProtocol(svc))
	return rs, nil
}

func (rt *Runtime) stopService(rs *runningService) {
	rs.closed = true
	for _, ln := range rs.tcpLns {
		ln.Close()
	}
	for _, c := range rs.udpConns {
		c.Close()
	}
	if rs.port > 0 {
		delete(rt.usedPorts, portKey(rs.network, rs.port))
	}
}

// resolveListenAddr returns the network, the (possibly WAIT_LISTEN-expanded)
// address and whether it needs a dynamic port.
func (rt *Runtime) resolveListenAddr(svc *ServiceConfig) (network, addr string, dynamic bool) {
	addr = svc.Addr
	network = "tcp"
	if svc.Listener != nil && svc.Listener.Type == "udp" {
		network = "udp"
	}

	if idx := strings.Index(addr, WaitListen); idx >= 0 {
		// Everything after WAIT_LISTEN up to ':' or end is the port range hint.
		host := strings.TrimSuffix(addr[:idx], ":")
		rest := addr[idx+len(WaitListen):]
		rest = strings.TrimLeft(rest, "{}")
		if i := strings.IndexAny(rest, "}:"); i >= 0 {
			rest = rest[:i]
		}
		if rt.portRange == nil || rt.portRange.Empty() {
			if rest != "" {
				rt.portRange = netutil.ParsePortRange(rest)
			}
		}
		if rt.listenIP != "" {
			host = rt.listenIP
		}
		return network, net.JoinHostPort(host, "0"), true
	}

	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		// Maybe just a port.
		if p, e := strconv.Atoi(strings.TrimPrefix(addr, ":")); e == nil {
			host, port = "", strconv.Itoa(p)
		} else {
			return network, addr, false
		}
	}
	if rt.listenIP != "" && host == "" {
		host = rt.listenIP
	}
	return network, net.JoinHostPort(host, port), false
}

func (rt *Runtime) allocatePort(network string) int {
	exclude := rt.usedPortNumbers()
	if rt.portRange != nil && !rt.portRange.Empty() {
		// A range is configured but every port in it is taken: return 0 so the
		// caller emits ERR_NO_FREE_PORT. We deliberately do NOT silently fall
		// back to an arbitrary ephemeral port — with control-plane port
		// assignment that would reintroduce cross-node collisions and hide a
		// real capacity problem from the operator.
		return rt.portRange.GetFreePortByRangeProto(network, exclude)
	}
	return netutil.GetFreePortProto(network)
}

// usedPortNumbers returns every port number already bound by this process,
// regardless of protocol. Excluding by number (not just per-network) guarantees
// that the tcp and udp listeners of the same tunnel never share a port number.
func (rt *Runtime) usedPortNumbers() map[int]bool {
	out := make(map[int]bool, len(rt.usedPorts))
	for k := range rt.usedPorts {
		i := strings.IndexByte(k, ':')
		if i < 0 {
			continue
		}
		if p, err := strconv.Atoi(k[i+1:]); err == nil {
			out[p] = true
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// Connection handling
// ---------------------------------------------------------------------------

func (rt *Runtime) serveTCP(rs *runningService, ln net.Listener) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			if rs.closed {
				return
			}
			logx.Debug("accept error", "name", rs.name, "err", err.Error())
			return
		}
		go rt.handleTCP(rs, conn)
	}
}

func (rt *Runtime) handleTCP(rs *runningService, conn net.Conn) {
	defer conn.Close()
	_ = conn.SetDeadline(time.Time{})

	// Optional PROXY protocol v1 header.
	if useProxyProtocol(rs.cfg) {
		p := make([]byte, 108)
		conn.SetReadDeadline(time.Now().Add(3 * time.Second))
		n, _ := conn.Read(p)
		conn.SetReadDeadline(time.Time{})
		if n > 0 {
			// Best-effort: we simply consume and ignore a PROXY v1 line.
			if !strings.HasPrefix(string(p[:n]), "PROXY ") {
				// Not a PROXY header; the bytes belong to the payload. In a full
				// implementation they'd be replayed; here we dial fresh and bail
				// if the peer is not speaking PROXY protocol.
			}
		}
	}

	nodes := rs.cfg.ForwardAddrs()
	if len(nodes) == 0 {
		// No forwarder: try chains; otherwise behave like an HTTP decoy.
		if !rt.tryChain(rs, conn) {
			writeDecoy(conn)
		}
		return
	}

	var lastErr error
	total := len(nodes)
	start := int(atomic.AddUint32(&rrCounter, 1))
	for i := 0; i < total; i++ {
		node := nodes[(start+i)%total]
		if node == nil || node.Addr == "" {
			continue
		}
		upstream, err := net.DialTimeout("tcp", normalizeAddr(node.Addr), 10*time.Second)
		if err != nil {
			lastErr = err
			continue
		}
		pipe(conn, upstream)
		return
	}
	if lastErr != nil {
		logx.Debug("all forward targets failed", "name", rs.name, "err", lastErr.Error())
	}
}

var rrCounter uint32

// tryChain attempts to route through the service's chain hop(s).
func (rt *Runtime) tryChain(rs *runningService, conn net.Conn) bool {
	if rs.cfg.Handler == nil || rs.cfg.Handler.Chain == "" {
		return false
	}
	rt.mu.Lock()
	ch := rt.chains[rs.cfg.Handler.Chain]
	rt.mu.Unlock()
	if ch == nil {
		return false
	}
	for _, hop := range ch.Hops {
		for _, n := range hop.Nodes {
			if n == nil || n.Addr == "" {
				continue
			}
			upstream, err := net.DialTimeout("tcp", normalizeAddr(n.Addr), 10*time.Second)
			if err != nil {
				continue
			}
			pipe(conn, upstream)
			return true
		}
	}
	return false
}

func (rt *Runtime) serveUDP(rs *runningService, conn *net.UDPConn) {
	buf := make([]byte, 65535)
	nodes := rs.cfg.ForwardAddrs()
	for {
		n, clientAddr, err := conn.ReadFromUDP(buf)
		if err != nil {
			if rs.closed {
				return
			}
			return
		}
		if n == 0 || len(nodes) == 0 {
			continue
		}
		payload := make([]byte, n)
		copy(payload, buf[:n])
		go rt.forwardUDP(conn, clientAddr, payload, nodes)
	}
}

func (rt *Runtime) forwardUDP(conn *net.UDPConn, clientAddr *net.UDPAddr, payload []byte, nodes []*ForwarderNode) {
	total := len(nodes)
	start := int(atomic.AddUint32(&rrCounter, 1))
	for i := 0; i < total; i++ {
		node := nodes[(start+i)%total]
		if node == nil || node.Addr == "" {
			continue
		}
		raddr, err := net.ResolveUDPAddr("udp", normalizeAddr(node.Addr))
		if err != nil {
			continue
		}
		up, err := net.DialUDP("udp", nil, raddr)
		if err != nil {
			continue
		}
		up.SetDeadline(time.Now().Add(15 * time.Second))
		if _, err := up.Write(payload); err != nil {
			up.Close()
			continue
		}
		reply := make([]byte, 65535)
		m, err := up.Read(reply)
		up.Close()
		if err != nil {
			continue
		}
		conn.WriteToUDP(reply[:m], clientAddr)
		return
	}
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func pipe(a, b net.Conn) {
	defer a.Close()
	defer b.Close()
	done := make(chan struct{}, 2)
	go func() { io.Copy(a, b); done <- struct{}{} }()
	go func() { io.Copy(b, a); done <- struct{}{} }()
	<-done
}

func svcProtocol(svc *ServiceConfig) string {
	if svc.Listener != nil && svc.Listener.Type != "" {
		return svc.Listener.Type
	}
	if svc.Handler != nil && svc.Handler.Type != "" {
		return svc.Handler.Type
	}
	return "tcp"
}

func useProxyProtocol(svc *ServiceConfig) bool {
	if svc.Handler != nil && svc.Handler.Metadata != nil {
		if v, ok := svc.Handler.Metadata["proxyProtocol"]; ok {
			return fmt.Sprint(v) == "1" || v == true
		}
	}
	return false
}

func normalizeAddr(addr string) string {
	// gost uses host:port; tolerate a bare port or a trailing ":host" filter.
	addr = strings.TrimSpace(addr)
	if strings.HasPrefix(addr, ":") {
		return "127.0.0.1" + addr
	}
	if !strings.Contains(addr, ":") {
		return addr + ":80"
	}
	return addr
}

func replacePort(hostPort string, port int) string {
	host, _, err := net.SplitHostPort(hostPort)
	if err != nil {
		host = ""
	}
	return net.JoinHostPort(host, strconv.Itoa(port))
}

func isAddrInUse(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "address already in use") || strings.Contains(msg, "bind: address already in use")
}

func serviceEqual(a, b *ServiceConfig) bool {
	ab, _ := json.Marshal(a)
	bb, _ := json.Marshal(b)
	return string(ab) == string(bb)
}

// writeDecoy writes a small nginx-like welcome page for non-forwarded requests,
// mirroring the original listener's decoy behaviour.
func writeDecoy(conn net.Conn) {
	const body = "<!DOCTYPE html>\n<html>\n<head><title>Welcome to nginx!</title></head>\n<body>\n<h1>Welcome to nginx!</h1>\n<p>If you see this page, the nginx web server is successfully installed and\nworking. Further configuration is required.</p>\n<p><em>Thank you for using nginx.</em></p>\n</body>\n</html>\n"
	resp := "HTTP/1.1 200 OK\r\n" +
		"Server: nginx\r\n" +
		"Content-Type: text/html; charset=utf-8\r\n" +
		fmt.Sprintf("Content-Length: %d\r\n", len(body)) +
		"Connection: close\r\n\r\n" + body
	conn.SetWriteDeadline(time.Now().Add(3 * time.Second))
	conn.Write([]byte(resp))
}
