# TuneX vs RelayX（relayx-clone）差异对比报告

> 日期：2026-09-24 ｜ 基准：TuneX `main`（含 SEC-01 合并后）vs `/opt/relayx-clone`
> 结论先行：**两边 agent 数据面能力基本对等（都只实现了裸 TCP/UDP 转发），TuneX 的差距不在协议引擎，而在流量计量、邮箱验证与端到端验证深度；同时 TuneX 已多出原版没有的多租户底座、策略额度体系、限流、审计与 CI。**

---

## 1. 修正一个常见误判

「原版有 mtls/mwss/quic/wss 完整协议实现」——**不成立**。

实测 `relayx-clone/agent/internal/engine/runtime.go`：`grep -c 'mtls|mwss|quic|tls|wss'` = **0**。原版 engine 与 TuneX 一样只做 `net.Listen`/`net.Dial` 的裸 TCP/UDP；TLS 相关只有 `engine/config.go` 里的证书配置结构体，协议枚举（`tls/wss/quic/...`）在两边的 agent 里都是**声明存在、数据面未实现**。

agent 代码量：TuneX 4243 行 vs 原版 4228 行（基本持平，文件级 diff 主要是改名 + 端口分配修复 + 测试增删）。

## 2. TuneX 独有的能力（原版没有）

| 能力 | 落点 | 状态 |
|---|---|---|
| 多租户 Workspace/Member/Invite | schema + routes/workspaces.ts + services/workspace.ts | ✅ 后端完成，前端开发中 |
| 平台 RBAC 与计费解耦 | middlewares/auth.ts 去 `isBusinessLicense` | ✅ |
| CapabilityPolicy 策略额度体系 | capability-policy.ts + policy-service.ts + 迁移 | ✅ ~80%（见 §4） |
| 节点组授权 NodeGroupGrant | services/node-group-policy.ts（fail-closed） | ✅ |
| 全局限流（Redis Lua 原子计数） | middlewares/rate-limit.ts | ✅ |
| 审计日志（append-only + 超管查询页） | middlewares/audit.ts + AuditEvent | ✅ |
| 离线检测闭环（dc:* 防抖 60s + 10s 扫描） | socket/offline-detector.ts + worker | ✅ |
| listen_error 端口冲突闭环 | socket/listen-events.ts | ✅ |
| 多节点动态端口确定性分配 | socket/port-allocator.ts | ✅ |
| pushNodeConfig 指纹去重 | socket/config-pusher.ts | ✅ |
| Linux CI（真实 MySQL 迁移验证 + GHCR 镜像 + 秘密扫描） | .github/workflows/ci.yml | ✅ |
| 密钥 fail-fast（缺失即拒启动） | env.ts + crypto/keys.ts | ✅ |

## 3. 原版独有的内容（及是否需要补）

| 内容 | 文件 | TuneX 是否需要 |
|---|---|---|
| 支付渠道测试套件（epay/bepusdt/heleket 签名/订单集成） | `services/payment/__tests__/`（6 个文件） | **暂不需要**——支付已按 PAY-01 关闭；未来启用计费时参考重写 |
| `config-pusher`/`config-refresh` 原版测试 | `socket/__tests__/`（2 个文件） | **已覆盖**——TuneX 有 config-pusher-dedup 等 5 个新测试文件 |
| agent 单测（agentconfig/fernet/mux） | 3 个 `*_test.go` | **建议补回**——纯逻辑单测，与品牌无关，恢复成本低 |

## 4. TuneX 的真实差距（需要补全的）

### P0（阻塞 0.1 Beta）

| 差距 | 现状 | 归属工作包 |
|---|---|---|
| `config-generator.ts` 仍依赖 `user_plan` 过滤隧道 | policy-service.ts 已就绪，替换点未接线 | SOFT-01 收尾 |
| 注册时是否事务性分配默认策略待验证 | `assignDefaultPolicy` 已存在，auth.ts 调用点待确认 | SOFT-01 收尾 |
| 流量入库 worker 空壳 | `cron_save_traffic` 只 keys 计数不写 DB；`cron_delete_tunnel_traffic` 占位 | OPS-01 |
| 邮箱验证/密码重置 | 不存在 | TEN-01 收尾 |
| Workspace 前端 | 后端 API 就绪，前端开发中（代理进行中） | TEN-01 前端 |

### P1（可靠性）

| 差距 | 现状 |
|---|---|
| 双租户真实网络 E2E | 只有单节点 mock 级验证；PLAN §7 要求的外部客户端双租户链路未做 |
| 流量按 workspace 聚合 | TunnelTraffic 表存在，聚合与展示未接 |
| Worker 其余 cron 空壳 | sync_dns / update_agent / renew 等 6 个占位 |
| 备份/恢复演练 | 未做 |

### P2（产品完整度）

| 差距 | 现状 |
|---|---|
| 自定义团队角色 | 固定四角色（owner/admin/member/viewer）已够 0.1，自定义角色属 TEAM-01 |
| 前端管理面板细节 | 基础 CRUD 已补齐；图表/趋势等精细化展示缺 |
| 协议扩展（UDP 验证/WSS/QUIC） | 枚举存在，每个需独立立项验证（PLAN §5 阶段 5） |

## 5. 总结判断

「TuneX 比原版粗糙」这个说法**只对一半**：

- **数据面**：两边对等（都是裸 TCP/UDP + mux 多路复用 + WS 控制通道），不存在"原版协议更强"。
- **控制面/平台层**：TuneX 已经**超过**原版——原版没有多租户、没有策略额度、没有限流审计、没有 CI。
- **真正粗糙的地方**：流量计量链路（采集→入库→聚合→展示）断裂、邮箱验证缺失、E2E 验证深度不足、Worker 大部分 cron 空壳。

按 PLAN.md 的 0.1 Beta 定义（多租户隔离 + 私网无入站 TCP + 越权矩阵全绿 + 支付关闭），当前阻塞点收敛为：**SOFT-01 收尾（config-generator 接线）→ 流量入库 → workspace 前端 → 双租户 E2E**。
