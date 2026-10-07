# ForwardX / TuneX 逐项功能对比与开发方向选择

> 2026-10-07；TuneX：`origin/main@fa815ebe4cf42c4376ef9321922fd233a8e8ba2a`。
> ForwardX：`2.3.281@cb0ef0bb156dc114e4344c887328018491fbd638`，用户下载的 `Forwardx/` 参考树。
> 本表以源码实现与实际入口为依据。本轮不实施业务功能，也未重新运行双方全部真实网络、生产 UI 或第三方服务验收。

## 如何阅读

**已有**：找到相应实现及调用路径，仍受部署环境/开关/支持范围约束。**部分**：有相关能力，覆盖范围或产品流程尚未对齐。**待接入**：A01 只保留契约，实际 runtime/资源闭环尚未完成。**缺失**：本次检查未找到对应完整入口。**需修复**：源码或此前复现已确认的问题。**待核实**：不能据现有证据断言支持或不支持。

ForwardX 的“有”也仅代表固定版本有实现；不同 driver、内核、二进制、权限和网络环境会限制组合，不等于所有协议与选项可任意组合。没有给出虚构的对齐率。表中的证据编号对应文末源码索引。

总体判断：TuneX 已有基础 TCP/UDP 转发、简单中继、入口主备、目标池、加权轮询、版本部署、租约及跨面板委托。ForwardX 的主要优势是独立连接资源、多种 carrier/driver、`both`、丰富目标选择与规则操作，以及较完整的运维/生态。TuneX 的 Workspace 权限、版本/所有权机制和跨面板能力应继续保留。

## 1. 协议、载体与驱动

| ID | 功能 | ForwardX | TuneX 当前状态及边界 | 方向 / 证据 |
| --- | --- | --- | --- | --- |
| P01 | 本机 TCP 端口转发 | 有，多 driver | **已有** native TCP | 基线 / S01 |
| P02 | 本机 UDP 端口转发 | 有，多 driver | **已有** native UDP，含 mapping 生命周期 | B、E / S01 |
| P03 | 节点间 TCP/UDP 中继 | 有 FXP/GOST 等实现 | **已有** native relay；协议支持不代表跳间加密 | A、E / S01、S02 |
| P04 | 一条规则同时 TCP+UDP：`both` | 有，按协议执行 | **待接入**；只有 A01 名称，不能创建等价业务运行时 | B / S01、S03 |
| P05 | TCP/UDP 共用同号端口 | 有协议化规则与端口预留 | **缺失**；现有节点端口租约与 Agent guard 保守地跨协议互斥 | B / S03 |
| P06 | IPv6、IPv4/v6 监听与目标 | 有相关配置与执行路径 | **部分**；地址处理有实现，wildcard/dual-stack 租约冲突仍需规范化和真实验收 | B / S03 |
| P07 | 客户端入口 TLS / WebSocket | 有相关 GOST/隧道配置，维度不同 | **已有** native `tls`/`ws` 入口；不能由此宣称有 GOST TLS/WSS 跳间载体 | A、I / S01、S02 |
| P08 | 节点间加密、对端认证 | FXP 和对应 GOST 模式有实现 | **缺少等价载体**；现有 TCP hop 为明文，暴露出口端口时需特别处理 peer 边界 | A / S02 |
| P09 | FXP v1 加密 TCP/UDP | 有真实 FXP runner | **待接入**；`fxp_v1` 保持 planned | A / S02 |
| P10 | FXP v2 / userspace WireGuard | 有 WireGuard/netstack runtime | **待接入**；词汇有，runner 无等价实现 | I / S02 |
| P11 | GOST TCP carrier | 有配置规划、认证与 Agent 管理 | **待接入**；原生 TCP 不等于 GOST | I / S02 |
| P12 | GOST TLS/WSS carrier | 有对应配置和运行路径 | **待接入**；不能用客户端 TLS/WS 代替 | I / S02 |
| P13 | ForwardX mTLS/mWSS/mTCP 等高级模式 | 有，受 Agent/环境/模式条件限制 | **待接入**；名称已预留，语义需逐模式验证 | I，后续 / S02 |
| P14 | iptables 转发 | 有 Agent 动作与清理逻辑 | **缺失**等价受管 driver | I，后续 / S04 |
| P15 | nftables 转发 | 有 Agent 动作与清理逻辑 | **缺失**等价受管 driver | I，后续 / S04 |
| P16 | realm 转发 | 有受管二进制/配置路径 | **缺失**等价受管 driver | I，后续 / S04 |
| P17 | socat 转发 | 有受管动作 | **缺失**等价受管 driver | I，后续 / S04 |
| P18 | nginx / nginx stream | 有，受模块/模式配置约束 | **缺失**等价受管 driver | I，后续 / S04 |
| P19 | PROXY protocol v1/v2，源 IP 传递 | 有 receive/send/exit 选项，支持组合有限制 | **缺失**完整执行链；须定义可信前置，不能信任任意客户端 header | C、I / S04、S08 |
| P20 | TFO、zero-copy 等传输选项 | 有，driver/协议限制明确 | **缺少同类产品闭环**；不能只增加 UI 开关 | I，按场景 / S04 |
| P21 | Agent/runner 版本与能力准入 | 有模式最低版本、任务/Agent 能力检查 | **部分、需补齐**；已有 capability 底座，但 A01 准入未解析版本或比较 floor | A、E / S02、S13 |

