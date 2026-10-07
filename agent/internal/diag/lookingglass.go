// 行为参照：ForwardX（AGPL-3.0-only）——Looking Glass 方法集与结果语义；代码为本项目改写，未复制其实现。

package diag

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"math"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Looking Glass —— Agent 侧的诊断边界。
//
// 这一层存在的理由：**面板不是最后一道防线**。面板可能被攻破、可能有 bug、
// 也可能版本更旧；而包是从**客户机房的这台机器**发出去的。因此：
//
//  1. 目标只能是**公网单播字面地址**：私网/环回/链路本地/多播/保留段一律拒绝，
//     并且非规范写法（十进制 `2130706433`、八进制 `0177.0.0.1`、十六进制 `0x7f.0.0.1`、
//     短形式 `127.1`、带 zone 的 `fe80::1%eth0`、方括号形式）**一律拒绝而不是解释**。
//     用 `netip.ParseAddr`（严格）而不是 `net.ParseIP`/`net.Dial`：后两者会把名字
//     交给解析器，而解析器（libc getaddrinfo、Go 的 hosts 查找）对"看起来像数字的
//     字符串"有各自的历史行为 —— 那正是 DNS 重绑定的入口。
//  2. **只拨钉死的字面地址**：本文件里没有任何一处做名称解析。这条性质由
//     `lookingglass_test.go:TestLookingGlassNeverResolvesNames` 做**源码级**断言
//     （出现 `LookupHost`/`LookupIP`/`Resolve*` 就红），而不是靠"我看过了"。
//     DNS 重绑定（TOCTOU）因此在结构上不成立：面板判一次、Agent 判一次，两次判的
//     都是同一个**字节序列**，中间没有第二次解析。
//  3. **先校验全部目标，再发第一个包**：混入一个私网目标的请求是**整请求拒绝**，
//     不是"跳过坏的那个继续拨好的"。半个结果会被读成"这条路径没问题"。
//  4. 方法是闭集，目标是定长列表（≤4），超时封顶，总预算封顶 —— 这是一个有界
//     探测，不是端口扫描器。
//
// ── ICMP：哪些能做、哪些不能（2026-10-07 实测，推翻旧注释）──
//
// 旧注释写的是"不做 ICMP/traceroute：需要 CAP_NET_RAW"。**这句话只对了一半**，
// 而错的那一半会长期误导后来人，所以在这里写准：
//
//   · **ICMP echo（ping/ping6）不需要 CAP_NET_RAW**：内核允许非特权 ICMP 时
//     （`net.ipv4.ping_group_range` 覆盖进程 gid，实测 `0 2147483647`），
//     busybox 的 `ping` 会走 `SOCK_DGRAM`/ICMP 并成功。实测（生产 caps
//     `--cap-drop ALL --cap-add NET_BIND_SERVICE`，CapEff=0x400）：
//     `ping -c1 -W2 1.1.1.1` → 收到真实回包，avg 1.983 ms。
//   · **raw socket 才需要 CAP_NET_RAW**，而 `traceroute` 正是 raw socket：
//     同 caps 下实测 `socket(AF_INET,3,1): Operation not permitted`。
//     `mtr` 更进一步：镜像里根本没有这个二进制。
//   · Go 标准库**没有**非特权 ICMP 的 API（`net.Dial("ip4:icmp")` 是 raw socket），
//     所以 ping 的实现方式是**在固定候选绝对路径上调用镜像自带的 ping 二进制**
//     （不走 PATH、不经过 shell、目标作为独立 argv），而不是自己开 socket。
//
// 明确不做：`traceroute`/`traceroute6`/`mtr`/`mtr6`（raw socket EPERM / 无二进制，
// 由面板侧如实标成"不可用"并给原因）、UDP（没有可靠回包来源，做了就是编造事实）、
// HTTP（重定向/降级是另一份威胁模型）。

// LookingGlassMethodTCPConnect 是 v1 唯一的方法。
const LookingGlassMethodTCPConnect = "tcp_connect"

// MaxLookingGlassTargets 上限与面板侧常量一致（validator 的线形上限、service 的策略上限）。
const MaxLookingGlassTargets = 4

// ErrLookingGlassRejected 表示请求被本层的边界拒绝（结构或地址策略）。
// 调用方应把它转成 `invalid_payload`，而不是"探测失败"。
var ErrLookingGlassRejected = errors.New("diag: looking glass request rejected")

// LookingGlassTarget 是一个**已钉死的公网字面地址**。
//
// 字段名刻意是 `address` 而不是 `host`：这里不接受名字，接受名字就等于把解析
// 重新引入拨号路径。名字→地址的解析由面板完成，Agent 只拨地址。
type LookingGlassTarget struct {
	Address string `json:"address"`
	Port    int    `json:"port"`
}

// LookingGlassRequest 是 `looking_glass` 动作的 payload。
type LookingGlassRequest struct {
	Method    string               `json:"method"`
	Targets   []LookingGlassTarget `json:"targets"`
	TimeoutMS int                  `json:"timeout_ms,omitempty"`
}

