# V4-WP9 Scale & Interaction Polish — 开发报告

**Work Package**: V4-WP9（`DEVELOPMENT.md` §13.6 依赖矩阵 / §13.7 Wave 4）
**分支**: `feature/v4-wp9-scale-polish`
**Worktree**: `/opt/TuneX-v4-wp9`
**Baseline**: `origin/main` = `65529d6`（V4-WP5 已合并，CI 36284437876 green）
**并行的 WP6（Agent Telemetry & Node Health）**：本包不触碰 `NodeStateReport`、Agent
telemetry、health schema 及其路由/类型/测试；worktree 独立，文件集无交集。

---

## 1. §13.6 / §13.7 对本包的 DoD

| 来源 | 要求 | 现状（`65529d6` 实测） |
|---|---|---|
| §13.6 | server pagination / filter / sort | 部分：`GET /api/forwards` **无分页、无排序**，只支持 4 个过滤参数（mode / apply_status / ingress_node_id / egress_node_id / keyword），返回裸数组 |
| §13.6 / §13.7 | Egress filter | 后端**已支持** `egress_node_id`（`routes/forwards.ts:141-152`）；Web 列表**没有**出口筛选控件（`forward-workspace.tsx` 只做入口 select） |
| §13.6 / §13.7 | auto-port 提示 | 表单有「留空由系统自动分配」提示（`forward.autoPort`），但**创建成功后不展示最终访问地址**：`createForward()` 只 `toast.success` 再 `load()`；列表把空端口渲染成字面量 `auto` |
| §13.6 | 复制 Forward | **不存在**。行菜单只有 重试 / 暂停 / 恢复 / 编辑 / 删除（`forward-workspace.tsx:492-516`） |
| §13.6 / §13.7 | Binding usage | 解绑**后**才由后端 409 告知「仍被 N 条端口转发使用」（`routes/nodes.ts:256-266`）。列表响应里没有任何使用量信息，用户在删除前看不到影响面 |
| §13.6 | 必要批量操作 | **不存在**。列表按行操作，服务器分页后跨页逐条操作的成本会放大 |
| §13.7 Wave 4 | 普通用户文案清理 Tunnel 术语 | 用户侧 `forward.*` 仍有「新建中继隧道」（`i18n.ts:266`）。`/tunnels` 已 `redirect("/forwards")`，`common.tunnels` 仍在侧边栏以外的地方残留 |

依赖门控：本包只依赖 WP4（已合并）。与 WP6 并行、范围互斥（见头部说明）。

---

## 2. 切片与验收口径

| 切片 | 交付 | 验收（可执行） |
|---|---|---|
| S0 | 本报告 | commit |
| S1 | `GET /api/forwards` 服务端分页 + 排序；分页/排序解析集中到纯函数模块 | 纯函数单测（clamp、白名单回落、稳定 tiebreak）+ 路由契约测试；兼容端点仍返回裸数组 |
| S2 | `POST /api/forwards/batch`（retry / suspend / resume，逐条结果）+ 专属限流规则 | 纯函数（去重 / 上限 / 动作白名单）+ 路由契约；规则表顺序断言（必须在 `api-global` 之前） |
| S3 | Binding usage：`GET/POST /api/nodes/:id/bindings` 返回 `used_by_forward_count` | mock 契约测试（使用量随转发创建/删除变化；解绑仍 409） |
| S4 | Web 列表：服务端分页/排序、出口筛选、访问地址列 + auto port 语义、创建成功回执展示最终地址 | mock 契约测试（分页形状、sort、egress filter）+ 纯函数单测 |
| S5 | Web：复制 Forward（行菜单 + 详情页）+ 批量操作栏 | 纯函数单测（copy 草稿：端口留空、名称后缀）+ 源码契约断言 |

**验证策略**（遵守本仓库纪律）：本地只跑 `bun test`（纯函数 / mock 契约）与只读代码巡查；
**不跑** `npm run build`、**不跑**全项目 `tsc --noEmit`、不做镜像构建 —— 交给 GitHub
Actions CI。推送后核对远端 SHA 与分支 CI 的 exact headSha，失败闭环修复。

---

## 3. 批量操作的取舍（「必要批量操作」的逐项论证）

原则：批量能力只在**可逆**且**逐条幂等**的动作上开放；不可逆动作不提供批量入口。

| 候选 | 决策 | 理由 |
|---|---|---|
| 批量 retry（error → 重新下发） | **做** | 应用失败往往是同一节点的同一原因（节点恢复后一批转发同时 error）。retry 是 same-revision 重放（§4.1 不抬高 revision），逐条幂等，可重复点击无副作用 |
| 批量 suspend / resume | **做** | 维护窗口场景：整个入口节点的业务需要一起停/启。两者都只改 desired 状态，不删数据，可由反向动作还原 |
| 批量 delete | **不做** | ①不可逆，且每次 delete 都要走完整 rollout（两端 removeTunnel + 租约释放），批量语义下用户无法逐条确认影响面；②`DELETE /api/forwards/:id` 的失败是「部分成功」，批量删除会把「哪些没删掉」放大成难以解释的中间态；③§13.5 的权限矩阵（WP10）尚未冻结，破坏性批量 API 应在权限/资源作用域确定后再定义，否则先落地的接口会成为 WP10 的约束。替代路径：批量 suspend（可逆）→ 逐条删除 |
| 批量改端口 / 改目标 | **不做** | 同端口冲突与 listener replacement 是逐条判定（`forward-revision.ts` 的唯一端口检查以「同入口节点已占用端口」为口径），批量应用需要先做全局分配，属于新特性而非「交互补全」；§13.7 Wave 4 明确「重点不是增加新协议」 |

批量接口的形态约束：动作白名单（3 个）、`ids` 去重、**单次上限 50 条**、顺序执行（避免
同时对同一节点发起 N 个 rollout）、返回逐条结果（部分失败可见），并配专属限流规则。

---

## 4. 与其它 WP 的边界

- **不碰**：`NodeStateReport` / Agent telemetry / health schema（WP6）、`agent/`、Prisma schema
  与 migration（本包无 DB 结构变更 —— 新字段是**响应投影**，不新增列）。
- **不碰**：生产容器、镜像构建、`main` 分支合并。
- **DEVELOPMENT.md 不改**：§13.6 矩阵行与状态由合并代理在 Gate 收口时统一更新，避免与并行
  WP6 在同一段落冲突。本报告即本包的交付说明。
- 兼容面：`/api/nodes/:ingressId/forwards`（deprecated）与 E2E 脚本仍得到**裸数组**；只有
  V4 产品端点 `GET /api/forwards` 变为分页对象。