## 2. 连接资源与拓扑

| ID | 功能 | ForwardX | TuneX 当前状态及边界 | 方向 / 证据 |
| --- | --- | --- | --- | --- |
| R01 | 独立可创建/部署的点对点隧道资源 | 有 tunnels 资源 | **待接入** LinkResource；现有 Forward 路径和模板不是等价资源 | A / S05 |
| R02 | 多条业务规则复用同一连接资源 | 有资源引用与共享出口运行语义 | **缺失**独立 Link 的 binding/compiler 闭环 | A / S05 |
| R03 | 删除一条规则不删除共享连接 | 有相应资源生命周期划分 | **待接入**；须验证 A/B 隔离、引用中删 Link 返回 409 | A、E / S05 |
| R04 | 零规则的资源保留、被动入口状态 | 有资源与 passive marker 语义 | **待接入**；不能要求每个资源角色都拥有业务 listener | A、E / S05 |
| R05 | 共享连接编辑、影响预览与版本升级 | 有共享资源修改流程 | **部分**；Forward 版本/预览已有，LinkVersion/generation 仅契约 | A、E / S05、S13 |
| R06 | 固定单中间节点路径 | 有 | **已有**简单 middle 路径与自动关系准备 | H，沿用 / S06 |
| R07 | 多个中间节点的转发链 | 有 chain 模式与 relay 规划 | **部分**；当前至多 3 节点/1 middle，不支持任意长度链 | H / S06 |
| R08 | 中继备选与动态 middle 候选池 | 有 relay 候选/故障切换；不能推导任意 chain 都可逐连接动态选节点 | **缺失动态 middle**；编译器显式拒绝 middle 节点组候选 | H / S06 |
| R09 | 多入口同时对外转发 | 有 entry group 部署 | **缺失**等价多活；现有 ingress members/主备不等于多入口同时运行 | H / S07 |
| R10 | 多出口节点/隧道组成业务出口组 | 有 exit group | **部分**；目标池已有，不能当成多节点 Link 出口组 | D、H / S07 |
| R11 | 入口故障切换、优先入口、回切 | 有 failover group/窗口 | **已有基础** preferred ingress、failover、fencing；新 Link 仍需接线 | D、E / S07 |
| R12 | 创建预设、节点组与运行资源区分 | 有资源组与配置流程 | **已有模板/NodeGroup**，各有明确语义；不应重命名后假装 Link 已实现 | A、F / S05、S06 |
| R13 | 跨面板借用远端出口 | 有迁移/接管等能力，本次未证实等价 federation | **已有 TuneX 特有闭环**：信任/授权/租约/用量；只支持有限远端末跳 | 保留，后续 / S14 |

## 3. 目标选择、限制与访问策略

| ID | 功能 | ForwardX | TuneX 当前状态及边界 | 方向 / 证据 |
| --- | --- | --- | --- | --- |
| L01 | 轮询、随机目标选择 | 有 round_robin/random | **已有** round/rand | D，完善 / S08 |
| L02 | 加权轮询 | 本次 core exit/failover 枚举未列统一权重策略；不推断所有 driver 都不支持权重 | **已有** weighted_round；#72 修复 UI、下发和重启继承 | 保留，D / S08 |
| L03 | 多目标主备 fallback 与自动回切 | 有策略、失败/恢复窗口 | **部分**；健康过滤与入口主备已有，完整目标 fallback 策略尚未对齐 | D / S08 |
| L04 | 来源 IP 哈希、粘滞选择 | 有 ip_hash | **缺失**等价 Agent selector；旧常量有 hash 不能算已执行 | D / S08 |
| L05 | 目标健康、失败剔除、恢复 | 有探测/选择逻辑 | **已有基础** target-health 与 Agent 选择器；需补策略/窗口验收 | D、E / S08 |
| L06 | 目标池热更新 | 有 | **已有**更新 targets/health 的实现；与共享 Link 更新分开 | D、E / S08 |
| L07 | 双向带宽限制 | FXP 有 LimitIn/LimitOut 和实际 limiter；其他 driver 按能力核对 | **需补执行闭环**；多条下发仍为 `speed_limit: 0`，Go 字段不代表 limiter 生效 | C / S09 |
| L08 | 总并发连接上限 | FXP 有 gate，部分驱动还有系统限制 | **部分**；有固定保护与策略字段，配置额度未完整贯通数据面 | C / S09 |
| L09 | 每个来源 IP 的并发上限 | FXP `maxIPs` 实际映射 `maxPerIP`，按 `ips[ip]` 限制 | **缺失**同类可配置执行闭环 | C / S09 |
| L10 | 最多同时接入多少个不同来源 IP | 不能从 `maxIPs` 推导；本次未确认通用等价功能 | **待核实语义/执行**；`ip_limit` 字段需明确口径 | C，可选扩展 / S09 |
| L11 | 任意来源 CIDR allow/deny | 本次未确认通用规则级闭环；accessScope 不等于 CIDR 白名单 | **未找到通用数据面闭环**；共享节点授权名单也不等于包来源 ACL | C，可选扩展 / S09 |
| L12 | 规则数量、端口范围、服务端配额 | 有 reservation/准入 | **已有**服务端策略/租约/准入；不能把所有 quota 都判成失效 | C，保留 / S03、S09 |
| L13 | 流量额度与超限处理 | 有流量/订阅策略 | **已有计量和准入基础**；新 carrier 的方向与重复统计口径需接入 | C、E / S09、S12 |
| L14 | HTTP/SOCKS/TLS 流量识别与屏蔽 | FXP 有 BlockHTTP/BlockSocks/BlockTLS 处理 | **缺失**等价可配置执行；范围有限的识别不应称为完整 DPI | C，可选 / S09 |