// nonPublicPrefixes 是"不属于公网单播"的地址段。
//
// 这张表与面板侧 `services/looking-glass.ts` 的 `NON_PUBLIC_V4_RANGES` /
// `NON_PUBLIC_V6_RANGES` 是**同一份策略的两处实现**：两侧各自独立执行，因此
// 任一侧有 bug 都不足以形成一个能拨内网的命令。两侧的一致性由同一份测试向量
// 保证（`lookingglass_test.go` 与 `d-looking-glass.test.ts` 各跑一遍同一张表）。
//
// IPv6 里刻意整段拒绝所有会内嵌 IPv4 的隧道形式（Teredo/6to4/NAT64）：它们能把
// 一个内网 v4 地址包装成看起来正常的 v6 地址，逐段判断只会给绕过留缝。
var nonPublicPrefixes = []struct {
	prefix netip.Prefix
	label  string
}{
	{netip.MustParsePrefix("0.0.0.0/8"), "0.0.0.0/8 本网络"},
	{netip.MustParsePrefix("10.0.0.0/8"), "10.0.0.0/8 私网"},
	{netip.MustParsePrefix("100.64.0.0/10"), "100.64.0.0/10 运营商级 NAT"},
	{netip.MustParsePrefix("127.0.0.0/8"), "127.0.0.0/8 环回"},
	{netip.MustParsePrefix("169.254.0.0/16"), "169.254.0.0/16 链路本地（含云元数据）"},
	{netip.MustParsePrefix("172.16.0.0/12"), "172.16.0.0/12 私网"},
	{netip.MustParsePrefix("192.0.0.0/24"), "192.0.0.0/24 IETF 协议保留"},
	{netip.MustParsePrefix("192.0.2.0/24"), "192.0.2.0/24 文档用 TEST-NET-1"},
	{netip.MustParsePrefix("192.88.99.0/24"), "192.88.99.0/24 6to4 中继任播"},
	{netip.MustParsePrefix("192.168.0.0/16"), "192.168.0.0/16 私网"},
	{netip.MustParsePrefix("198.18.0.0/15"), "198.18.0.0/15 基准测试"},
	{netip.MustParsePrefix("198.51.100.0/24"), "198.51.100.0/24 文档用 TEST-NET-2"},
	{netip.MustParsePrefix("203.0.113.0/24"), "203.0.113.0/24 文档用 TEST-NET-3"},
	{netip.MustParsePrefix("224.0.0.0/4"), "224.0.0.0/4 多播"},
	{netip.MustParsePrefix("240.0.0.0/4"), "240.0.0.0/4 保留（含 255.255.255.255 广播）"},
	{netip.MustParsePrefix("::/96"), "::/96 未指定 / IPv4 兼容（已废弃）"},
	{netip.MustParsePrefix("64:ff9b::/96"), "64:ff9b::/96 NAT64 知名前缀"},
	{netip.MustParsePrefix("64:ff9b:1::/48"), "64:ff9b:1::/48 本地用 NAT64"},
	{netip.MustParsePrefix("100::/64"), "100::/64 丢弃专用"},
	{netip.MustParsePrefix("2001::/32"), "2001::/32 Teredo（内嵌 IPv4）"},
	{netip.MustParsePrefix("2001:2::/48"), "2001:2::/48 基准测试"},
	{netip.MustParsePrefix("2001:10::/28"), "2001:10::/28 ORCHID"},
	{netip.MustParsePrefix("2001:20::/28"), "2001:20::/28 ORCHIDv2"},
	{netip.MustParsePrefix("2001:db8::/32"), "2001:db8::/32 文档用"},
	{netip.MustParsePrefix("2002::/16"), "2002::/16 6to4（内嵌 IPv4）"},
	{netip.MustParsePrefix("3fff::/20"), "3fff::/20 文档用"},
	{netip.MustParsePrefix("5f00::/16"), "5f00::/16 SRv6 SID"},
	{netip.MustParsePrefix("fc00::/7"), "fc00::/7 唯一本地地址"},
	{netip.MustParsePrefix("fe80::/10"), "fe80::/10 链路本地"},
	{netip.MustParsePrefix("fec0::/10"), "fec0::/10 站点本地（已废弃）"},
	{netip.MustParsePrefix("ff00::/8"), "ff00::/8 多播"},
}

// NonPublicRangeLabel 返回该地址命中的保留段说明；ok=false 表示它是公网单播。
//
// 4-in-6（`::ffff:a.b.c.d`）先 `Unmap`：它和裸 IPv4 是同一个地址，必须走同一张表，
// 否则 `::ffff:127.0.0.1` 会绕过 v4 的环回判定。
func NonPublicRangeLabel(addr netip.Addr) (string, bool) {
	if !addr.IsValid() {
		return "invalid address", true
	}
	addr = addr.Unmap()
	for _, entry := range nonPublicPrefixes {
		if entry.prefix.Contains(addr) {
			return entry.label, true
		}
	}
	return "", false
}

