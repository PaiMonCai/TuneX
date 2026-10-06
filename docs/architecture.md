# TuneX 当前架构

## 产品对象

普通用户的产品路径是：

```text
Route Profile → Forward → Traffic / Plan / Support
```

管理员管理 Node、NodeGroup、Route Profile、容量、健康、诊断、Federation 与系统配置。
`Tunnel` 是兼容与内部 desired/runtime 对象，不是新的产品入口。

## 三个运行层

### Web

Next.js / React / TypeScript。负责用户与管理控制台、表单、状态投影与 API 消费。Web 不应重新实现后端的健康、生命周期、权限或运行态判定。

### Backend

Bun + Hono + Prisma + MySQL + Redis。Backend 是产品规则、desired state、revision、计费、权限、调度、reconcile、Federation 与运维状态的主要真相源。

### Agent

Go。Agent 执行 Panel 下发的 runtime 计划并上报 ACK、遥测与实际运行态。Agent 不决定产品授权或 Workspace 权限。

## 运行时真相链

```text
product request
  → desired state
  → revision / rollout / lease
  → dispatch
  → Agent ACK
  → applied fact
  → reconciliation
```

任何一步事实不可读时，影响所有权、端口、计费、删除、迁移或跨 Panel 副作用的路径应 fail-closed，而不是猜测成功。

## Forward 与拓扑

- DIRECT：单节点终止并转发；
- RELAY：入口与出口分离；
- Multi-hop：在已冻结支持范围内增加中间跳；
- Route Profile：管理侧可复用的线路配置；
- Forward：用户侧主要消费对象；
- revision / rollout：负责把产品变更收敛到 runtime。

## Node 与资源所有权

Node lifecycle、connection、role、port lease、placement lease、Federation lease 与运行时 teardown 共同构成资源所有权边界。删除、角色收缩、端口收缩与迁移必须先证明依赖已清理。

## Federation

Federation 负责 Panel 间身份、签名、授权、租约、远端 runtime 与用量事实。签名绑定 HTTP method + path；租约使用 intent / CAS / fencing；远端副作用失败必须有可恢复台账。

## 流量与计费

历史流量使用不可变 Workspace 归属保存，不依赖 Forward 当前是否仍存在。Quota、Dashboard 与 Forward 流量视图应消费 canonical ledger，不维护第二套统计口径。

## 已关闭边界

QUIC、UDP 分片重组、packets 计费、hop AEAD/MAC、跨面板 UDP、remote transit、跨面板 3+ hop / arbitrary graph、跨面板自动 failover、TLS remote egress 与多 Panel 信任传递闭包保持关闭，并在边界处 fail-closed。