## 4. 规则管理体验

| ID | 功能 | ForwardX | TuneX 当前状态及边界 | 方向 / 证据 |
| --- | --- | --- | --- | --- |
| W01 | 创建、编辑、启停、删除单条规则 | 有 | **已有**权限与 rollout 路径 | F、E，完善 / S10 |
| W02 | 服务端搜索、筛选、排序、分页 | 有 | **已有**分页/稳定排序/过滤；需按实际交互补体验，不从零重写 | F / S10 |
| W03 | 批量启停/重试 | 有批量工作流 | **已有** retry/suspend/resume，单次至多 50 条 | F / S10 |
| W04 | 批量删除及逐项失败 | 有 deleteBatch | **已合入** #73；实验开关默认关闭，逐项权限/确认/失败隔离已有 | F、E / S10、S13 |
| W05 | 批量复制规则 | 有客户端批量 copy，调用现有创建流程 | **缺失**完整用户工作流 | F / S10 |
| W06 | 批量修改目标地址/端口 | 有批量 edit 流程 | **缺失**完整批量闭环；单规则 patch 可复用 | F / S10 |
| W07 | 批量替换节点/连接资源 | 有资源选择与冲突处理 | **缺失**对应批量闭环；新 Link 完成后再接共享影响预览 | F，依赖 A / S10 |
| W08 | 规则 JSON 导出 | 有选中规则分批导出 | **缺失**完整用户入口；未来导出不包含凭据/运行事实 | F / S10 |
| W09 | 规则导入、资源映射与端口冲突处理 | 有 import、skip/auto/error 等流程 | **缺失**完整用户入口；需 dry-run 和逐项结果 | F / S10 |
| W10 | 修改前预览部署影响 | 有资源与规则操作相关校验 | **已有 Forward 预览基础**；共享 Link 的受影响规则预览未实现 | F、A / S10、S13 |

## 5. 运行状态、恢复、计量与诊断

| ID | 功能 | ForwardX | TuneX 当前状态及边界 | 方向 / 证据 |
| --- | --- | --- | --- | --- |
| D01 | enabled/deployed/running/available 分层 | 有 runtime plan/readiness/passive marker | **部分**；#74 改善状态真值，admin tunnel 列表仍把 desired active 投影成 online | E / S11 |
| D02 | 每规则流量、即时吞吐与历史 | 有规则/节点/用户流量接口 | **已有** traffic/throughput；新 carrier 需统一方向、倍率与去重口径 | E / S12 |
| D03 | 延迟记录与历史图表 | 有链路延迟/图表路径 | **已有基础** latency samples/hourly；高级拓扑展示仍受支持范围限制 | E、H / S12 |
| D04 | 逐跳/目标诊断与链路自测 | 有 rules/chain selfTest | **部分**；已有 topology、probe-plan、diagnose，不能把 TCP 探针当 UDP 业务证明 | E / S12 |
| D05 | TCP connect、Ping、IPv4/IPv6 路径跟踪 | 有相应方法 | **已有**方法执行与能力准入；traceroute 使用无特权 tracepath，受节点二进制/网络限制 | E / S12 |
| D06 | MTR / MTR6 | 有相应方法，受工具/权限条件限制 | **明确未支持**；当前镜像/权限不能冒充支持 | E，可选 / S12 |
| D07 | iperf3 受控测速、服务端启停 | 有 task/start/stop/status | **缺失**等价闭环 | E，可选 / S12 |
| D08 | 脱敏支持包 | 有支持包生成 | **已有单节点**，多节点聚合不足 | E / S12 |
| D09 | Agent 重启、Panel 暂不可达恢复 | 有 managed config/recovery | **已有** restore/LKG/reconcile；FXP 密钥和新 Link 尚未接入 | E、A / S13 |
| D10 | 删除确认、租约释放、端口复用、旧配置拒绝 | 有相应生命周期逻辑，不据此假设上游全部故障场景无问题 | **已有基础且 #71/#73 加强**；tombstone 当前进程内，重启组合仍需证明 | E / S13 |

## 6. DDNS

