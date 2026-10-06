package diag

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
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
// 明确不做：ICMP/traceroute（需要 CAP_NET_RAW，与 §1.9 静态非特权二进制冲突）、
// UDP（没有可靠回包来源，做了就是编造事实）、HTTP（重定向/降级是另一份威胁模型）。

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
	if strings.TrimSpace(req.Method) != LookingGlassMethodTCPConnect {
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