// ParsePublicTarget 校验一个字面地址并返回规范写法。
//
// 拒绝面（与面板侧逐条对应）：空串、方括号、zone id、非规范写法（`netip` 本身就是
// 严格解析器）、非公网段。
func ParsePublicTarget(literal string) (string, error) {
	trimmed := strings.TrimSpace(literal)
	if trimmed == "" {
		return "", fmt.Errorf("%w: empty address", ErrLookingGlassRejected)
	}
	if strings.HasPrefix(trimmed, "[") || strings.HasSuffix(trimmed, "]") {
		return "", fmt.Errorf("%w: bracketed literal %q is not accepted on the wire", ErrLookingGlassRejected, trimmed)
	}
	addr, err := netip.ParseAddr(trimmed)
	if err != nil {
		// netip is strict on purpose: "0177.0.0.1", "127.1", "2130706433" and
		// "0x7f000001" all land here, and they are REFUSED rather than
		// reinterpreted. Interpretation differences between resolvers are the
		// classic parser-differential bypass.
		return "", fmt.Errorf("%w: %q is not a canonical IP literal (decimal/octal/hex/short forms are refused, never reinterpreted)", ErrLookingGlassRejected, trimmed)
	}
	if addr.Zone() != "" {
		return "", fmt.Errorf("%w: zoned address %q is refused", ErrLookingGlassRejected, trimmed)
	}
	if label, rejected := NonPublicRangeLabel(addr); rejected {
		return "", fmt.Errorf("%w: %q is not public unicast (%s)", ErrLookingGlassRejected, trimmed, label)
	}
	return addr.Unmap().String(), nil
}

// LookingGlass 执行一次有界探测。
//
// 结构与 `Probe` 的关系：**不复用 `Probe`**，因为 `Probe` 会对目标做名称解析
// （`LookupHost`），而这里的目标必须是钉死的字面地址。两个函数共享状态词表、
// 错误分类与硬上限，但不共享"怎么把字符串变成 socket 地址"这一步。
//
// 返回值：每个**已钉死**目标一条结果，顺序与请求一致。任何结构/策略问题都返回
// 错误且在拨号前返回（零发包）。
func LookingGlass(ctx context.Context, req LookingGlassRequest, dial DialFunc) ([]Result, error) {
	method := strings.TrimSpace(req.Method)
	switch method {
	case LookingGlassMethodTCPConnect:
		// 既有路径：拨钉死的字面地址与端口。
	case LookingGlassMethodPing, LookingGlassMethodPing6:
		// ICMP 路径：不用 port（面板传 0），但仍然**先全校验地址**再发包。
		return lookingGlassICMP(ctx, req, method)
	case LookingGlassMethodTraceroute, LookingGlassMethodTraceroute6:
		// 路径跟踪：同样不用 port，同样先全校验。
		return lookingGlassTraceroute(ctx, req, method)
	default:
		return nil, fmt.Errorf("%w: unsupported method %q", ErrLookingGlassRejected, req.Method)
	}
	if len(req.Targets) == 0 {
		return nil, fmt.Errorf("%w: no targets", ErrLookingGlassRejected)
	}
	if len(req.Targets) > MaxLookingGlassTargets {
		return nil, ErrTooManyTargets
	}
	if dial == nil {
		dialer := &net.Dialer{}
		dial = dialer.DialContext
	}

	// Phase 1 —— 校验**全部**目标。任何一个不合格就在此处返回，因此
	// "混入私网目标"的请求会产生 0 个包（见 TestLookingGlassRejectsWholeRequestBeforeDialing）。
	type pinned struct {
		address string
		port    int
	}
	plan := make([]pinned, 0, len(req.Targets))
	seen := make(map[string]bool, len(req.Targets))
	for i, target := range req.Targets {
		if target.Port < 1 || target.Port > 65535 {
			return nil, fmt.Errorf("%w: target %d has an invalid port", ErrLookingGlassRejected, i)
		}
		address, err := ParsePublicTarget(target.Address)
		if err != nil {
			return nil, err
		}
		key := net.JoinHostPort(address, strconv.Itoa(target.Port))
		if seen[key] {
			return nil, fmt.Errorf("%w: duplicate target %s", ErrLookingGlassRejected, key)
		}
		seen[key] = true
		plan = append(plan, pinned{address: address, port: target.Port})
	}

	timeout := req.TimeoutMS
	if timeout <= 0 {
		timeout = DefaultTimeoutMS
	}
	if timeout > MaxTimeoutMS {
		timeout = MaxTimeoutMS
	}

	budget, cancel := context.WithTimeout(ctx, TotalBudgetMS*time.Millisecond)
	defer cancel()

	results := make([]Result, 0, len(plan))
	for _, target := range plan {
		results = append(results, probePinned(budget, target.address, target.port, time.Duration(timeout)*time.Millisecond, dial))
	}
	return results, nil
}

// probePinned 拨一个**字面地址**。
//
// 与 `probeOne` 的关键差别：没有 `LookupHost`。地址已经是规范字面量，任何"再解析
// 一次"都会把 DNS 重绑定窗口重新打开，也会让结果里的 `resolved_ip` 与拨的地址
// 有机会不一致。
func probePinned(ctx context.Context, address string, port int, timeout time.Duration, dial DialFunc) Result {
	result := Result{Host: address, Port: port, Status: StatusError}
	if err := ctx.Err(); err != nil {
		result.Status = StatusTimeout
		result.Detail = "probe budget exhausted before this target"
		return result
	}

	attempt, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	started := time.Now()
	conn, err := dial(attempt, "tcp", net.JoinHostPort(address, strconv.Itoa(port)))
	result.ElapsedMS = time.Since(started).Milliseconds()
	if err != nil {
		result.Status = classifyDialError(err)
		result.Detail = detail(err)
		return result
	}
	_ = conn.Close()
	result.Status = StatusReachable
	return result
}