| ID | 功能 | ForwardX | TuneX 当前状态及边界 | 方向 / 证据 |
| --- | --- | --- | --- | --- |
| N01 | Cloudflare 原生接口 | 有真实 API adapter | **需修复/补实现**；名字有，实际仅自定义 HTTP `/records` bridge | G / S15 |
| N02 | 华为云原生接口 | 有签名和更新 adapter | **需补实现**；现有 huawei 名称不代表原生签名接口 | G / S15 |
| N03 | 阿里云 DNS | 有签名和 adapter | **缺失**原生 provider | G / S15 |
| N04 | 腾讯云 DNS | 有签名和 adapter | **缺失**原生 provider | G / S15 |
| N05 | 通用 Webhook DDNS | 有 webhook URL/method/headers | **部分**；目前只有固定 HTTP bridge 协议，不等价任意 webhook | G / S15 |
| N06 | 多地址规划、读回、退避、更新状态 | 有多值更新和 provider 执行 | **已有执行器基础**；保留 sealed credentials/verified 与 unverified，补真实厂商适配 | G、E / S15 |

## 7. 节点运维、账户、商业与生态

这些功能用于完整对比；支付及生态仍按用户要求后置。下面“缺失”不会自动变成本轮开发任务。

| ID | 功能 | ForwardX | TuneX 当前状态及边界 | 方向 / 证据 |
| --- | --- | --- | --- | --- |
| O01 | 节点创建、维护、退役、删除 | 有主机 CRUD | **已有**独立生命周期、引用影响检查和受保护删除 | J / S16 |
| O02 | Agent 安装/重装与注册 | 有安装脚本/注册/token 体系 | **已有**一次性安装令牌、消费后节点独立凭据 | J，保留 / S16 |
| O03 | CPU/内存/网络等节点遥测历史 | 有最新指标、历史与默认 72h 清理 | **部分**；当前健康/版本/uptime 有，等价资源历史曲线不足 | J、E / S16 |
| O04 | 节点展示分组/排序 | 有展示主机组 | **部分**；NodeGroup 有权限/调度语义，不等价纯展示组 | J、F / S16 |
| O05 | 通知渠道与测试发送 | 有邮件/TG 测试；未见等价通用运维 webhook 渠道 | **部分**；Email/Webhook/TG 发送与部分配置已有，测试发送入口不足 | J / S17 |
| O06 | 节点离线/恢复防抖通知 | 有 TG 通知与防抖，接管理员绑定 | **部分**；离线检测有，节点事实到通知触发器仍未闭环 | J、E / S17 |
| O07 | 投递账本、失败原因与重试 | 已核路径有日志/发送计数，未见等价账本 | **已有 TuneX 优势**；持久投递记录、失败/去重/重试和工作区隔离 | 保留 / S17 |
| O08 | 公告编辑、忽略、升级弹窗 | 有创建/编辑/删除/忽略及推送 | **部分**；创建/撤销/忽略/展示有，编辑和等价版本弹窗不足 | J / S17 |
| O09 | 单机/分波远程 Agent 升级 | 有持久任务与分波，默认每波 5 台、15s 间隔 | **部分**；手动执行升级脚本和版本状态有，等价远程分波不足 | J / S18 |
| O10 | 面板更新、任务状态与回退 | 有更新任务、近期版本回退入口 | **部分**；ops rollback 脚本有，面板任务闭环不足 | J / S18 |
| O11 | 运行日志分页/导出/清理 | 有独立运行日志管理 | **部分**；stdout/审计有，运行日志管理不足；不能把审计当运行日志 | J、E / S18 |
| O12 | 备份与恢复 | 有加密业务快照/重复导入识别/Agent 刷新 | **部分**；MySQL/Redis/配置 ops 备份恢复脚本有，面板任务入口不足 | J / S18 |
| O13 | 邮箱注册/验证/找回密码 | 有 | **已有**相应邮箱账户流程 | K，保留 / S19 |
| O14 | Telegram 身份绑定及登录 | 有 Widget/WebApp/移动登录 | **缺失**等价登录流程；保存 tg_id 不等于完成登录 | K / S19 |
| O15 | 登出/改密立即撤销旧会话 | 有数据库活动 session 与撤销 | **需修复**；目前登出清 cookie，旧无状态 JWT 仍可验证 | K，基础修复 / S19 |
| O16 | TOTP 双因素登录/绑定/解绑 | 有，受全局开关控制 | **缺失**完整 TOTP 挑战流程 | K / S19 |
| O17 | 人机挑战及设备/session 策略 | 有服务端验证码/CAP 与设备租约 | **部分**；IP 限流有，完整挑战/设备会话策略不足 | K / S19 |
| O18 | 平台/工作区细粒度自定义权限 | admin/user 加资源授权；未见等价自定义工作区角色 | **已有 TuneX 优势**；平台/工作区权限、成员、角色与作用域检查 | 保留 / S20 |
| O19 | 套餐管理及余额购买 | 有商品/订阅/余额购买 | **已有**购买事务、优惠复检、扣余额、订单/订阅/授权发放 | L，后置 / S21 |
| O20 | 多订阅叠加与指定订阅续期 | 有多活动订阅与额度聚合 | **部分**；每 Workspace 单订阅，不等价同空间多份叠加 | L，后置 / S21 |
| O21 | 自动续费开关 | 本次只核到指定订阅手动续期，未确认等价自动扣款开关 | **需修复本项目事实源**；设置写 User，执行读 PlanSubscription | L，本项目问题 / S21 |
| O22 | 支付渠道管理及套餐在线直购 | 多渠道、配置、订单指定套餐/订阅 | **部分**；EPay/BEPUSDT/Heleket 有，当前主要充值，管理/直接履约不足 | L，后置 / S22 |
| O23 | 用户钱包流水、订单查询/取消 | 有钱包/支付订单工作流 | **部分**；充值查单/取消 API 有，用户完整钱包流水和取消 UI 不足 | L，后置 / S22 |
| O24 | 优惠码预览/管理与兑换码 | 有优惠预览、管理和余额/套餐兑换码 | **部分**；购买校验优惠已有，预览/管理/输入不足，兑换体系缺失 | L，后置 / S21 |
| O25 | 回调金额校验与渠道/订单绑定 | 有非正金额/不匹配/provider 拒绝 | **需修复**；缺金额跳过校验、没有按 payment_id 绑定 callback；此前本地 fixture 已复现 | L，支付启用前 / S22 |
| O26 | 未付订单并发与超时重启恢复 | 有到期扫描、处理中订单恢复 | **需修复**；5s 锁内先调网关再落单；默认进程 timer 缺恢复接线 | L，支付启用前 / S22 |
| O27 | 流量包/按量账单 | 有 trafficBilling 商业流程 | **部分**；计量有，完整按量收费/流量包流程不足 | L，后置 / S22 |
| O28 | 首次安装向导与首页/侧栏个性化 | 有 DB/管理员安装与自定义页面/菜单/背景 | **部分**；seed/部署脚本与基础站点设置有，等价向导/内容配置不足 | J、M / S23 |
| O29 | 插件安装/信任/执行/卸载 | 有商店/GitHub/上传包及受控动作 | **缺失**插件平台；noop 也不能作为已执行插件的证据 | M，后置 / S24 |
| O30 | AI 查询与确认式管理 | TG 结构化意图、原发起人确认后执行 | **缺失**等价流程；TG 通知发送器不是 AI 管理机器人 | M，后置 / S24 |
| O31 | Android 提醒/APK 更新流程 | 有 Capacitor 壳、本地提醒和打开发布页 | **缺失**；不是云推送或自动安装能力 | M，后置 / S24 |
| O32 | 跨面板数据迁移、审批、接管 | 有 migration code、scope、目标 URL 与审批 | **部分**；备用面板切换/federation 有，数据迁移审批不等价 | J，后续 / S25 |
| O33 | 数据库类型切换/迁移 | 有 SQLite/MySQL/PostgreSQL；目标状态和强制 env 有限制 | **缺失**等价面板流程；当前固定 Prisma/MySQL | M，后置 / S25 |

