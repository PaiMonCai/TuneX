package diag

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Agent 侧 Looking Glass 边界测试。
//
// 这里钉的不是"探测能不能成功"，而是**它能不能被用来扫内网**：
//   · 同一张地址向量表（与面板侧 `d-looking-glass.test.ts` 逐条对应）；
//   · 写法变体一律拒绝（十进制/八进制/十六进制/短形式/方括号/zone）；
//   · 混入一个私网目标 ⇒ **整请求拒绝且零发包**；
//   · 拨号串必须是**钉死的字面地址**（没有任何名称解析），且结果里没有解析痕迹；
//   · 源码级守卫：本文件不得出现任何解析调用（比"我看过了"可靠）。

// lookingGlassVectors 是"地址 → 允许/拒绝"的共享向量表。
//
// 与控制面同一组地址安全边界逐条对应。
// 只断言 allow/deny 这一位：两侧用不同的解析器（Go `netip` vs TS 自己的解析器），
// 断言"拒绝理由文案"会把两边绑死，而**安全性质**只需要这一位一致。
var lookingGlassVectors = []struct {
	literal string
	allow   bool
	why     string
}{
	// ── 公网单播：允许 ──
	{"93.184.216.34", true, "公网 IPv4"},
	{"1.1.1.1", true, "公网 DNS"},
	{"8.8.8.8", true, "公网 DNS"},
	{"172.15.255.255", true, "172.16/12 下界之外（判宽一格的负例）"},
	{"172.32.0.0", true, "172.16/12 上界之外"},
	{"100.63.255.255", true, "100.64/10 下界之外"},
	{"100.128.0.0", true, "100.64/10 上界之外"},
	{"198.17.255.255", true, "198.18/15 下界之外"},
	{"198.20.0.0", true, "198.18/15 上界之外"},
	{"192.0.1.0", true, "192.0.0/24 之外"},
	{"223.255.255.255", true, "多播段之外的最大单播"},
	{"2606:4700::1111", true, "公网 IPv6"},
	{"2001:4860:4860::8888", true, "公网 IPv6（Google DNS）"},
	{"2a00:1450:4001::1", true, "公网 IPv6"},
	// 映射形式里内嵌的是**公网**地址：还原后就是同一个公网地址，允许。
	// （内嵌私网的映射形式在下面被拒 —— 这两条一起定义了这个写法变体的语义。）
	{"::ffff:93.184.216.34", true, "IPv4 映射公网地址（还原后为公网）"},

	// ── IPv4 私网 / 环回 / 链路本地 / 0 段 / 多播 / 保留 ──
	{"10.0.0.1", false, "10/8 私网"},
	{"10.255.255.255", false, "10/8 私网上界"},
	{"172.16.0.0", false, "172.16/12 下界"},
	{"172.31.255.255", false, "172.16/12 上界"},
	{"192.168.0.1", false, "192.168/16 私网"},
	{"192.168.255.255", false, "192.168/16 上界"},
	{"127.0.0.1", false, "环回"},
	{"127.255.255.255", false, "127/8 上界"},
	{"169.254.1.1", false, "链路本地"},
	{"169.254.169.254", false, "云元数据端点"},
	{"0.0.0.0", false, "0.0.0.0/8 本网络"},
	{"0.1.2.3", false, "0.0.0.0/8 内"},
	{"0.255.255.255", false, "0/8 上界"},
	{"224.0.0.1", false, "多播"},
	{"239.255.255.255", false, "多播上界"},
	{"240.0.0.1", false, "240/4 保留"},
	{"255.255.255.255", false, "广播"},
	{"100.64.0.1", false, "CGNAT"},
	{"100.127.255.255", false, "CGNAT 上界"},
	{"192.0.0.1", false, "IETF 协议保留"},
	{"192.0.2.1", false, "TEST-NET-1"},
	{"192.88.99.1", false, "6to4 中继任播"},
	{"198.18.0.1", false, "基准测试"},
	{"198.51.100.1", false, "TEST-NET-2"},
	{"203.0.113.1", false, "TEST-NET-3"},

	// ── IPv6 私网 / 环回 / 链路本地 / 多播 / 保留 / 隧道形式 ──
	{"::1", false, "环回"},
	{"::", false, "未指定"},
	{"fe80::1", false, "链路本地"},
	{"febf:ffff::1", false, "fe80::/10 上界"},
	{"fc00::1", false, "ULA"},
	{"fd12:3456::1", false, "ULA（fd00::/8）"},
	{"ff02::1", false, "多播"},
	{"fec0::1", false, "站点本地（已废弃）"},
	{"2001:db8::1", false, "文档用"},
	{"3fff::1", false, "文档用（RFC 9637）"},
	{"100::1", false, "丢弃专用"},
	{"2002:0a00:0001::1", false, "6to4（内嵌 10.0.0.1）"},
	{"2002:5db8:d822::1", false, "6to4（内嵌公网 v4 也整段拒绝）"},
	{"2001::1", false, "Teredo"},
	{"64:ff9b::a00:1", false, "NAT64（内嵌 10.0.0.1）"},
	{"5f00::1", false, "SRv6 SID"},
	{"2001:10::1", false, "ORCHID"},

	// ── 映射/写法变体：绝不构成绕过 ──
	{"::ffff:127.0.0.1", false, "IPv4 映射环回（先还原再判定）"},
	{"::FFFF:127.0.0.1", false, "映射形式大小写变体"},
	{"::ffff:10.0.0.1", false, "IPv4 映射私网"},
	{"::ffff:192.168.1.1", false, "IPv4 映射私网"},
	{"::ffff:0.0.0.0", false, "IPv4 映射 0 段"},
	{"2130706433", false, "十进制 127.0.0.1"},
	{"0177.0.0.1", false, "八进制写法"},
	{"0x7f.0.0.1", false, "十六进制写法"},
	{"0x7f000001", false, "十六进制整数写法"},
	{"127.1", false, "短形式"},
	{"127.0.0.1.", false, "尾点形式"},
	{"1.2.3.4.5", false, "段数过多"},
	{"[::1]", false, "方括号形式（线形不接受）"},
	{"[2606:4700::1111]", false, "方括号形式（即使是公网）"},
	{"fe80::1%eth0", false, "带 zone id"},
	{"fe80::1%25eth0", false, "带百分号编码 zone"},
	{"", false, "空串"},
	{"   ", false, "全空白"},
	{"例え.テスト", false, "非 ASCII（未进入 IDNA 处理，直接拒）"},
}

