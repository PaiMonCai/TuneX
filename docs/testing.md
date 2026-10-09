# 转发测试与验收

更新：2026-10-09。类型检查、fixtures、单进程 echo、真实多节点、浏览器和生产验证分别记录，不能互相替代。

## 已确认的候选证据

以下表格对应 F1 源码 `4e50f20b8c3b16af512bcae942d42f3c08b1e578` 的 [CI 37658464950](https://github.com/PaiMonCai/TuneX/actions/runs/37658464950)，该次 required 全绿。F2 候选 `932d15e` 的 [CI 37697539412](https://github.com/PaiMonCai/TuneX/actions/runs/37697539412) 同样全绿：3186 后端单元/契约、118 数据库/HTTP（零跳过）、1466 前端、四节点 61 PASS / 0 FAIL。F3 及后续提交查看 [PR 75 的候选检查](https://github.com/PaiMonCai/TuneX/pull/75/checks)；本文不是持续同步的 CI 状态页。

| 范围 | 结果与边界 |
| --- | --- |
| Backend | 3179 pass / 0 fail；空库迁移、Prisma 生成与类型检查通过。 |
| MySQL/HTTP | 113 pass / 0 fail / 0 skipped；包含并发新 producer 事务和旧快照交错，逐轮校验精确账本。 |
| Linux Agent 与 FXP | 全量测试、vet 和构建通过，使用真实 FXP 程序；PR 不据此宣称已执行仅 main push 才运行的 race 步骤。 |
| Web | 1441 pass / 0 fail；类型检查/构建通过。该构建使用 mock API，不证明生产 API 或真实浏览器完成。 |
| Linux 核心集成 | Panel/Worker/MySQL/Redis/四 Agent，41 PASS / 0 FAIL；含真实统计段切换和回收，保持 B TCP 与原 UDP 目标 socket。artifact：abcd-core-result。 |
| Ops / secrets | 对应门禁通过。 |

Link 页面曾通过隔离浏览器 fixtures 验证；新流量 UI 有 parser/组件回归，但尚无该切片的真实后端浏览器全流程证据。细节见 [组件验证记录](../web/src/components/links/__tests__/EVIDENCE.md)。上述绿色 CI 没有自动开启 FXP 默认开关或公开支持矩阵。

F1 本地已验证 500 规则/30 模拟日、统计准备各崩溃点、缺失/降级拒绝、并发计数与迟到 ACK。真实 FXP 回归连续切换五个统计段，保持原 TCP 会话和 UDP 目标 socket，精确确认后释放旧段。此为本地程序证据，真实 Linux 四节点候选门禁与实际跨日/长期运行分别记录，不能用模拟日期代替真实跨日证据。

F1 统计状态另在隔离 Chrome HTTP fixtures 上验证：积压/受阻/未知状态可见，支持详情可展开，未知不显示虚构零值，新鲜 ACK 仍保留失败运行状态；375px 移动视口没有横向溢出、控制台无错误。这里使用生产组件，但不是实际 Panel/Agent 的浏览器验收。

## 自动检查

以下命令从仓库根开始，在独立开发/CI 环境执行。后端完整测试需要测试 MySQL/Redis 和环境配置；DB 用量测试必须使用专用测试库，不指向生产。

```bash
cd backend
bun ci
bunx prisma generate
bun run typecheck
bun run test:unit
bun run test:integration
```

数据库集成按 [CI 配置](../.github/workflows/ci.yml) 准备迁移，设置 `TUNEX_DB_TEST=1`、独立的 `TUNEX_LINK_TRAFFIC_TEST_DATABASE_URL` 及 `TUNEX_LINK_TARGET_SETS_TEST_DATABASE_URL`；后者限定 loopback `*_link_target_sets_test` 库，覆盖完整快照、基线、CAS 和事务回滚。确认测试实际执行且没有 skipped；只看退出码不能代替这个检查。

```bash
cd web
bun ci
bunx next typegen
bun run typecheck
bun test src
NEXT_PUBLIC_API_MOCK=1 NEXT_PUBLIC_PAYMENTS_ENABLED=false bun run build
```

这是 CI 风格的隔离构建；公开部署使用真实 API 构建，不能把 mock 镜像直接作为真实验证证据。

Linux Agent/FXP 回归，从仓库根执行：

```bash
go -C third_party/forwardx/forwardx-fxp mod verify
go -C third_party/forwardx/forwardx-fxp test ./...
go -C third_party/forwardx/forwardx-fxp build -trimpath -o /tmp/tunex-fxp .
cd agent
GOARCH=amd64 TUNEX_TEST_FXP_BINARY=/tmp/tunex-fxp go test ./...
GOARCH=amd64 go vet ./...
GOARCH=amd64 go build ./...
```

Windows 本地测试按平台差异记录，交叉编译不等于 Linux 实际运行通过。race 与历史数据库升级回放按 CI 条件执行，不扩大已完成的证据范围。

## 真实 Linux 多 Agent 验收

需要 Linux、Docker/Compose v2、Python 3、OpenSSL。脚本使用 `scripts/integration/docker-compose.yaml` 的独立测试拓扑、测试密钥及库；先确认该拓扑没有要保留的数据。setup 会重建测试网络，A00 默认清理旧测试栈，不能对现有部署换文件运行。

共享 FXP gate：

```bash
bash scripts/integration/abcd-core-gate.sh
```

脚本启用 FXP、构建候选 backend/Agent、创建四节点测试拓扑，执行真实载体、TCP/UDP/both、限制、共享更新、授权、恢复、删除和运行事实检查。结果写入 `scripts/integration/evidence/abcd-links-result.txt`；脱敏诊断与对应镜像/SHA 一起保存。

F3 精确候选 `47594c4` 的 [CI 37724092872](https://github.com/PaiMonCai/TuneX/actions/runs/37724092872)：四节点共享 gate 73 PASS / 0 FAIL、backend 3197 通过、数据库/HTTP 119 通过且零跳过、web 1482 通过，required 成功。主分支专用 race/历史生产升级回放未在该候选运行，真实 Panel 浏览器验收仍单独要求。

F4 同一入口额外 opt-in `FORWARD_NATIVE_BOTH_ENABLED=true` 并运行 `native-both.py`，结果单独保存 `native-both-result.txt`。使用实际 API/Worker/Agent 验证 plain DIRECT/单跳 RELAY 同号两协议、共享并发、两协议目标同步更新、UDP 真实 OS 占用导致的半绑定失败、正常重试、暂停/恢复、重启和删除后精确复用。失败不跳过、不注入 Ready，也不手工删租约。F4 必须看对应候选 SHA 的 gate；F3 的绿色不覆盖这些新增场景。

端口单测须使用实际报告组合：规范 `tunnels` 加 `used_ports` 的 TCP/UDP 数字汇总，覆盖 DIRECT、RELAY、EGRESS 的同号重建；不能只注入空 Agent 占用数组来证明幂等重用。异步 TCP 关闭须等待真实计数归零，再断言活跃 UDP 映射不计入 TCP；不以固定 sleep 或跳过测试掩盖生命周期差异。实网失败工件仅保留 HTTP/应用符号码和固定错误分类，不记录原始配置、凭证或完整错误响应。

F4 更新回归另覆盖显式未知协议汇总的 both→TCP/UDP 拒绝、目标变化与入口重建叠加时的出口准备顺序，以及实际出口 ACK 地址进入入口 next-hop。`mixed_target_rebuild_test.go` 用真实 TCP/UDP socket 验证活跃 UDP 映射与 TCP 客户端关闭叠加的完整重建：4 个 bind host × Apply/ReplaceListener × ownership guard × 等待/不等待 TCP 退场，共 32 场景；Windows amd64 五轮通过是本地程序证据，不替代 Linux 四节点门禁。后端执行器的本地离线验证隔离默认 MySQL/Redis IO，不作为数据库验收。

服务层目标更新回归覆盖 DIRECT/RELAY × TCP/UDP/both × IPv4 wildcard/IPv6 wildcard/具体监听 IP 的 18 组合，确保修订快照与投影不把 `connect_ip` 当 `listen_ip`。DIRECT/RELAY 补偿夹具执行 `incoming <= removedRevision` 拒绝规则，验证恢复高于删除栅栏；实网以 foreign UDP 占用候选端口，实际 PATCH 移动已有 both 监听并失败，验证更高修订恢复原端口的两协议且候选端口无半监听。

运行操作推进 applied 修订后，旧 snapshot 指针不能代替当前基线：编辑前冻结实际已 ACK 的一代，DIRECT/RELAY × TCP/UDP/both 离线回归覆盖此缺口。`agent/internal/control/native_both_retarget_test.go` 通过真实带标签的 TCP/UDP 目标与完整命令路径验证出口 PREPARE、幂等重发及入口切换，保留活跃 UDP 客户端验证新目标，不仅检查收到 echo。`python -B -m unittest discover -s scripts/integration/tests -p 'test_*.py'` 检查 Docker helper 契约和错误脱敏，不替代实网验收。实网失败额外记录旧/新目标命中、修订和恢复条件的脱敏事实；故障创建返回的 502 不能当作成功 apply。

`52eeab2` 的 Linux 门禁为 F4 **30 PASS / 2 FAIL**，证实恢复已修好，但 RELAY 目标更新只有 TCP 到新目标、UDP 无回复，half-bind 的首次 retry 被拒。原生 apply 现在复用 Link 的串行完整报告发布机制，在 ACK 前发送实际 hop/socket 事实，避免下一次更新回退到另一张网的 `connect_ip`；报告失败仍不伪造 runtime 失败。另以 Agent 的 `incoming <= removedRevision` 规则验证 DIRECT/RELAY 清理失败世代，不再提前封住下一次正常 retry。完整门禁仍须看更新候选，不能把旧 SHA 的局部通过推广为全部通过。

F1 gate 默认设置统计段最长 30 秒，让真实计数切换跨越持续 B TCP/UDP；验证实际数据库出现新 producer、旧历史保持、原目标 socket 未变，以及精确确认后的段数与页面观测。普通 Agent 的默认最长段龄为 86400 秒；此参数是明确的运行配置，验收没有伪造流量或修改计数快照。

F2 同一 gate 新增真实目标 3044/3045：完整策略 API 往返、辅助 TCP 健康、主目标实际关闭、10 秒失败/恢复窗口、全故障、恢复后的新 TCP 与保持备用 UDP 映射、RR、random、固定 UDP 来源及 Agent 重启。每次等待继续使用 B 的原 TCP 和 UDP socket；不改数据库健康状态或伪造 Ready。窗口抖动、未知 UDP、nonce/replay 和未授权目标另由真实 runner 回归覆盖。Windows 本地不能代替该 Linux 门禁。

F3 同一 gate 增加 TCP 目标 3052/3053，真实解析 PROXY 并返回收到的来源、端口、版本和目标。验证 socket 来源、受信 v1/v2 接收并按配置发送、端口改变的 IP_HASH 稳定选择、原始来源并发、不受信头拒绝、旧客户端配置省略、UDP/both 组合拒绝、共享 B 会话和恢复完整来源策略。此 gate 不修改健康/来源事实。双栈、长/慢头、AEAD Hello 错版本/旧策略/越权目标和无来源哈希拒绝由 runner 的独立 socket/策略回归覆盖；不把源码或 fixtures 当真实 Panel 浏览器证据。

来源更新另有实际 FXP/Agent 回归，断言入口和出口 PID 不变、B 的既有 TCP 及原 UDP 目标 socket 保留。确定性撤销回归覆盖拨号完成但尚未发头的旧策略、已登记目标连接的关闭；v1 重复/尾随空格及非规范端口拒绝。私有配置原子替换回归覆盖旧 Lstat 身份与新 Open 身份交错，并继续拒绝公开权限、符号链接或未知摘要，不能通过关闭篡改检查消除热更新失败。

原生回归和删除/精确端口复用：

```bash
bash scripts/integration/a00-core-gate.sh
```

其默认 `A00_FRESH=1`，`A00_KEEP_STACK=1` 保留测试栈供检查；`A00_KEEP_STACK=0` 成功后清理。包括 current-protocol.py 和 a00-delete-reuse.py。共享 gate 不替代原生 gate，且两次 setup 不能并行操作同一测试拓扑。

加权目标与批删按需单独验收：

```bash
python3 scripts/integration/a00-weighted-round.py
FORWARD_BATCH_DELETE_ENABLED=true bash scripts/integration/setup.sh
python3 scripts/integration/a00-batch-delete.py
```

加权脚本先准备现有测试栈；批删必须显式开测试开关，API 仍需 confirm_delete=true、逐 ID 授权并调用真实删除流程。共享 Link、原生、Federation 的清理边界分别验收；通过本地批删不能直接宣称远端租约释放通过。

完成检查后由测试环境所有者运行 `bash scripts/integration/teardown.sh`；脚本会删除测试拓扑持久数据，需先留存必要脱敏证据。

## 后续工作包的验收清单

| 能力 | 必须保留的场景 |
| --- | --- |
| 共享更新 | 持续 B TCP 与固定 B UDP 映射跨 A 新建、修改、删除及 bind 失败补偿；保持实际 socket，不只看最终重连成功。 |
| 长期统计 | 500 规则/30 模拟上海日、反复绑定变更、真实跨日；断网、迟到/重复 ACK、裁剪各崩溃点、磁盘满和身份冲突。 |
| 多目标 | 主故障、全故障、恢复、抖动及未知健康；新 TCP 与固定 UDP 映射的选择/重建；未授权目标被拒绝。 |
| 来源与协议 | 真实不同来源、双栈、PROXY 信任/长度/超时；both 半失败、共享预算、同号冲突和两类端口回收。 |
| 拓扑和变更 | 每个 hop 的故障、租约失效、撤权、迟到命令、候选失败、升级/回退；明文降级被拒绝。 |
| 页面 | 真实 API 创建到删除；CAS 冲突、部分失败、空间切换、权限丢失；Ready/健康/统计时间分开。 |

证据记录候选 SHA、镜像 digest、实际版本、命令与开关、通过/失败/跳过数量及范围。生产运行验证需在实际发布后另行完成；只上传脱敏结果，不上传 `.env.integration`、凭据、私有缓存或原始含密钥日志。