退款、返佣、工单客服、团队钱包：本次未在 ForwardX 核到完整原生闭环，不把这些当成它已经完成的标准功能。TuneX 有工单入口，但管理员回复/协作流程不足；团队权限也不意味着团队钱包已做完。这些应单列为项目扩展。

## 8. 可选择的后续主方向

| 编号 | 方向 | 对用户最直接的收益 | 对应功能 | 依赖与范围 |
| --- | --- | --- | --- | --- |
| A | 加密隧道与可复用连接资源 | 建一条真实 FXP 连接，多条规则复用，操作一条不影响其他规则 | P08/P09、R01–R05 | 首轮固定点对点；复用 FXP，补 binding 授权；最小生命周期与 UI 同步完成 |
| B | TCP+UDP 与协议/端口完善 | 一条规则可同时转发 TCP/UDP，同号端口正确工作，IPv6 边界明确 | P02/P04–P06 | 改协议租约、Agent guard、children 与迁移；不只是增加 both 下拉选项 |
| C | 真实限速和连接限制 | 面板配置真正作用于流量，限制连接并发与每来源并发 | L07–L14、P19 | 先复用 FXP limiter/gate；不同来源 IP 上限、CIDR、协议识别单独选，不混同 |
| D | 多目标主备与目标选择 | 目标故障后切换，支持回切、轮询/随机/加权及来源 IP 粘滞 | L01–L06、R11 | 先完善同出口多个业务目标；跨节点出口组分到 H；沿用现有健康/选择器 |
| E | 转发可靠性与故障定位 | 重启/删除/更新不留下僵尸资源，用户能知道哪一段出问题 | D01–D10 | 各方向必带必要恢复/状态验收；MTR/iperf3/复杂图表可以后置 |
| F | 批量规则与迁移体验 | 快速复制、导入导出、批量改目标/资源，减少重复操作 | W01–W10 | 可先独立做 copy/import/export；批量改新 Link 依赖 A |
| G | 原生 DDNS 与域名切换 | 厂商 token/AK 可以直接使用，入口变化后域名真实更新 | N01–N06 | 先 Cloudflare，再华为/阿里/腾讯；复用上游 adapter 和现有执行器 |
| H | 多跳、多出口与多入口 | 构建更复杂链路、出口组和同时服务的入口组 | R06–R11 | 在 A 的运行身份、租约和共享编译稳定后开放；固定主备先于多活/自动寻路 |
| I | 更多 carrier/driver | 满足 GOST/WG、系统转发与高级传输需求 | P10–P18/P20 | 按实际场景逐个接入，不一次性搬所有驱动；依赖 A/E 的托管能力 |
| J | 节点运维与通知 | 远程升级、资源历史、离线提醒、日志、备份任务 | O01–O12/O28/O32 | 转发基础稳定后推进；已有脚本/投递底座优先复用 |
| K | 账户与会话 | 会话撤销、2FA、设备与 Telegram 登录 | O13–O18 | 会话撤销可做独立小修复；账号体系扩展不抢占转发主线 |
| L | 订阅、支付与账务 | 渠道/订单/优惠、完整购买与续费体验 | O19–O27 | 按当前要求后置；支付启用前处理已确认资金问题 |
| M | 生态与部署扩展 | 插件、AI、Android、个性化和多数据库 | O28–O33 | 核心完成后按真实需求选择，避免同时重建整个面板 |

