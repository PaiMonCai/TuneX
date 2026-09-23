// Package netutil contains the host-introspection helpers the agent needs:
// system information for the `register` / `sysinfo` events, public-IP
// detection, and free-port selection inside a configured range.
package netutil

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// BasicSysInfo is the small snapshot sent with `register`.
type BasicSysInfo struct {
	Arch     string `json:"arch"`
	BootTime int64  `json:"boot_time"`
	CPUNum   int    `json:"cpu_num"`
	Hostname string `json:"hostname"`
	OS       string `json:"os"`
}

// SysInfo is the fuller snapshot sent with `sysinfo` every 10s. Field names and
// types mirror the original agent's JSON (verified from packet captures).
type SysInfo struct {
	CPUUsagePercent    float64 `json:"cpu_usage_percent"`
	DiskTotal          uint64  `json:"disk_total"`
	DiskUsagePercent   float64 `json:"disk_usage_percent"`
	DiskUsed           uint64  `json:"disk_used"`
	Load1              float64 `json:"load_1"`
	Load5              float64 `json:"load_5"`
	Load15             float64 `json:"load_15"`
	MemoryTotal        uint64  `json:"memory_total"`
	MemoryUsagePercent float64 `json:"memory_usage_percent"`
	MemoryUsed         uint64  `json:"memory_used"`
	NetIn              uint64  `json:"net_in"`
	NetOut             uint64  `json:"net_out"`
	ProcessNum         int     `json:"process_num"`
	ProgramMemory      uint64  `json:"program_memory"`
	TCPConnections     int     `json:"tcp_connections"`
	UDPConnections     int     `json:"udp_connections"`
	TrafficIn          uint64  `json:"traffic_in"`
	TrafficOut         uint64  `json:"traffic_out"`
	TrafficMonthIn     uint64  `json:"traffic_month_in"`
	TrafficMonthOut    uint64  `json:"traffic_month_out"`
	Uptime             int64   `json:"uptime"`
}

// GetBasicSysInfo collects the register-time basics.
func GetBasicSysInfo() BasicSysInfo {
	host, _ := os.Hostname()
	return BasicSysInfo{
		Arch:     normalizeArch(),
		BootTime: bootTime(),
		CPUNum:   runtime.NumCPU(),
		Hostname: host,
		OS:       "linux",
	}
}

// GetSysInfo collects the periodic metrics (best-effort; failures degrade to 0).
func GetSysInfo() SysInfo {
	var uptime float64
	if v, ok := readFloat("/proc/uptime"); ok {
		uptime = v
	}
	memTotal, memAvail := memInfo()
	var memUsed uint64
	if memTotal > memAvail {
		memUsed = memTotal - memAvail
	}
	diskTotal, diskUsed := diskUsage("/")
	load1, load5, load15 := loadAvg()
	netIn, netOut := netDevTotals()

	var info SysInfo
	info.CPUUsagePercent = cpuUsagePercent()
	info.DiskTotal = diskTotal
	info.DiskUsed = diskUsed
	if diskTotal > 0 {
		info.DiskUsagePercent = float64(diskUsed) / float64(diskTotal) * 100
	}
	info.Load1, info.Load5, info.Load15 = load1, load5, load15
	info.MemoryTotal = memTotal
	info.MemoryUsed = memUsed
	if memTotal > 0 {
		info.MemoryUsagePercent = float64(memUsed) / float64(memTotal) * 100
	}
	info.NetIn = netIn
	info.NetOut = netOut
	info.ProcessNum = processNum()
	info.ProgramMemory = selfRSS()
	info.TCPConnections, info.UDPConnections = connectionCounts()
	info.TrafficIn = netIn
	info.TrafficOut = netOut
	info.Uptime = int64(uptime)
	return info
}

func normalizeArch() string {
	switch runtime.GOARCH {
	case "amd64":
		return "x86_64"
	case "arm64":
		return "aarch64"
	case "386":
		return "i386"
	default:
		return runtime.GOARCH
	}
}