/* ================================================================== */
/* ICMP echo（ping / ping6）—— 非特权路径                                */
/* ================================================================== */

// 见文件头"哪些能做、哪些不能"：这里调用镜像自带的 ping 二进制（固定候选绝对路径、
// 目标作为独立 argv、不经过 shell），而不是自己开 raw socket。

const (
	// LookingGlassMethodPing 是 IPv4 ICMP echo。
	LookingGlassMethodPing = "ping"
	// LookingGlassMethodPing6 是 IPv6 ICMP echo。**可用性 = 二进制 + 内核权限**；
	// 节点自身没有 IPv6 出网路径时，结果会是 unreachable —— 那是网络事实，
	// 不是方法未实现（面板 caveats 写明）。
	LookingGlassMethodPing6 = "ping6"
)

// maxICMPOutputBytes 限制我们保留的原始输出（一次 ping 的输出很小，这是防意外）。
const maxICMPOutputBytes = 4096

// pingBinaryCandidates 是固定候选绝对路径。刻意**不**查 PATH：那等于把"执行了谁"
// 交给运行环境决定。
var pingBinaryCandidates = map[string][]string{
	LookingGlassMethodPing:  {"/bin/ping", "/usr/bin/ping", "/sbin/ping"},
	LookingGlassMethodPing6: {"/bin/ping6", "/usr/bin/ping6", "/sbin/ping6"},
}

// ICMPAvailability 是一种 ICMP 方法在本节点的可用性。
type ICMPAvailability struct {
	Method string `json:"method"`
	Binary string `json:"binary,omitempty"`
	Reason string `json:"reason,omitempty"`
}

// MethodAvailability 是一种 Looking Glass 方法在本节点的可用性（Reason 为空 = 可用）。
type MethodAvailability = ICMPAvailability

// DetectLookingGlassMethods 零发包地枚举本二进制实现的方法，以及每种方法在本节点的可用性。
//
// 这是"caps 必须如实"的唯一数据源：面板只把节点**上报为可用**的方法列进 `caps.methods`，
// 于是"服务端支持而节点做不到"在结构上不可能出现。
func DetectLookingGlassMethods() []MethodAvailability {
	out := make([]MethodAvailability, 0, 5)
	// tcp_connect：纯 TCP 拨号，无特权、无外部二进制 ⇒ 恒可用。
	out = append(out, MethodAvailability{Method: LookingGlassMethodTCPConnect})
	out = append(out, DetectICMP()...)
	if binary := TracepathBinary(); binary != "" {
		out = append(out,
			MethodAvailability{Method: LookingGlassMethodTraceroute, Binary: binary},
			MethodAvailability{Method: LookingGlassMethodTraceroute6, Binary: binary},
		)
	} else {
		reason := "镜像里没有 tracepath 二进制（固定候选：" + strings.Join(tracepathBinaryCandidates, ", ") + "）；" +
			"不用 busybox traceroute 是因为它需要 raw socket（CAP_NET_RAW），生产 caps 下实测 EPERM"
		out = append(out,
			MethodAvailability{Method: LookingGlassMethodTraceroute, Reason: reason},
			MethodAvailability{Method: LookingGlassMethodTraceroute6, Reason: reason},
		)
	}
	return out
}

// ICMPExec 执行一次 ping：(收到回包?, 往返毫秒, 原始输出, 错误)。测试注入用。
type ICMPExec func(ctx context.Context, binary, address string, timeout time.Duration) (bool, int64, string, error)

// runICMP 是生产实现（测试会覆盖它）。
var runICMP ICMPExec = execICMP

// SupportedLookingGlassMethods 是本二进制实现的方法闭集（**不**含 mtr/mtr6：
// 镜像无该二进制，且它默认需要 raw socket）。可用性另由 DetectLookingGlassMethods 逐节点判定。
func SupportedLookingGlassMethods() []string {
	return []string{
		LookingGlassMethodTCPConnect,
		LookingGlassMethodPing,
		LookingGlassMethodPing6,
		LookingGlassMethodTraceroute,
		LookingGlassMethodTraceroute6,
	}
}