建议先选 **2–3 个主方向**。按“先把核心隧道转发做好”的目标，建议 **A → C/D**；E 的必要状态、删除与恢复验收随每个切片完成。若主要痛点是游戏/UDP 或同端口双协议，可优先 **A+B**；若已有链路够用但操作繁琐，可先选 **D+F**。这只是选择建议，尚未自动启动业务开发。

付款/套餐和大规模运维、插件、AI、Android 不进入本轮默认主线。自动最优路径也不能仅凭上游有 latency/group 配置就判定已经成熟可复用，需要独立核实。

对应实施拆分见 [核心后续开发方案](NEXT_CORE_PLAN_REVIEW.md)。选定方向后再围绕选中的功能缩小 PR 范围，保留其他方向的明确后置状态。

## 9. 源码索引

TuneX 文件均以以上主线提交核对；链接固定在该提交。ForwardX 文件路径相对只读 `Forwardx/`，不代表已作为 TuneX 依赖导入。

| 证据 | ForwardX 文件/定位 | TuneX 文件/定位 |
| --- | --- | --- |
| S01 | `shared/forwardTypes.ts`；`agent/actions.go`；`forwardx-fxp/main.go` | [forward-contract.ts](https://github.com/PaiMonCai/TuneX/blob/fa815ebe4cf42c4376ef9321922fd233a8e8ba2a/backend/src/services/forward-contract.ts)、[forwarder/factory.go](https://github.com/PaiMonCai/TuneX/blob/fa815ebe4cf42c4376ef9321922fd233a8e8ba2a/agent/internal/forwarder/factory.go)、`datagram.go`/`datagramrelay.go` |
| S02 | `forwardx-fxp/main.go`；`server/gostTunnelProtocol.ts`；`agent/wireguard_runtime.go` | [core-contract.ts](https://github.com/PaiMonCai/TuneX/blob/fa815ebe4cf42c4376ef9321922fd233a8e8ba2a/backend/src/integrations/forwardx/core-contract.ts)、[forwarder/singhop.go:91](https://github.com/PaiMonCai/TuneX/blob/fa815ebe4cf42c4376ef9321922fd233a8e8ba2a/agent/internal/forwarder/singhop.go#L91) |
| S03 | `server/portReservations.ts`；`shared/forwardTypes.ts` | [schema.prisma](https://github.com/PaiMonCai/TuneX/blob/fa815ebe4cf42c4376ef9321922fd233a8e8ba2a/backend/prisma/schema.prisma)：NodePortLease；[manager/tunnel.go](https://github.com/PaiMonCai/TuneX/blob/fa815ebe4cf42c4376ef9321922fd233a8e8ba2a/agent/internal/manager/tunnel.go)：跨协议 port guard |
| S04 | `agent/actions.go`；`server/routers/rules.crud.ts:145/193` | [forwarder/interface.go](https://github.com/PaiMonCai/TuneX/blob/fa815ebe4cf42c4376ef9321922fd233a8e8ba2a/agent/internal/forwarder/interface.go)、`forwarder/factory.go`；driver 无实现不能从常量推断支持 |
| S05 | `server/routers/tunnels.ts`；`server/tunnelRuntimePlan.ts:8` | [route-profile.ts:4](https://github.com/PaiMonCai/TuneX/blob/fa815ebe4cf42c4376ef9321922fd233a8e8ba2a/backend/src/services/route-profile.ts#L4)、`core-contract.ts`、[A01_CONTRACT.md](https://github.com/PaiMonCai/TuneX/blob/fa815ebe4cf42c4376ef9321922fd233a8e8ba2a/docs/plans/forwardx-core-2026-10-07/A01_CONTRACT.md) |
| S06 | `server/routers/forwardGroups.ts:42`；`shared/tunnelRelay.ts` | [forward-route.ts:50](https://github.com/PaiMonCai/TuneX/blob/fa815ebe4cf42c4376ef9321922fd233a8e8ba2a/backend/src/services/forward-route.ts#L50)、[route-profile-compiler.ts:191](https://github.com/PaiMonCai/TuneX/blob/fa815ebe4cf42c4376ef9321922fd233a8e8ba2a/backend/src/services/route-profile-compiler.ts#L191)、[forward-path-setup.ts](https://github.com/PaiMonCai/TuneX/blob/fa815ebe4cf42c4376ef9321922fd233a8e8ba2a/backend/src/services/forward-path-setup.ts) |
| S07 | `server/routers/forwardGroups.ts`；`shared/exitStrategy.ts` | [failover-loop.ts](https://github.com/PaiMonCai/TuneX/blob/fa815ebe4cf42c4376ef9321922fd233a8e8ba2a/backend/src/services/failover-loop.ts)、`preferred-ingress.ts`、`forwards.ts` 的 ingress-members/ha 路由、`node-admin-egress.ts` |
| S08 | `shared/exitStrategy.ts`；`server/routers/rules.crud.ts:43`；`forwardx-fxp/main.go` | [manager/lb.go:56](https://github.com/PaiMonCai/TuneX/blob/fa815ebe4cf42c4376ef9321922fd233a8e8ba2a/agent/internal/manager/lb.go#L56)、[target-health.ts](https://github.com/PaiMonCai/TuneX/blob/fa815ebe4cf42c4376ef9321922fd233a8e8ba2a/backend/src/services/target-health.ts)、`web/src/lib/constants.ts:64`；#72 |
| S09 | `forwardx-fxp/main.go:165/187/438/712`、`config_types.go:37`；`server/agentHeartbeatRoute.ts:2634` | [capability-policy.ts](https://github.com/PaiMonCai/TuneX/blob/fa815ebe4cf42c4376ef9321922fd233a8e8ba2a/backend/src/services/capability-policy.ts)、[agent-command-bus.ts:1169](https://github.com/PaiMonCai/TuneX/blob/fa815ebe4cf42c4376ef9321922fd233a8e8ba2a/backend/src/services/agent-command-bus.ts#L1169)；Group allowlist 与来源 CIDR 不同 |
| S10 | `client/src/pages/Rules.tsx:306/3340`；`server/routers/rules.crud.ts:2257`；`server/routers/rules.ts` | [forwards.ts](https://github.com/PaiMonCai/TuneX/blob/fa815ebe4cf42c4376ef9321922fd233a8e8ba2a/backend/src/routes/forwards.ts)、[forward-batch.ts](https://github.com/PaiMonCai/TuneX/blob/fa815ebe4cf42c4376ef9321922fd233a8e8ba2a/backend/src/services/forward-batch.ts)、[forward-list-query.ts](https://github.com/PaiMonCai/TuneX/blob/fa815ebe4cf42c4376ef9321922fd233a8e8ba2a/backend/src/services/forward-list-query.ts)、`web/src/components/forwards/` |
| S11 | `server/tunnelRuntimePlan.ts`；`shared/hostHeartbeat.ts` | [forward-topology.ts](https://github.com/PaiMonCai/TuneX/blob/fa815ebe4cf42c4376ef9321922fd233a8e8ba2a/backend/src/services/forward-topology.ts)、[admin-extended.ts:1232](https://github.com/PaiMonCai/TuneX/blob/fa815ebe4cf42c4376ef9321922fd233a8e8ba2a/backend/src/routes/admin-extended.ts#L1232)；#74 不代表所有旧读路径完成改造 |
| S12 | `server/routers/rules.traffic.ts`/`rules.selfTest.ts`/`lookingGlass.ts`；`server/supportBundle.ts` | [traffic.ts](https://github.com/PaiMonCai/TuneX/blob/fa815ebe4cf42c4376ef9321922fd233a8e8ba2a/backend/src/services/traffic.ts)、`latency-history.ts`/`forward-probe-plan.ts`/`support-bundle.ts`、[looking-glass.ts](https://github.com/PaiMonCai/TuneX/blob/fa815ebe4cf42c4376ef9321922fd233a8e8ba2a/backend/src/services/looking-glass.ts)、[diag/lookingglass.go:583](https://github.com/PaiMonCai/TuneX/blob/fa815ebe4cf42c4376ef9321922fd233a8e8ba2a/agent/internal/diag/lookingglass.go#L583) |
| S13 | `agent/managed_configs.go`；`agent/service_batch.go` | [forward-rollout.ts](https://github.com/PaiMonCai/TuneX/blob/fa815ebe4cf42c4376ef9321922fd233a8e8ba2a/backend/src/services/forward-rollout.ts)、`runtime-reconcile-sink.ts`、[restore/lkg.go](https://github.com/PaiMonCai/TuneX/blob/fa815ebe4cf42c4376ef9321922fd233a8e8ba2a/agent/internal/restore/lkg.go)、`manager/tunnel.go:70/214/705`；既有 A00 脚本 |
| S14 | `server/migration.ts`：迁移不等价 federation | [federation/forward-hop.ts](https://github.com/PaiMonCai/TuneX/blob/fa815ebe4cf42c4376ef9321922fd233a8e8ba2a/backend/src/services/federation/forward-hop.ts)、`federation/trust.ts`/`grant.ts`/`lease.ts`/`usage.ts`、`routes/admin-federation.ts` |
| S15 | `server/ddns.ts`：Cloudflare/华为/阿里/腾讯/webhook 原生 adapter | [ddns-executor.ts:163](https://github.com/PaiMonCai/TuneX/blob/fa815ebe4cf42c4376ef9321922fd233a8e8ba2a/backend/src/services/ddns-executor.ts#L163)、`ddns-binding.ts:66`、`ddns-successor.ts`、`web/src/components/ddns/dns-providers-manager.tsx` |
| S16 | `server/routers/hosts.ts:954/1019`、`routers/agentTokens.ts`、`repositories/metricsRepository.ts:241` | [node-lifecycle.ts](https://github.com/PaiMonCai/TuneX/blob/fa815ebe4cf42c4376ef9321922fd233a8e8ba2a/backend/src/routes/node-lifecycle.ts)、`services/node-enrollment.ts:93/144/238`、`services/node-health-service.ts:372` |
| S17 | `server/hostStatusNotifier.ts:96`、`hostOfflineNotificationDebouncer.ts`、`routers/telegram.ts:261`、`routers/announcements.ts:88` | [notification-delivery.ts](https://github.com/PaiMonCai/TuneX/blob/fa815ebe4cf42c4376ef9321922fd233a8e8ba2a/backend/src/services/notification-delivery.ts)、`notification-facts-trigger.ts:755`、`routes/notification-channels.ts`/`notification-deliveries.ts`/`announcements-admin.ts` |
| S18 | `server/routers/hosts.ts:1393`、`agentUpgradeRollout.ts`、`_core/systemRouter.ts:2601/2746/2802/2861`、`migration.ts` | [node-upgrade.ts](https://github.com/PaiMonCai/TuneX/blob/fa815ebe4cf42c4376ef9321922fd233a8e8ba2a/backend/src/services/node-upgrade.ts)、`routes/nodes.ts:306/337/550`、[backup.sh](https://github.com/PaiMonCai/TuneX/blob/fa815ebe4cf42c4376ef9321922fd233a8e8ba2a/scripts/ops/backup.sh)、`scripts/ops/restore.sh`/`rollback.sh`、`routes/admin-extended.ts:1329` |
| S19 | `server/routers/auth.ts:222/288/333/465/506`、`routers/telegram.ts:285/350`、`_core/context.ts:134`、`repositories/userRepository.ts:107` | [routes/auth.ts](https://github.com/PaiMonCai/TuneX/blob/fa815ebe4cf42c4376ef9321922fd233a8e8ba2a/backend/src/routes/auth.ts)、`middlewares/auth.ts:130/148`、`middlewares/rate-limit.ts`、`routes/settings.ts:145` |
| S20 | `server/_core/trpc.ts:70`、`routers/users.ts:196/213/260` | [permissions.ts](https://github.com/PaiMonCai/TuneX/blob/fa815ebe4cf42c4376ef9321922fd233a8e8ba2a/backend/src/permissions.ts)、`routes/workspace-roles.ts`、`services/workspace-effective-access.ts` |
| S21 | `server/routers/plans.ts`、`routers/billing.ts:109/162/173/245`、`repositories/billingRepository.ts:791/1511/2291` | [routes/plans.ts](https://github.com/PaiMonCai/TuneX/blob/fa815ebe4cf42c4376ef9321922fd233a8e8ba2a/backend/src/routes/plans.ts)、`services/subscription-purchase.ts:185`、`subscription-billing.ts:610`、`routes/settings.ts:113/118`、`schema.prisma:1334` |
| S22 | `server/payment.ts:94/731/779/790/954/1052`、`routers/trafficBilling.ts`、`client/src/pages/Wallet.tsx` | [payment/order.ts](https://github.com/PaiMonCai/TuneX/blob/fa815ebe4cf42c4376ef9321922fd233a8e8ba2a/backend/src/services/payment/order.ts)、`payment/index.ts:35`、`routes/pay.ts`/`topups.ts`、`web/src/components/topup/topup-body.tsx:144`、`services/traffic.ts` |
| S23 | `server/routers/setup.ts:348/409`、`_core/systemRouter.ts:2055/2059` | [seed.ts](https://github.com/PaiMonCai/TuneX/blob/fa815ebe4cf42c4376ef9321922fd233a8e8ba2a/backend/prisma/seed.ts)、`routes/public.ts:173`、`web/src/lib/nav.ts` |
| S24 | `server/routers/plugins.ts`、`repositories/pluginRepository.ts:4038/4184`、`telegramBot.ts:1782/2411/5319`、`android/`、`client/src/lib/mobileNotifications.ts` | [app.ts](https://github.com/PaiMonCai/TuneX/blob/fa815ebe4cf42c4376ef9321922fd233a8e8ba2a/backend/src/app.ts) 的路由挂载、`notification-telegram.ts`、`web/src/lib/nav.ts`；本次未找到对应生态闭环 |
| S25 | `server/migration.ts:2605/2634/2645`、`migrationCodes.ts:189`、`databaseSwitch.ts:237/773` | [panelroute.go](https://github.com/PaiMonCai/TuneX/blob/fa815ebe4cf42c4376ef9321922fd233a8e8ba2a/agent/internal/panelroute/panelroute.go)、`federation/`、`schema.prisma:8`、`backend/src/db.ts` |

## 10. 选择前需要记住的边界

- A01 的 `available` 表示当前 runtime 能执行对应形状，不能代表 Link CRUD/部署已做完；非 native 目前仍是 planned。
- PoC 成功不能立即正式开放；共享规则隔离、版本准入、密钥和资源生命周期是同一个核心转发切片的完成条件。
- `maxIPs`、不同来源 IP 数量和来源 CIDR 是三种功能；复用时按真实语义映射，不按名字猜。
- TuneX 已有流量/数量/资源准入；缺少部分数据面限制不能推出所有额度都无效。
- 参考树的 AGPL-3.0-only 与发行依赖需在导入时记录并确定分发方案；本轮仅做源码对比。