func readFileString(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func readFloat(path string) (float64, bool) {
	s := readFileString(path)
	fields := strings.Fields(s)
	if len(fields) == 0 {
		return 0, false
	}
	v, err := strconv.ParseFloat(fields[0], 64)
	return v, err == nil
}

func readAllLimited(r io.Reader, limit int64) ([]byte, error) {
	return io.ReadAll(io.LimitReader(r, limit))
}

// ---------------------------------------------------------------------------
// Public IP
// ---------------------------------------------------------------------------

var (
	ipv4Endpoints = []string{"https://v4.long2ice.io", "https://api.ipify.org", "https://ifconfig.me/ip"}
	ipv6Endpoints = []string{"https://v6.long2ice.io", "https://api6.ipify.org"}
)

// GetPublicIPs returns the detected public IPv4/IPv6 addresses (best effort).
func GetPublicIPs(timeout time.Duration) []string {
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	client := &http.Client{Timeout: timeout}
	var out []string
	if ip := fetchPublicIP(client, ipv4Endpoints); ip != "" {
		out = append(out, ip)
	}
	if ip := fetchPublicIP(client, ipv6Endpoints); ip != "" {
		out = append(out, ip)
	}
	return out
}

func fetchPublicIP(client *http.Client, endpoints []string) string {
	for _, ep := range endpoints {
		req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, ep, nil)
		if err != nil {
			continue
		}
		resp, err := client.Do(req)
		if err != nil {
			continue
		}
		body, _ := readAllLimited(resp.Body, 128)
		resp.Body.Close()
		ip := strings.TrimSpace(string(body))
		if net.ParseIP(ip) != nil {
			return ip
		}
	}
	return ""
}

// FallbackConnectIPs returns non-loopback unicast addresses.
func FallbackConnectIPs() []string {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return nil
	}
	var out []string
	for _, a := range addrs {
		ipnet, ok := a.(*net.IPNet)
		if !ok || ipnet.IP.IsLoopback() || ipnet.IP.IsLinkLocalUnicast() {
			continue
		}
		if v4 := ipnet.IP.To4(); v4 != nil {
			out = append(out, v4.String())
		} else {
			out = append(out, ipnet.IP.String())
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

// PortRange represents a parsed `--port-range` value such as "80,443,30000-30010".
type PortRange struct {
	segments []segment
}

type segment struct{ lo, hi int }

// ParsePortRange parses a comma-separated list of ports and inclusive ranges.
func ParsePortRange(s string) *PortRange {
	pr := &PortRange{}
	for _, part := range strings.Split(s, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if i := strings.Index(part, "-"); i >= 0 {
			lo, err1 := strconv.Atoi(strings.TrimSpace(part[:i]))
			hi, err2 := strconv.Atoi(strings.TrimSpace(part[i+1:]))
			if err1 == nil && err2 == nil && lo > 0 && hi >= lo {
				pr.segments = append(pr.segments, segment{lo, hi})
			}
			continue
		}
		if p, err := strconv.Atoi(part); err == nil && p > 0 {
			pr.segments = append(pr.segments, segment{p, p})
		}
	}
	return pr
}

// Empty reports whether the range holds no usable ports.
func (pr *PortRange) Empty() bool { return pr == nil || len(pr.segments) == 0 }

// Contains reports whether port is inside any segment.
func (pr *PortRange) Contains(port int) bool {
	if pr == nil {
		return false
	}
	for _, s := range pr.segments {
		if port >= s.lo && port <= s.hi {
			return true
		}
	}
	return false
}

// GetFreePortByRange finds a free TCP port inside the range (0 if none).
func (pr *PortRange) GetFreePortByRange(exclude map[int]bool) int {
	if pr == nil {
		return 0
	}
	for _, s := range pr.segments {
		for p := s.lo; p <= s.hi; p++ {
			if exclude != nil && exclude[p] {
				continue
			}
			if isPortFree(p) {
				return p
			}
		}
	}
	return 0
}

// GetFreePort asks the kernel for an ephemeral free TCP port.
func GetFreePort() int {
	l, err := net.Listen("tcp", ":0")
	if err != nil {
		return 0
	}
	defer l.Close()
	if addr, ok := l.Addr().(*net.TCPAddr); ok {
		return addr.Port
	}
	return 0
}

func isPortFree(port int) bool {
	l, err := net.Listen("tcp", fmt.Sprintf(":%d", port))
	if err != nil {
		return false
	}
	l.Close()
	return true
}

// ---------------------------------------------------------------------------
// /proc helpers
// ---------------------------------------------------------------------------

func bootTime() int64 {
	for _, line := range strings.Split(readFileString("/proc/stat"), "\n") {
		if strings.HasPrefix(line, "btime ") {
			if v, err := strconv.ParseInt(strings.TrimSpace(strings.TrimPrefix(line, "btime ")), 10, 64); err == nil {
				return v
			}
		}
	}
	return 0
}

func loadAvg() (float64, float64, float64) {
	f := strings.Fields(readFileString("/proc/loadavg"))
	if len(f) < 3 {
		return 0, 0, 0
	}
	a, _ := strconv.ParseFloat(f[0], 64)
	b, _ := strconv.ParseFloat(f[1], 64)
	c, _ := strconv.ParseFloat(f[2], 64)
	return a, b, c
}

func memInfo() (total, available uint64) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0, 0
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 2 {
			continue
		}
		kb, _ := strconv.ParseUint(fields[1], 10, 64)
		switch strings.TrimSuffix(fields[0], ":") {
		case "MemTotal":
			total = kb * 1024
		case "MemAvailable":
			available = kb * 1024
		}
	}
	return total, available
}