func TestParsePublicTargetVectors(t *testing.T) {
	for _, vector := range lookingGlassVectors {
		canonical, err := ParsePublicTarget(vector.literal)
		allowed := err == nil
		if allowed != vector.allow {
			t.Fatalf("ParsePublicTarget(%q) allowed=%v want=%v (%s), err=%v",
				vector.literal, allowed, vector.allow, vector.why, err)
		}
		if allowed {
			if canonical == "" {
				t.Fatalf("ParsePublicTarget(%q) 返回了空规范形式", vector.literal)
			}
			// 规范形式必须能被再次接受（幂等）：Agent 拨的就是这个字符串。
			if _, again := ParsePublicTarget(canonical); again != nil {
				t.Fatalf("canonical form %q of %q was rejected on re-parse: %v", canonical, vector.literal, again)
			}
			if strings.Contains(canonical, "%") || strings.Contains(canonical, "[") {
				t.Fatalf("canonical form %q must be a bare literal", canonical)
			}
		}
	}
}

func TestParsePublicTargetCanonicalForms(t *testing.T) {
	// 公网 IPv6 的高位零必须折叠成 `::`，并且**面板下发的规范形式**要能被逐字接受。
	got, err := ParsePublicTarget("2606:4700:0000:0000:0000:0000:0000:1111")
	if err != nil {
		t.Fatalf("公网 IPv6 应被接受: %v", err)
	}
	if got != "2606:4700::1111" {
		t.Fatalf("canonical = %q, want 2606:4700::1111", got)
	}
	again, err := ParsePublicTarget("2606:4700::1111")
	if err != nil || again != got {
		t.Fatalf("面板下发的规范形式必须被逐字接受: %q %v", again, err)
	}
	// 4-in-6 的规范输出统一成裸 IPv4（两侧一致，面板按字面量做覆盖性匹配）。
	v4, err := ParsePublicTarget("::ffff:93.184.216.34")
	if err != nil || v4 != "93.184.216.34" {
		t.Fatalf("映射形式应规范成裸 IPv4: %q %v", v4, err)
	}
}