// DetectICMP 零发包地判断本节点能用哪些 ICMP 方法。
//
// 判据（都不需要发包）：① 候选绝对路径上存在可执行文件；② 允许非特权 ICMP —— 要么
// 进程有 CAP_NET_RAW（默认 docker caps 就是这种），要么 `ping_group_range` 覆盖本进程 gid。
// 依赖二进制/PATH/内核位都是**运行环境事实**，所以每次启动重新探测，而不是写死。
func DetectICMP() []ICMPAvailability {
	out := make([]ICMPAvailability, 0, 2)
	for _, method := range []string{LookingGlassMethodPing, LookingGlassMethodPing6} {
		binary := firstExecutable(pingBinaryCandidates[method])
		if binary == "" {
			out = append(out, ICMPAvailability{Method: method, Reason: "镜像里没有该方法的 ping 二进制（固定候选：" + strings.Join(pingBinaryCandidates[method], ", ") + "）"})
			continue
		}
		status, err := os.ReadFile("/proc/self/status")
		allowed := false
		if err == nil {
			rng, rerr := os.ReadFile("/proc/sys/net/ipv4/ping_group_range")
			if rerr == nil {
				allowed = icmpAllowedUnprivileged(string(status), string(rng), os.Getgid())
			}
		}
		if !allowed {
			out = append(out, ICMPAvailability{Method: method, Binary: binary, Reason: "本节点既没有 CAP_NET_RAW，内核也不允许非特权 ICMP（/proc/sys/net/ipv4/ping_group_range 不含本进程 gid）"})
			continue
		}
		out = append(out, ICMPAvailability{Method: method, Binary: binary})
	}
	return out
}

// icmpAllowedUnprivileged 是纯判定（可离线测试）。
//
// `CapEff` 的 bit 13 是 CAP_NET_RAW（0x2000）。`ping_group_range` 的格式是
// "<low>\t<high>"（十进制）；含本进程 gid ⇒ 内核允许 SOCK_DGRAM/ICMP。
func icmpAllowedUnprivileged(procStatus, pingGroupRange string, gid int) bool {
	if rawCapabilitySet(procStatus) {
		return true
	}
	fields := strings.Fields(pingGroupRange)
	if len(fields) != 2 {
		return false
	}
	low, errLow := strconv.ParseInt(fields[0], 10, 64)
	high, errHigh := strconv.ParseInt(fields[1], 10, 64)
	if errLow != nil || errHigh != nil {
		return false
	}
	return int64(gid) >= low && int64(gid) <= high
}

func rawCapabilitySet(procStatus string) bool {
	for _, line := range strings.Split(procStatus, "\n") {
		if !strings.HasPrefix(line, "CapEff:") {
			continue
		}
		value, err := strconv.ParseUint(strings.TrimSpace(strings.TrimPrefix(line, "CapEff:")), 16, 64)
		if err != nil {
			return false
		}
		return value&(1<<13) != 0 // CAP_NET_RAW
	}
	return false
}

func firstExecutable(paths []string) string {
	for _, path := range paths {
		info, err := os.Stat(path)
		if err == nil && !info.IsDir() && info.Mode()&0o111 != 0 {
			return path
		}
	}
	return ""
}

// execICMP 执行一次有界 ping 并解析回包。
//
// 参数固定为 `-c 1 -W <秒>`：一次请求一个回包，超时由内核侧 `-W` 与 context 双层兜住。
// 目标**已经是** `ParsePublicTarget` 校验过的规范字面地址，因此它不可能被当成选项
// （`netip` 不接受 `-`），而且它是独立 argv，不经过任何 shell。
func execICMP(ctx context.Context, binary, address string, timeout time.Duration) (bool, int64, string, error) {
	seconds := int(math.Ceil(timeout.Seconds()))
	if seconds < 1 {
		seconds = 1
	}
	cmd := exec.CommandContext(ctx, binary, "-c", "1", "-W", strconv.Itoa(seconds), address)
	var buf bytes.Buffer
	cmd.Stdout = &buf
	cmd.Stderr = &buf
	cmd.Env = []string{"LC_ALL=C"} // 不继承环境：输出解析不能随环境漂移
	err := cmd.Run()
	raw := buf.String()
	if len(raw) > maxICMPOutputBytes {
		raw = raw[:maxICMPOutputBytes]
	}
	rtt, replied := parseICMPReply(raw)
	return replied, rtt, raw, err
}

// parseICMPReply 从 ping 输出里取往返毫秒；`replied` 表示是否真的收到回包。
//
// 同时兼容 busybox（`time=1.983 ms` / `round-trip min/avg/max`）与 iputils
// （`time=1.98 ms`）两种形状 —— 我们不解析"包数统计"这类可能随版本变化的文案，
// 只看 RTT 与丢失率这两种稳定事实。
func parseICMPReply(output string) (int64, bool) {
	// 首选逐包行（`time=1.983 ms`）—— 那是"这一包真的回来了"的直接证据。
	if match := icmpRTTPattern.FindStringSubmatch(output); match != nil {
		if value, err := strconv.ParseFloat(match[1], 64); err == nil {
			return int64(value + 0.5), true
		}
	}
	// 次选统计行（busybox 的 `round-trip min/avg/max = a/b/c ms`）：取 **avg**。
	// 有些 ping 实现只在统计行给往返时间，只认第一种会让真实回包被读成"没回来"。
	if match := icmpStatsPattern.FindStringSubmatch(output); match != nil {
		if value, err := strconv.ParseFloat(match[2], 64); err == nil {
			return int64(value + 0.5), true
		}
	}
	return 0, false
}

var (
	icmpRTTPattern   = regexp.MustCompile(`time[=<]([0-9]+(?:\.[0-9]+)?)\s*ms`)
	icmpStatsPattern = regexp.MustCompile(`min/avg/max\s*=\s*([0-9.]+)/([0-9.]+)/([0-9.]+)\s*ms`)
)

