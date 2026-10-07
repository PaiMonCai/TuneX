# 转发测试与验收

更新：2026-10-08。类型检查、fixtures、单进程 echo、真实多节点、浏览器和生产验证分别记录，不能互相替代。

## 已确认的候选证据

以下结果对应源码 `095089edd7ba2343cacc82aec2707435ad9c3876` 的 [CI 37645154719](https://github.com/PaiMonCai/TuneX/actions/runs/37645154719)，该次 required 全绿。后续提交需要查看自己的检查；本文不是持续同步的 CI 状态页。

| 范围 | 结果与边界 |
| --- | --- |
| Backend | 3169 pass / 0 fail，164 文件；空库迁移、Prisma 生成与类型检查通过。 |
| MySQL/HTTP | 111 pass / 0 fail / 0 skipped；包含 20 轮 × 10 个并发新 producer 事务，逐轮校验账本；确定性旧快照交错最终精确入账 60 字节。 |
| Linux Agent 与 FXP | 全量测试、vet 和构建通过，使用真实 FXP 程序；PR 不据此宣称已执行仅 main push 才运行的 race 步骤。 |
| Web | 1428 pass / 0 fail，76 文件；类型检查/构建通过。该构建使用 mock API，不证明生产 API 或真实浏览器完成。 |
| Linux 核心集成 | Panel/Worker/MySQL/Redis/四 Agent，35 PASS / 0 FAIL；共享规则变化时保持未变化 B 的 TCP 会话和 UDP 目标 socket。artifact：abcd-core-result。 |
| Ops / secrets | 对应门禁通过。 |

Link 页面曾通过隔离浏览器 fixtures 验证；新流量 UI 有 parser/组件回归，但尚无该切片的真实后端浏览器全流程证据。细节见 [组件验证记录](../web/src/components/links/__tests__/EVIDENCE.md)。上述绿色 CI 没有自动开启 FXP 默认开关或公开支持矩阵。

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

数据库集成按 [CI 配置](../.github/workflows/ci.yml) 准备迁移，设置 `TUNEX_DB_TEST=1` 和独立的 `TUNEX_LINK_TRAFFIC_TEST_DATABASE_URL`；确认测试实际执行且没有 skipped。只看退出码不能代替这个检查。

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