// TestLookingGlassRejectsWholeRequestBeforeDialing 是这一层最重要的性质：
// 混入一个私网目标 ⇒ **零发包**。不是"跳过坏的、拨好的"。
func TestLookingGlassRejectsWholeRequestBeforeDialing(t *testing.T) {
	dialed := 0
	dial := func(ctx context.Context, network, address string) (net.Conn, error) {
		dialed++
		return nil, errors.New("should not be dialed")
	}
	req := LookingGlassRequest{
		Method: LookingGlassMethodTCPConnect,
		Targets: []LookingGlassTarget{
			{Address: "93.184.216.34", Port: 443},
			{Address: "10.0.0.1", Port: 443},
		},
	}
	_, err := LookingGlass(context.Background(), req, dial)
	if err == nil {
		t.Fatal("混入私网目标的请求必须被拒绝")
	}
	if !errors.Is(err, ErrLookingGlassRejected) {
		t.Fatalf("拒绝原因应是 ErrLookingGlassRejected，得到: %v", err)
	}
	if dialed != 0 {
		t.Fatalf("拒绝必须发生在发包之前：dialed=%d", dialed)
	}
}

func TestLookingGlassNeverResolvesNames(t *testing.T) {
	// 源码级守卫：拨号路径上不允许出现任何名称解析调用。DNS 重绑定之所以在
	// 本功能里结构上不成立，就是因为这里没有第二次解析。
	// 去掉行注释再查：注释里**提到**某个解析函数名是为了解释"为什么不这么做"，
	// 而那正是这份文档最该留下的部分。守卫只对可执行代码生效（行注释截断对
	// 字符串字面量会误伤，但本文件里没有含 `//` 的字面量，且这是守卫不是编译器）。
	text := stripLineComments(string(mustRead(t, "lookingglass.go")))
	if !strings.Contains(text, "netip.ParseAddr") {
		t.Fatal("守卫锚点失效：lookingglass.go 必须用 netip.ParseAddr（严格解析）")
	}
	forbidden := []string{
		"LookupHost", "LookupIP", "LookupAddr", "LookupCNAME",
		"ResolveIPAddr", "ResolveTCPAddr", "net.ParseIP", "net.Dial(",
	}
	for _, token := range forbidden {
		if strings.Contains(text, token) {
			t.Fatalf("lookingglass.go 不允许出现 %q：那会把名称解析重新引入拨号路径", token)
		}
	}
	// 拨号串必须由"规范化字面地址 + 端口"拼装，而不是任何形式的再解析。
	if !strings.Contains(text, "net.JoinHostPort(address") {
		t.Fatal("拨号串必须由 JoinHostPort(规范化字面地址, 端口) 拼装")
	}
}

func TestLookingGlassRequestJSONShape(t *testing.T) {
	// 线形键名锚点：面板发 `looking_glass: {method, targets:[{address, port}], timeout_ms}`。
	// 键名漂移的症状是"面板判过了、Agent 收到空请求"，所以这里在源码上钉一次。
	text := string(mustRead(t, "lookingglass.go"))
	for _, key := range []string{
		`json:"method`, `json:"targets`, `json:"timeout_ms`,
		`json:"address`, `json:"port`,
	} {
		if !strings.Contains(text, key) {
			t.Fatalf("lookingglass.go 缺少线形键 %s", key)
		}
	}
}

func TestLookingGlassDialsPinnedLiteralAndReportsIt(t *testing.T) {
	var seen []string
	refused := &net.OpError{Op: "dial", Err: errors.New("connect: connection refused")}
	dial := func(ctx context.Context, network, address string) (net.Conn, error) {
		seen = append(seen, network+" "+address)
		return nil, refused
	}
	req := LookingGlassRequest{
		Method: LookingGlassMethodTCPConnect,
		Targets: []LookingGlassTarget{
			{Address: "93.184.216.34", Port: 443},
			{Address: "2606:4700::1111", Port: 53},
		},
	}
	results, err := LookingGlass(context.Background(), req, dial)
	if err != nil {
		t.Fatalf("公网目标不应被拒: %v", err)
	}
	if len(results) != 2 {
		t.Fatalf("结果数 %d，期望 2", len(results))
	}
	// 结果里的 host 必须是**裸字面量**：面板按字面量做覆盖性匹配。
	if results[0].Host != "93.184.216.34" || results[0].Status != StatusRefused {
		t.Fatalf("第一条结果 %+v", results[0])
	}
	if results[1].Host != "2606:4700::1111" || results[1].Status != StatusRefused {
		t.Fatalf("第二条结果 %+v", results[1])
	}
	want := []string{"tcp 93.184.216.34:443", "tcp [2606:4700::1111]:53"}
	if strings.Join(seen, "|") != strings.Join(want, "|") {
		t.Fatalf("拨号串 = %v, want %v", seen, want)
	}
	// 结果里不得出现解析痕迹（面板会因此拒绝整份结果）。
	for _, row := range results {
		if row.ResolvedIP != "" {
			t.Fatalf("结果不该带 resolved_ip: %+v", row)
		}
	}
}