// lookingGlassICMP 执行 ping/ping6。
//
// 与 tcp_connect 共享同一套"先全校验、再发第一个包"的纪律：
//
//	· 目标只能是公网字面地址（`ParsePublicTarget`，无名称解析）；
//	· **地址家族必须与方法一致**（`ping` 只接 v4、`ping6` 只接 v6）——不一致时整请求
//	  拒绝而不是"悄悄换个家族去拨"；
//	· 混入一个不合格目标 ⇒ 0 个包。
func lookingGlassICMP(ctx context.Context, req LookingGlassRequest, method string) ([]Result, error) {
	if len(req.Targets) == 0 {
		return nil, fmt.Errorf("%w: no targets", ErrLookingGlassRejected)
	}
	if len(req.Targets) > MaxLookingGlassTargets {
		return nil, ErrTooManyTargets
	}
	wantV6 := method == LookingGlassMethodPing6
	binary := firstExecutable(pingBinaryCandidates[method])
	if binary == "" {
		// 镜像里没有这个二进制 ⇒ 方法在本节点不可执行（面板本不该下发；防御性拒绝）。
		return nil, fmt.Errorf("%w: %s is not available on this node (no ping binary)", ErrLookingGlassRejected, method)
	}

	addresses := make([]string, 0, len(req.Targets))
	seen := make(map[string]bool, len(req.Targets))
	for i, target := range req.Targets {
		address, err := ParsePublicTarget(target.Address)
		if err != nil {
			return nil, err
		}
		addr, _ := netip.ParseAddr(address)
		if addr.Is6() != wantV6 {
			return nil, fmt.Errorf("%w: target %d address family does not match method %q", ErrLookingGlassRejected, i, method)
		}
		if seen[address] {
			return nil, fmt.Errorf("%w: duplicate target %s", ErrLookingGlassRejected, address)
		}
		seen[address] = true
		addresses = append(addresses, address)
	}

	timeout := req.TimeoutMS
	if timeout <= 0 {
		timeout = DefaultTimeoutMS
	}
	if timeout > MaxTimeoutMS {
		timeout = MaxTimeoutMS
	}
	budget, cancel := context.WithTimeout(ctx, TotalBudgetMS*time.Millisecond)
	defer cancel()

	results := make([]Result, 0, len(addresses))
	for _, address := range addresses {
		result := Result{Host: address, Status: StatusError}
		attempt, cancelAttempt := context.WithTimeout(budget, time.Duration(timeout)*time.Millisecond)
		replied, rtt, raw, err := runICMP(attempt, binary, address, time.Duration(timeout)*time.Millisecond)
		timedOut := attempt.Err() != nil
		cancelAttempt()
		result.ElapsedMS = rtt
		switch {
		case replied:
			result.Status = StatusReachable
		case timedOut || strings.Contains(raw, "100% packet loss") || strings.Contains(raw, "100% loss"):
			// 一个回包都没有：丢包或超时。两者对操作者是同一句话，且都**不是**"可达"。
			result.Status = StatusTimeout
			result.Detail = "没有收到任何回包（丢包或超时）"
		default:
			result.Status = StatusError
			result.Detail = lastNonEmptyLine(raw)
			if result.Detail == "" && err != nil {
				result.Detail = err.Error()
			}
		}
		results = append(results, result)
	}
	return results, nil
}

// lastNonEmptyLine 取最后一行非空输出（busybox 把原因写在最后，例如
// `ping: sendto: Network unreachable`）。截断到 200 字符，避免把整段输出抛进结果。
func lastNonEmptyLine(output string) string {
	lines := strings.Split(output, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		trimmed := strings.TrimSpace(lines[i])
		if trimmed == "" {
			continue
		}
		if len(trimmed) > 200 {
			trimmed = trimmed[:200]
		}
		return trimmed
	}
	return ""
}

/* ================================================================== */
/* traceroute / traceroute6 —— 无特权路径（tracepath）                   */
/* ================================================================== */

// 参照 ForwardX 的 traceroute 能力（它有 traceroute/traceroute6/mtr/mtr6），
// **实现按我们的无特权容器改写**：不做 raw socket，而是用 iputils 的 `tracepath`。
//
// 实测（生产 caps `--cap-drop ALL --cap-add NET_BIND_SERVICE`）：
//
//	· `traceroute`（busybox）→ `socket(AF_INET,3,1): Operation not permitted`（raw socket）；
//	· `tracepath`（apk add iputils）→ **真的出跳**：`1: 172.17.0.1 / 2: 10.1.32.1 / …`；
//	· 目标家族没有出网路径时 → `1:  send failed`（诚实结果，不是"方法不可用"）。
//
// 因此：`traceroute`/`traceroute6` 由 `tracepath` 实现，**不放开 CAP_NET_RAW** —— 安全模型不变。
const (
	// LookingGlassMethodTraceroute 是 IPv4 路径跟踪（UDP 探测 + ICMP 超时回包，无特权）。
	LookingGlassMethodTraceroute = "traceroute"
	// LookingGlassMethodTraceroute6 是 IPv6 路径跟踪。
	LookingGlassMethodTraceroute6 = "traceroute6"
	// MaxLookingGlassHops 是一次路径跟踪的最大跳数（有界：不能变成"无穷跟踪"）。
	MaxLookingGlassHops = 8
)

