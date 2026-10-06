# I1 — 审查与验证记录

> 当前为 Leader 对进行中实现的初步观察，不是最终审查结论。代理仍拥有其写入范围，Leader 暂不编辑产品文件；独立审查在 I1-A/B 完成后派发。

## 待最终版本复核的风险

1. `NodeInstallPoller` 的 stop → 立即 start：旧请求仍 inFlight 时，新 timer 直接返回，旧 generation 回包也不续轮，可能使 active 但无后续请求。需受控异步行为测试，不只重复 active.start。
2. 轮询在 await loadView 期间没有独立截止时钟：请求不完成时，30 分钟窗口是否真的会停止？需要 pending 请求跨 deadline 的测试。
3. 共享组件 mountedRef 的 effect 若只有 cleanup=false、setup 不重置 true，React StrictMode effect replay 后可能把所有 generation 响应丢弃。需真实交互验证。
4. 共享组件节点切换时，只在 effect 清命令是否足够？初始状态/当前render/复制动作不能短暂暴露属于另一节点的敏感命令；A→B→A 的旧 generation 不得恢复。
5. 安全确认必须保护所有生成路径，包括无本地 enrollment 时的“重开”按钮，不只显式重新生成按钮。
6. 实际 TTL 过期展示不能只在首次静态渲染时读 Date.now；用户停止轮询或跨有效期留页时仍应更新，且已 online/installed_offline 不误报安装失败。
7. 用户 create/load/reissue 必须权限 epoch + Workspace scope 同时隔离，不能只比较当前 scope（A→B→A）。成功 CTA 必须同时核对 role、admission、forward:create。

以上基于进行中源码快照，最终版本可能已修复。每项需独立审查重新阅读和测试证据后才能标为问题或通过。

## 真实验证准备

- 已发现系统有 Chromium 与 Playwright 1.63，可执行真实浏览器交互。
- 现有 wp14 网络恰占用既有 Integration 脚本的 172.31.0/10/20 网段，不删除或改动用户已有网络。
- Leader 在 `/tmp/tunex-harvest-integration-20261006/scripts/integration` 准备既有 setup/bootstrap/compose/teardown 的临时副本，仅将 172.31.* 改为 172.33.*、Compose project 改为 tunex-harvest-integration。没有修改源脚本、CI 或新增产品拓扑。
- 启动前已核查无 tunex-it-* 容器/网络/数据卷，未来 teardown 仅允许清理本次已确认测试资源及该绝对 scratch 目录的运行期文件。
- 当前源码 Backend/Agent 镜像构建任务 `bash-2941`；镜像独立标签 tunex-harvest-{backend,agent}:cafaaba，不覆盖既有其他产品镜像。
- 真 topology 能验证实际 enrollment/replay/Agent state report/Forward ACK，但不等于执行过宿主 root installer；真实浏览器仍需在实现完成后单独测试。

## 真实浏览器 + 真实 API 基线（修复前构建，2026-10-06 23:5x）

环境：隔离 scratch Integration（172.33 网段），4 台真实 Agent 完成凭据认证 state report，DIRECT/RELAY 等待真实 ACK，baseline Forward revision=1。Web 使用 23:14 构建产物（修复前），通过仅本地回环隧道访问测试 Panel（测试 API 未对 Docker 宿主发布端口，未改任何宿主防火墙或既有网络）。

已验证事实：
- 真实 `POST /api/node-groups/:id/nodes` 响应只有 `id/node_id/agent_id/connect_ip/node_group_id/role/port_range_min/port_range_max`，**无** `connection/has_credential/registered/accepts_new_business`。这独立证实 I1-D/I1-C 的 P1 前提：仅凭 provision 响应无法进入等待。
- 个人空间默认额度 `max_nodes=1`、`allow_custom_in_group=true`；用户域 `POST /api/node-groups` 自助建组成功，且响应**不含** legacy `token`（与 R2 结论一致，非仅源码推断）。
- 中文界面下 `src/components/ui/dialog.tsx:31` 的关闭按钮是无条件英文 `sr-only` "Close"（影响所有对话框的屏幕阅读器文案，非本切片引入）。属共享 primitive 的独立小债。
- 空态入口按钮文案为「创建节点」，而弹窗标题/提交按钮为「新建」，两处命名不一致（同一动作两种称呼）。同样需要在修复后复核。

## 补充产品债（升级，尚未批准修改）

Leader 阅读 `agent/Dockerfile` 与 `backend/src/services/node-upgrade.ts`：标准 Agent runtime 基于 Alpine，只 COPY cert/binary/entrypoint，未安装 curl；升级脚本身份校验却在容器内调用 curl。除 TUNEX_PUBLIC_PANEL_URL 不可发现之外，默认镜像可能无法执行该校验。需在已构建标准镜像中确认工具实际存在性，再定义用现有 Agent 工具/外部宿主 curl 等安全验证方案，不把加环境变量视为完整修复。
