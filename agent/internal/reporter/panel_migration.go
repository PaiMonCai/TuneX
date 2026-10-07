package reporter

import (
	"github.com/tunex/agent/internal/panelroute"
)

// 面板迁移回退的**判据与共享切换器**住在 internal/panelroute（task-45）。
//
// 为什么搬走：task-44 只让状态上报跟着切换，命令拉取 / ACK / 重连后的 desired
// fetch-reconcile 仍然各自用 cfg.PanelURL 的主地址 —— 主地址不可达、备用可达时，
// 节点在面板上恢复 online，却再也拉不到命令。判据现在只有一份（panelroute.Router），
// 出站控制面全部读同一个"当前生效地址"，谁都不再复制切换判定。
//
// 行为参照声明（ForwardX）、两处刻意偏离、以及真值表都在那个包里。本文件只保留
// Reporter 侧的**读取口**，供本地自检/调试与上报体构建使用。
//
// 地址来源：r.cfg.Router。生产路径由 runtime 在构造 reporter 之前创建，并同时注入
// control；若调用方没注入（单测/独立使用），reporter.New 会用 PanelURL + Panels
// 自己建一个私有切换器 —— 上报仍然按既有规则切换，但别的组件看不到它。

// PanelRoute 暴露当前路由状态（本地自检/调试用；纯读）。
func (r *Reporter) PanelRoute() panelroute.PanelRouteState {
	if r == nil || r.cfg.Router == nil {
		return panelroute.ReadyPanelRoute()
	}
	return r.cfg.Router.State()
}

// panelRouteSnapshot 一次取回"当前路由状态 + 迁移配置"。迁移配置构造后不可变，状态
// 是一次加锁读取，因此同一个上报体不会混用切换前后的两个事实。
func (r *Reporter) panelRouteSnapshot() (panelroute.PanelRouteState, panelroute.PanelMigration) {
	if r == nil || r.cfg.Router == nil {
		return panelroute.ReadyPanelRoute(), panelroute.PanelMigration{}
	}
	return r.cfg.Router.State(), r.cfg.Router.Migration()
}