func processNum() int {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return 0
	}
	n := 0
	for _, e := range entries {
		if e.IsDir() {
			if _, err := strconv.Atoi(e.Name()); err == nil {
				n++
			}
		}
	}
	return n
}

func selfRSS() uint64 {
	fields := strings.Fields(readFileString("/proc/self/statm"))
	if len(fields) < 2 {
		return 0
	}
	pages, _ := strconv.ParseUint(fields[1], 10, 64)
	return pages * uint64(os.Getpagesize())
}

var lastCPUTimes cpuTimes

type cpuTimes struct {
	idle, total uint64
	valid       bool
}

func cpuUsagePercent() float64 {
	idle, total, ok := readCPUTimes()
	if !ok {
		return 0
	}
	if !lastCPUTimes.valid {
		lastCPUTimes = cpuTimes{idle: idle, total: total, valid: true}
		return 0
	}
	dIdle := float64(idle - lastCPUTimes.idle)
	dTotal := float64(total - lastCPUTimes.total)
	lastCPUTimes = cpuTimes{idle: idle, total: total, valid: true}
	if dTotal <= 0 {
		return 0
	}
	pct := (dTotal - dIdle) / dTotal * 100
	if pct < 0 {
		pct = 0
	}
	return pct
}

func readCPUTimes() (idle, total uint64, ok bool) {
	f, err := os.Open("/proc/stat")
	if err != nil {
		return 0, 0, false
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "cpu ") {
			continue
		}
		fields := strings.Fields(line)[1:]
		var sum, id uint64
		for i, fv := range fields {
			v, _ := strconv.ParseUint(fv, 10, 64)
			sum += v
			if i == 3 || i == 4 { // idle + iowait
				id += v
			}
		}
		return id, sum, true
	}
	return 0, 0, false
}

func connectionCounts() (tcp, udp int) {
	tcp = countProcNet("/proc/net/tcp") + countProcNet("/proc/net/tcp6")
	udp = countProcNet("/proc/net/udp") + countProcNet("/proc/net/udp6")
	return tcp, udp
}

func countProcNet(path string) int {
	f, err := os.Open(path)
	if err != nil {
		return 0
	}
	defer f.Close()
	n := 0
	sc := bufio.NewScanner(f)
	sc.Scan() // header
	for sc.Scan() {
		if strings.TrimSpace(sc.Text()) != "" {
			n++
		}
	}
	return n
}

func netDevTotals() (rx, tx uint64) {
	f, err := os.Open("/proc/net/dev")
	if err != nil {
		return 0, 0
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Scan() // header 1
	sc.Scan() // header 2
	for sc.Scan() {
		line := sc.Text()
		idx := strings.Index(line, ":")
		if idx < 0 {
			continue
		}
		if strings.TrimSpace(line[:idx]) == "lo" {
			continue
		}
		fields := strings.Fields(line[idx+1:])
		if len(fields) < 16 {
			continue
		}
		r, _ := strconv.ParseUint(fields[0], 10, 64)
		t, _ := strconv.ParseUint(fields[8], 10, 64)
		rx += r
		tx += t
	}
	return rx, tx
}

// diskUsage returns total/used bytes for the filesystem holding path.
func diskUsage(path string) (total, used uint64) {
	var st syscallStatfs
	if err := statfs(path, &st); err != nil {
		return 0, 0
	}
	bsize := uint64(st.Bsize)
	total = st.Blocks * bsize
	free := st.Bavail * bsize
	if total > free {
		used = total - free
	}
	return total, used
}
