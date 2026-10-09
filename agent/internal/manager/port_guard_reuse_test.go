package manager

import (
	"testing"
	"time"

	"github.com/tunex/agent/internal/forwarder"
)

// Regression: **端口守卫必须在 runtime 生命周期结束后真的释放**，否则复用同一端口的下一条
// 路由会被 Agent 拒绝（"port N is already used by another tunnel"），而面板的端口租约
// 早已释放 —— 两边对"这个端口归谁"给了不同答案。
//
// 现场证据（真拓扑，CI 与本地都复现）：
//
//	tunnel applied id=tunex-4-egress mode=EGRESS port=22001 revision=2
//	tunnel removed id=tunex-4-egress mode=EGRESS port=22001
//	… 2.5 小时后，新路由拿到 22001 →
//	[egress_apply_rejected] 拒绝 apply_tunnel：manager: port 22001 is already used by another tunnel
//
// 所以这里钉住的是**行为**而不是内部实现：应用 → 热替换（同端口） → 移除 → 复用同一端口，
// 每一步之后守卫的状态都必须与"实际上还有没有 runtime 在听这个端口"一致。
func egressCfgFor(id string, port int, rev int64) forwarder.TunnelConfig {
	return forwarder.TunnelConfig{
		ID:         id,
		Mode:       forwarder.ModeEgress,
		EgressPort: port,
		Protocol:   "tcp",
		Revision:   rev,
	}
}

func TestPortGuardIsFreedAfterRuntimeLifecycle(t *testing.T) {
	em := NewEgressManager()
	tm := NewTunnelManager(em, "127.0.0.1")
	em.SetPool("t-old", RoundRobin, []forwarder.Target{tg("127.0.0.1", 1)})
	em.SetPool("t-new", RoundRobin, []forwarder.Target{tg("127.0.0.1", 1)})

	port := freePort(t)

	if _, err := tm.Apply(egressCfgFor("t-old", port, 1)); err != nil {
		t.Fatalf("initial apply: %v", err)
	}
	if !tm.UsedPorts()[port] {
		t.Fatalf("port %d must be guarded while its runtime is running", port)
	}

	// 热替换：同 id 同端口、revision+1（真实拓扑里这一拍紧接着 applied revision=2 / removed）。
	if _, err := tm.Apply(egressCfgFor("t-old", port, 2)); err != nil {
		t.Fatalf("hot swap on the same port: %v", err)
	}

	// 移除：之后守卫必须不再持有这个端口。
	if err := tm.Remove("t-old"); err != nil {
		t.Fatalf("remove: %v", err)
	}
	if !portFreedWithin(t, tm.UsedPorts, port, 2*time.Second) {
		t.Fatalf("port %d is still guarded after the runtime was removed (guard leak)", port)
	}

	// 复用同一端口：这就是现场失败的那一步（新路由拿到刚释放的端口）。
	// Remove 先删除 desired entry；守卫在 Stop 返回后释放，内核 socket 此时也必须已经关闭。
	waitForPortClosed(t, port)
	if _, err := tm.Apply(egressCfgFor("t-new", port, 1)); err != nil {
		t.Fatalf("reusing a freed port must work, got: %v", err)
	}
	if err := tm.Remove("t-new"); err != nil {
		t.Fatalf("remove new: %v", err)
	}
	if !portFreedWithin(t, tm.UsedPorts, port, 2*time.Second) {
		t.Fatalf("port %d leaked again after the second lifecycle", port)
	}
}

// 同样的纪律，但走"换端口"的路径（listener move）：旧端口是**在旧 forwarder 停止之后**
// 才释放的（见 applyLocked 的注释）。这条路径一旦没跑到，键就永久留着 —— 而复用旧端口的
// 下一条路由会被拒。这里同时钉住两个方向：旧端口必须释放、新端口必须保留。
func TestPortGuardIsFreedWhenListenerMovesToAnotherPort(t *testing.T) {
	em := NewEgressManager()
	tm := NewTunnelManager(em, "127.0.0.1")
	em.SetPool("mv", RoundRobin, []forwarder.Target{tg("127.0.0.1", 1)})
	em.SetPool("mv2", RoundRobin, []forwarder.Target{tg("127.0.0.1", 1)})

	first := freePort(t)
	second := freePort(t)
	if first == second {
		t.Skip("freePort handed out the same port twice")
	}

	if _, err := tm.Apply(egressCfgFor("mv", first, 1)); err != nil {
		t.Fatalf("initial apply: %v", err)
	}
	if _, err := tm.Apply(egressCfgFor("mv", second, 2)); err != nil {
		t.Fatalf("listener move: %v", err)
	}
	if !portFreedWithin(t, tm.UsedPorts, first, 2*time.Second) {
		t.Fatalf("the old port %d is still guarded after the listener moved away (guard leak)", first)
	}
	if !tm.UsedPorts()[second] {
		t.Fatalf("the new port %d must stay guarded", second)
	}

	// 复用被让出的那个端口：这正是"移动之后旧端口可以再分配"的前提。
	waitForPortClosed(t, first)
	if _, err := tm.Apply(egressCfgFor("mv2", first, 1)); err != nil {
		t.Fatalf("reusing the released port must work, got: %v", err)
	}
}

// "挂账"必须有界：正常路径由 Stop 返回时清账（drain 上界 3s），但**清账动作没跑到**
// 不能等于"这个端口永远不可用" —— 这正是 S7 事故的形态（21003 早在 S3 就被移走，
// 几分钟后 Agent 的 used_ports 里还留着它，面板于是再也发不出这个端口）。
// 这里直接构造一个过期的挂账，断言它在重建时被抹掉、端口可以立刻复用。
func TestStoppingPortNoteExpiresInsteadOfHoldingThePortForever(t *testing.T) {
	em := NewEgressManager()
	tm := NewTunnelManager(em, "127.0.0.1")
	em.SetPool("exp", RoundRobin, []forwarder.Target{tg("127.0.0.1", 1)})

	port := freePort(t)
	cfg := egressCfgFor("exp", port, 1)

	// 模拟"Stop 已发起、清账没跑到"：登记挂账，然后把它标成早已过期。
	tm.mu.Lock()
	tm.noteStoppingLocked(cfg)
	key := portGuardKey(cfg)
	tm.stoppingPorts[key] = stoppingNote{count: 1, until: time.Now().Add(-time.Second)}
	tm.rebuildPortGuardLocked()
	_, stillHeld := tm.stoppingPorts[key]
	tm.mu.Unlock()
	// 读取守卫视图要在**解锁之后**：UsedPorts() 自己也取锁，RWMutex 不可重入。
	held := tm.UsedPorts()[port]

	if stillHeld {
		t.Fatalf("an expired stopping note must be dropped by the rebuild")
	}
	if held {
		t.Fatalf("port %d must not stay guarded once the note expired", port)
	}
	if _, err := tm.Apply(cfg); err != nil {
		t.Fatalf("the port must be usable again after the note expired, got: %v", err)
	}
}