func TestLookingGlassCapsAndMethodClosedSet(t *testing.T) {
	five := make([]LookingGlassTarget, 0, 5)
	for i := 0; i < 5; i++ {
		five = append(five, LookingGlassTarget{Address: "93.184.216.34", Port: 1000 + i})
	}
	call := func(req LookingGlassRequest) error {
		_, err := LookingGlass(context.Background(), req, func(context.Context, string, string) (net.Conn, error) {
			t.Fatal("被拒绝的请求不得发包")
			return nil, nil
		})
		return err
	}
	if err := call(LookingGlassRequest{Method: LookingGlassMethodTCPConnect, Targets: five}); !errors.Is(err, ErrTooManyTargets) {
		t.Fatalf("超过上限应返回 ErrTooManyTargets，得到 %v", err)
	}
	if err := call(LookingGlassRequest{
		Method:  "ping",
		Targets: []LookingGlassTarget{{Address: "93.184.216.34", Port: 80}},
	}); !errors.Is(err, ErrLookingGlassRejected) {
		t.Fatalf("未知方法必须拒绝（不降级），得到 %v", err)
	}
	if err := call(LookingGlassRequest{
		Method:  LookingGlassMethodTCPConnect,
		Targets: []LookingGlassTarget{{Address: "93.184.216.34", Port: 0}},
	}); !errors.Is(err, ErrLookingGlassRejected) {
		t.Fatalf("非法端口必须拒绝，得到 %v", err)
	}
	// 重复目标：面板会去重；重复到达 Agent 说明面板有 bug，拒绝而不是猜。
	if err := call(LookingGlassRequest{
		Method: LookingGlassMethodTCPConnect,
		Targets: []LookingGlassTarget{
			{Address: "93.184.216.34", Port: 80},
			{Address: "93.184.216.34", Port: 80},
		},
	}); !errors.Is(err, ErrLookingGlassRejected) {
		t.Fatalf("重复目标必须拒绝，得到 %v", err)
	}
}

func TestLookingGlassTimeoutClampedToHardCap(t *testing.T) {
	// 请求一个超大的 per-attempt 超时：Agent 侧的硬上限（常量，不是配置）必须生效，
	// 且每次尝试都带 deadline。
	deadlineSeen := make(chan bool, 1)
	dial := func(ctx context.Context, network, address string) (net.Conn, error) {
		_, hasDeadline := ctx.Deadline()
		deadlineSeen <- hasDeadline
		return nil, errors.New("connect: connection refused")
	}
	_, err := LookingGlass(context.Background(), LookingGlassRequest{
		Method:    LookingGlassMethodTCPConnect,
		Targets:   []LookingGlassTarget{{Address: "93.184.216.34", Port: 80}},
		TimeoutMS: MaxTimeoutMS * 100,
	}, dial)
	if err != nil {
		t.Fatalf("不应因超时数值被拒（应被 clamp）: %v", err)
	}
	select {
	case hasDeadline := <-deadlineSeen:
		if !hasDeadline {
			t.Fatal("每次尝试都必须带 deadline")
		}
	default:
		t.Fatal("dial 没有被调用")
	}
}

// stripLineComments 去掉 `//` 之后的内容（守卫用）。
func stripLineComments(text string) string {
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		if cut := strings.Index(line, "//"); cut >= 0 {
			lines[i] = line[:cut]
		}
	}
	return strings.Join(lines, "\n")
}