// tracepathBinaryCandidates 是固定候选绝对路径（不走 PATH）。
var tracepathBinaryCandidates = []string{"/usr/sbin/tracepath", "/sbin/tracepath", "/usr/bin/tracepath", "/bin/tracepath"}

// TracepathExec 执行一次 tracepath：(TTL→那一跳的原始行集合, 原始输出, 错误)。测试注入用。
type TracepathExec func(ctx context.Context, binary, address string, maxHops int, timeout time.Duration) (map[int][]string, string, error)

// runTracepath 是生产实现（测试覆盖它）。
var runTracepath TracepathExec = execTracepath

// TracepathBinary 返回本节点上可用的 tracepath 绝对路径（"" = 没有）。
func TracepathBinary() string { return firstExecutable(tracepathBinaryCandidates) }

// execTracepath 跑一次有界 tracepath。
//
// `-n` 是关键：强制**数字输出**，节点不做反向解析（与"节点不做名称解析"同一条纪律）。
// 目标已是规范字面地址（`ParsePublicTarget`），作为独立 argv 传入 ⇒ 参数注入不成立。
func execTracepath(ctx context.Context, binary, address string, maxHops int, timeout time.Duration) (map[int][]string, string, error) {
	cmd := exec.CommandContext(ctx, binary, "-n", "-m", strconv.Itoa(maxHops), address)
	var buf bytes.Buffer
	cmd.Stdout = &buf
	cmd.Stderr = &buf
	cmd.Env = []string{"LC_ALL=C"}
	err := cmd.Run()
	raw := buf.String()
	if len(raw) > maxLookingGlassOutputBytes {
		raw = raw[:maxLookingGlassOutputBytes]
	}
	return parseTracepath(raw), raw, err
}

const maxLookingGlassOutputBytes = 8192

// parseTracepath 把 tracepath 的输出按 TTL 归组。
//
// 输出形状（iputils，实测）：
//
//	1?: [LOCALHOST]                      pmtu 1500
//	1:  172.17.0.1                                            0.335ms
//	2:  10.1.32.1                                             0.250ms
//	3:  103.185.248.1                                         2.131ms asymm  4
//	1:  send failed
//
// 同一个 TTL 可能出现多行（重试），所以返回 map[ttl][]行，由上层决定取哪一行。
func parseTracepath(output string) map[int][]string {
	hops := make(map[int][]string)
	for _, line := range strings.Split(output, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		match := tracepathLinePattern.FindStringSubmatch(trimmed)
		if match == nil {
			continue // 例如 `Resume: pmtu 128000`
		}
		ttl, err := strconv.Atoi(match[1])
		if err != nil || ttl < 1 || ttl > MaxLookingGlassHops {
			continue
		}
		hops[ttl] = append(hops[ttl], strings.TrimSpace(match[2]))
	}
	return hops
}

// 只匹配**跳结果**行（`<ttl>:  …`）。刻意不匹配 tracepath 的 `1?: [LOCALHOST] pmtu 1500`
// 那种"未知/本地跳"公告行：它是本次跟踪的开场信息，不是某一跳的结果；把它算进第 1 跳会
// 让"这一跳是谁"出现两个互相矛盾的候选。
var tracepathLinePattern = regexp.MustCompile(`^(\d+):\s+(.*)$`)

// tracepathHop 从"同一个 TTL 的若干行"里提炼一跳。
//
// 取值纪律：优先**有字面地址**的那一行（那才是"这一跳真的回话了"）；都没有地址时退化为
// 一句 note（例如 `send failed`）。RTT 取该行里第一个 `X.XXXms`。
func tracepathHop(ttl int, lines []string) Hop {
	hop := Hop{TTL: ttl}
	for _, line := range lines {
		address, note := splitTracepathFields(line)
		if address != "" && hop.Address == "" {
			hop.Address = address
			hop.RTTMS = firstRTTMS(line)
			hop.Note = note
		}
		if hop.Address == "" && note != "" && hop.Note == "" {
			hop.Note = note
		}
	}
	return hop
}

// splitTracepathFields 把一行拆成 (字面地址, 备注)。地址为空表示这一行没有地址。
func splitTracepathFields(line string) (string, string) {
	fields := strings.Fields(line)
	if len(fields) == 0 {
		return "", ""
	}
	candidate := fields[0]
	if _, err := netip.ParseAddr(candidate); err != nil {
		// 不是字面地址（例如 `send failed` / `[LOCALHOST]`）：整行当备注。
		return "", strings.Join(fields, " ")
	}
	return candidate, strings.Join(fields[1:], " ")
}

var tracepathRTTPattern = regexp.MustCompile(`([0-9]+(?:\.[0-9]+)?)ms`)

func firstRTTMS(line string) int64 {
	if match := tracepathRTTPattern.FindStringSubmatch(line); match != nil {
		if value, err := strconv.ParseFloat(match[1], 64); err == nil {
			return int64(value + 0.5)
		}
	}
	return 0
}

// lookingGlassTraceroute 执行一次有界的路径跟踪。
//
// 与其它方法共享同一条纪律：**先全校验（字面地址/公网/家族），再发第一个包**；
// 混入一个不合格目标 ⇒ 0 个包。
func lookingGlassTraceroute(ctx context.Context, req LookingGlassRequest, method string) ([]Result, error) {
	if len(req.Targets) == 0 {
		return nil, fmt.Errorf("%w: no targets", ErrLookingGlassRejected)
	}
	if len(req.Targets) > MaxLookingGlassTargets {
		return nil, ErrTooManyTargets
	}
	binary := TracepathBinary()
	if binary == "" {
		return nil, fmt.Errorf("%w: %s is not available on this node (no tracepath binary)", ErrLookingGlassRejected, method)
	}
	wantV6 := method == LookingGlassMethodTraceroute6

	addresses := make([]string, 0, len(req.Targets))
	seen := make(map[string]bool, len(req.Targets))
	for i, target := range req.Targets {
		address, err := ParsePublicTarget(target.Address)
		if err != nil {
			return nil, err
		}
		addr, _ := netip.ParseAddr(address)
		if addr.Is6() != wantV6 {
			return nil, fmt.Errorf("%w: target %d address family does not match method %q", ErrLookingGlassRejected, i, method)
		}
		if seen[address] {
			return nil, fmt.Errorf("%w: duplicate target %s", ErrLookingGlassRejected, address)
		}
		seen[address] = true
		addresses = append(addresses, address)
	}

	timeout := req.TimeoutMS
	if timeout <= 0 {
		timeout = DefaultTimeoutMS
	}
	if timeout > MaxTimeoutMS {
		timeout = MaxTimeoutMS
	}
	budget, cancel := context.WithTimeout(ctx, TotalBudgetMS*time.Millisecond)
	defer cancel()

	results := make([]Result, 0, len(addresses))
	for _, address := range addresses {
		// 跳数上限与**时间预算**绑定（实测教训）：tracepath 的输出是块缓冲的，进程被
		// context kill 掉时，还没 flush 的那部分会**整段丢失**（我们拿到空输出、只能报超时，
		// 而实际上前面几跳已经量到了）。所以给它一个"能在预算内自己走完"的跳数上限，
		// 而不是让它走到一半被砍掉。
		// 每跳最坏约 1 秒（无应答的跳要等到超时），所以跳数上限取预算的 ~70%，
		// 让 tracepath **自己走完**；再给它一点 flush 余量（进程被 kill 时块缓冲输出会丢）。
		hopBudget := MaxLookingGlassHops
		if seconds := int(timeout / 1000); seconds > 0 {
			scaled := seconds * 7 / 10
			if scaled < hopBudget {
				hopBudget = scaled
			}
		}
		if hopBudget < 2 {
			hopBudget = 2
		}
		grace := time.Duration(timeout)*time.Millisecond + 1500*time.Millisecond
		attempt, cancelAttempt := context.WithTimeout(budget, grace)
		hopsByTTL, raw, err := runTracepath(attempt, binary, address, hopBudget, grace)
		interrupted := attempt.Err() != nil
		cancelAttempt()

		hops := make([]Hop, 0, MaxLookingGlassHops)
		reached := false
		for ttl := 1; ttl <= hopBudget; ttl++ {
			lines, ok := hopsByTTL[ttl]
			if !ok {
				continue
			}
			hop := tracepathHop(ttl, lines)
			hops = append(hops, hop)
			if hop.Address == address {
				reached = true
			}
		}
		addressed := 0
		for _, hop := range hops {
			if hop.Address != "" {
				addressed++
			}
		}

		result := Result{Host: address, Status: StatusError, Hops: hops}
		switch {
		case reached:
			result.Status = StatusReachable
			if len(hops) > 0 {
				result.ElapsedMS = hops[len(hops)-1].RTTMS
			}
		case addressed > 0:
			// 有跳但没在预算内到达目标：如实说"没到达"，不是"不可达"。
			result.Status = StatusTimeout
			result.Detail = fmt.Sprintf("未在 %d 跳内到达目标（已收到 %d 跳）", hopBudget, addressed)
		case interrupted:
			result.Status = StatusTimeout
			result.Detail = "跟踪在超时预算内没有收到任何回话"
		default:
			result.Status = StatusError
			result.Detail = tracepathFailureDetail(raw)
			if result.Detail == "" && err != nil {
				result.Detail = err.Error()
			}
		}
		results = append(results, result)
	}
	return results, nil
}

// tracepathFailureDetail 从原始输出里取一句可读原因（例如 v6 无路径时的 `send failed`）。
func tracepathFailureDetail(output string) string {
	for _, line := range strings.Split(output, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.Contains(trimmed, "send failed") {
			return "send failed（本节点没有该地址家族的出网路径）"
		}
		if strings.Contains(trimmed, "Network is unreachable") || strings.Contains(trimmed, "Network unreachable") {
			return "network unreachable（本节点没有该地址家族的出网路径）"
		}
	}
	return lastNonEmptyLine(output)
}