func mustRead(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(".", name))
	if err != nil {
		t.Fatalf("读不到 %s: %v", name, err)
	}
	return data
}

/* ================================================================== */
/* ICMP（ping / ping6）：可用性判定、输出解析、派发边界                  */
/* ================================================================== */

func TestICMPUnprivilegedDecision(t *testing.T) {
	withRaw := "Name:\ttunex-agent\nCapEff:\t00000000a80425fb\n"
	withoutRaw := "Name:\ttunex-agent\nCapEff:\t0000000000000400\n"
	cases := []struct {
		name   string
		status string
		range_ string
		gid    int
		want   bool
	}{
		{"有 CAP_NET_RAW（默认 docker caps）⇒ 允许", withRaw, "1\t0", 0, true},
		{"无 CAP_NET_RAW 但 ping_group_range 覆盖 gid ⇒ 允许（实测的生产形态）", withoutRaw, "0\t2147483647", 0, true},
		{"无 CAP_NET_RAW 且范围不含 gid ⇒ 拒绝", withoutRaw, "1000\t2000", 0, false},
		{"无权限位且范围形状坏 ⇒ 拒绝（fail-closed）", withoutRaw, "not-a-range", 0, false},
		{"读不到 CapEff ⇒ 只看范围", "", "0\t2147483647", 0, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := icmpAllowedUnprivileged(tc.status, tc.range_, tc.gid); got != tc.want {
				t.Fatalf("allowed = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestParseICMPReply(t *testing.T) {
	cases := []struct {
		name    string
		output  string
		wantRTT int64
		wantOK  bool
	}{
		{"busybox 单行", "64 bytes from 1.1.1.1: seq=0 ttl=42 time=1.983 ms", 2, true},
		{"busybox 统计行", "round-trip min/avg/max = 1.983/1.983/1.983 ms", 2, true},
		{"iputils", "64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=1.98 ms", 2, true},
		{"iputils <1ms（收到了回包，只是小于 1ms）", "64 bytes from 10.0.0.1: icmp_seq=1 ttl=64 time<1 ms", 1, true},
		{"全部丢包", "1 packets transmitted, 0 packets received, 100% packet loss", 0, false},
		{"不可达", "ping: sendto: Network unreachable", 0, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rtt, ok := parseICMPReply(tc.output)
			if ok != tc.wantOK {
				t.Fatalf("ok = %v, want %v (%q)", ok, tc.wantOK, tc.output)
			}
			if ok && rtt != tc.wantRTT {
				t.Fatalf("rtt = %d, want %d", rtt, tc.wantRTT)
			}
		})
	}
}

// withFakeICMP 把生产执行器换成受控替身，并记录被调用了几次。
func withFakeICMP(t *testing.T, replied bool, rtt int64, raw string, err error, binary string) *int {
	t.Helper()
	calls := 0
	original := runICMP
	runICMP = func(context.Context, string, string, time.Duration) (bool, int64, string, error) {
		calls++
		return replied, rtt, raw, err
	}
	t.Cleanup(func() { runICMP = original })
	if binary != "" {
		originalCandidates := pingBinaryCandidates
		pingBinaryCandidates = map[string][]string{
			LookingGlassMethodPing:  {binary},
			LookingGlassMethodPing6: {binary},
		}
		t.Cleanup(func() { pingBinaryCandidates = originalCandidates })
	}
	return &calls
}

// fakePingBinary 建一个可执行的假 ping（内容无关，因为我们注入了 runICMP）。
func fakePingBinary(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "ping")
	if err := os.WriteFile(path, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestICMPDispatchMapsRepliesToStatuses(t *testing.T) {
	binary := fakePingBinary(t)

	t.Run("收到回包 ⇒ reachable + 往返毫秒", func(t *testing.T) {
		calls := withFakeICMP(t, true, 12, "time=12.3 ms", nil, binary)
		results, err := LookingGlass(context.Background(), LookingGlassRequest{
			Method:  LookingGlassMethodPing,
			Targets: []LookingGlassTarget{{Address: "1.1.1.1"}},
		}, nil)
		if err != nil {
			t.Fatal(err)
		}
		if len(results) != 1 || results[0].Status != StatusReachable || results[0].ElapsedMS != 12 {
			t.Fatalf("results = %+v", results)
		}
		if *calls != 1 {
			t.Fatalf("exec calls = %d, want 1", *calls)
		}
	})

	t.Run("100% 丢包 ⇒ timeout（不是 reachable）", func(t *testing.T) {
		withFakeICMP(t, false, 0, "1 packets transmitted, 0 packets received, 100% packet loss", nil, binary)
		results, err := LookingGlass(context.Background(), LookingGlassRequest{
			Method:  LookingGlassMethodPing,
			Targets: []LookingGlassTarget{{Address: "3.5.140.1"}},
		}, nil)
		if err != nil {
			t.Fatal(err)
		}
		if len(results) != 1 || results[0].Status != StatusTimeout {
			t.Fatalf("results = %+v", results)
		}
	})

	t.Run("不可达 ⇒ error 且带最后一行原因", func(t *testing.T) {
		withFakeICMP(t, false, 0, "PING x\nping: sendto: Network unreachable\n", errors.New("exit status 2"), binary)
		results, err := LookingGlass(context.Background(), LookingGlassRequest{
			Method:  LookingGlassMethodPing6,
			Targets: []LookingGlassTarget{{Address: "2606:4700:4700::1111"}},
		}, nil)
		if err != nil {
			t.Fatal(err)
		}
		if len(results) != 1 || results[0].Status != StatusError || results[0].Detail != "ping: sendto: Network unreachable" {
			t.Fatalf("results = %+v", results)
		}
	})
}

func TestICMPRejectsWholeRequestBeforeExecuting(t *testing.T) {
	binary := fakePingBinary(t)

	t.Run("家族不匹配（ping + v6 地址）⇒ 0 次执行", func(t *testing.T) {
		calls := withFakeICMP(t, true, 1, "time=1 ms", nil, binary)
		_, err := LookingGlass(context.Background(), LookingGlassRequest{
			Method:  LookingGlassMethodPing,
			Targets: []LookingGlassTarget{{Address: "2606:4700:4700::1111"}},
		}, nil)
		if err == nil || !errors.Is(err, ErrLookingGlassRejected) {
			t.Fatalf("err = %v, want ErrLookingGlassRejected", err)
		}
		if *calls != 0 {
			t.Fatalf("exec calls = %d, want 0", *calls)
		}
	})

	t.Run("混入私网目标 ⇒ 整请求拒绝、0 次执行", func(t *testing.T) {
		calls := withFakeICMP(t, true, 1, "time=1 ms", nil, binary)
		_, err := LookingGlass(context.Background(), LookingGlassRequest{
			Method: LookingGlassMethodPing,
			Targets: []LookingGlassTarget{
				{Address: "1.1.1.1"},
				{Address: "10.0.0.1"},
			},
		}, nil)
		if err == nil || !errors.Is(err, ErrLookingGlassRejected) {
			t.Fatalf("err = %v, want ErrLookingGlassRejected", err)
		}
		if *calls != 0 {
			t.Fatalf("exec calls = %d, want 0（半个结果会被读成「这条路径没问题」）", *calls)
		}
	})

	t.Run("镜像里没有该方法的二进制 ⇒ 拒绝而不是假装跑过", func(t *testing.T) {
		originalCandidates := pingBinaryCandidates
		pingBinaryCandidates = map[string][]string{LookingGlassMethodPing: {"/nonexistent/ping"}}
		t.Cleanup(func() { pingBinaryCandidates = originalCandidates })
		_, err := LookingGlass(context.Background(), LookingGlassRequest{
			Method:  LookingGlassMethodPing,
			Targets: []LookingGlassTarget{{Address: "1.1.1.1"}},
		}, nil)
		if err == nil || !errors.Is(err, ErrLookingGlassRejected) {
			t.Fatalf("err = %v, want ErrLookingGlassRejected", err)
		}
	})

	t.Run("未知方法仍然拒绝（不静默降级成 TCP）", func(t *testing.T) {
		_, err := LookingGlass(context.Background(), LookingGlassRequest{
			Method:  "traceroute",
			Targets: []LookingGlassTarget{{Address: "1.1.1.1", Port: 443}},
		}, nil)
		if err == nil || !errors.Is(err, ErrLookingGlassRejected) {
			t.Fatalf("err = %v, want ErrLookingGlassRejected", err)
		}
	})
}
