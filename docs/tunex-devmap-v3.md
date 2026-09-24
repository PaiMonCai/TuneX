> **文档定位：v3 目标架构约束（Constraint），不是执行计划。**
>
> 本文用于约束 TuneX v3 的最终产品形态、角色、模式和能力边界；实际开发顺序、迁移策略、兼容规则、状态机、控制协议与验收门槛统一以仓库根目录 `DEVELOPMENT.md` 为准。本文不记录开发进度，也不得作为第二套 roadmap 使用。

**TuneX**

Claude Code 开发地图 · v3.0（入口/出口节点架构）

Next.js · Hono · Prisma · MySQL · Redis · Go 1.22

**0. 最终架构决策**

  -------------------- ------------------------------------------------------------------------------------------
  **决策项**           **结论**

  **节点角色**         INGRESS（入口）/ EGRESS（出口）/ BOTH（兼任），由管理员在面板配置

  **隧道模式**         DIRECT（单跳：入口直接转发到目标）/ RELAY（双跳：入口→出口→目标）

  **入口节点**         可单独工作（DIRECT模式），也可配合出口节点（RELAY模式）

  **出口节点**         不能单独工作，必须由入口节点将流量转入；转发目标在节点上统一配置（EgressTarget 池）

  **出口目标池**       每个出口节点预设多个目标地址（host:port:weight），创建隧道时自动使用，支持负载均衡

  **出口目标热更新**   修改出口节点目标池后，面板通知 Agent 热更新，无需重建隧道

  **节点通信**         面板主动调节点 HTTP API；入口 Agent 直接连出口 Agent 的内部端口转发流量

  **端口分配**         入口端口：用户可见，从入口节点端口池分配；出口端口：内部通信，从出口节点端口池分配

  **流量配额重置**     套餐内配置：MONTHLY（自定义周期天数）或 CUMULATIVE（累计不重置）

  **负载均衡**         v0.3：轮询+随机；v1.1：最小连接数/最小流量/IP Hash/加权

  **部署架构**         面板服务器：Docker Compose（mysql/redis/api/dashboard）；节点服务器：Go 二进制 + systemd

  **敏感配置**         Bot Token/SMTP/JWT_SECRET 只走环境变量，不进 DB

  **内部接口**         节点上报接口建议独立端口 9191，与用户接口隔离

  **心跳超时**         只标记 OFFLINE，不自动迁移隧道

  **删除节点**         自动暂停该节点所有隧道（SUSPENDED），数据保留

  **运营模块**         工单/API Key/返佣全部搁置，架构预留

  **隧道链**           搁置，不排期
  -------------------- ------------------------------------------------------------------------------------------

**1. 系统架构**

**1.1 部署架构**

+----------------------------------------------------------------------------------+
| 面板服务器（Docker Compose） 节点服务器 A（入口） 节点服务器 B（出口）           |
|                                                                                  |
| ┌─────────────────────────────┐ ┌──────────────────┐ ┌──────────────────┐        |
|                                                                                  |
| │ dashboard (Next.js :3000) │ │ tunex-agent │ │ tunex-agent │                    |
|                                                                                  |
| │ api (Hono :3001) │◄─────────│ role: INGRESS │ │ role: EGRESS │                 |
|                                                                                  |
| │ mysql (:3306) │ 心跳/上报 │ port: 10000+ │ │ targets: │                        |
|                                                                                  |
| │ redis (:6379) │─────────►│ 监听用户连接 │ │ 192.168.1.1:80 │                   |
|                                                                                  |
| └─────────────────────────────┘ 下发指令 └────────┬─────────┘ │ 192.168.1.2:80 │ |
|                                                                                  |
| │ 流量转发 └────────┬─────────┘                                                  |
|                                                                                  |
| └──────────────────────►│                                                        |
|                                                                                  |
| ↓                                                                                |
|                                                                                  |
| 目标服务                                                                         |
+----------------------------------------------------------------------------------+

**1.2 两种隧道模式**

  -------------- -------------------------------------------------- -----------------------------------------------------------
                 **DIRECT 单跳模式**                                **RELAY 双跳模式**

  **流量路径**   用户 → 入口节点:入口端口 → remoteHost:remotePort   用户 → 入口节点:入口端口 → 出口节点:内部端口 → 目标地址池

  **目标地址**   配置在隧道上（单个地址）                           配置在出口节点上（多个地址，负载均衡）

  **需要节点**   只需入口节点                                       需要入口节点 + 出口节点

  **适用场景**   简单端口转发，隐藏面板服务器                       隐藏目标服务 IP，多目标负载均衡

  **端口分配**   只分配入口端口                                     分配入口端口 + 出口内部端口（两个）
  -------------- -------------------------------------------------- -----------------------------------------------------------

**1.3 节点角色说明**

  ----------------------- ----------------------- -------------------- --------------------
  **角色**                **INGRESS**             **EGRESS**           **BOTH**

  **能否单独建隧道**      ✅ 可以（DIRECT模式）   ❌ 不能              ✅ 可以

  **能否作为出口**        ❌ 不能                 ✅ 只能作为出口      ✅ 可以

  **需要 EgressTarget**   ❌ 不需要               ✅ 必须配置          ✅ 需要配置

  **适用场景**            暴露给用户的接入点      实际连接目标的出口   单机测试/开发环境
  ----------------------- ----------------------- -------------------- --------------------

**2. 路线图总览**

  ---------- ---------- ------------------------------------------------- -------------------- -----------------
  **阶段**   **预估**   **核心交付**                                      **验收标准**         **里程碑**

  **MVP**    3-4天      DIRECT单跳转发跑通，无登录，三端联通              curl验证流量转发     🚀 第一条隧道

  **v0.2**   2-3天      用户系统，JWT，权限隔离，忘记密码                 两账号数据互不可见   👤 真实用户可用

  **v0.3**   3-4天      RELAY双跳模式，出口节点，EgressTarget，心跳恢复   双跳流量转发验证     🔀 双跳架构完成

  **v0.4**   2-3天      UDP，节点组，轮询/随机负载均衡                    UDP转发+节点组切换   ⚡ 多协议多节点

  **v0.5**   3-4天      流量统计，节点监控，WebSocket推送，图表           图表2min内更新       📊 数据可视化

  **v0.6**   3-4天      WS/TLS，暂停恢复，日志，通知，备份，一键部署      无需SSH日常运维      ✨ 完整运维体验

  **v1.0**   4-5天      套餐权限，节点限制，流量配额，限速                超限自动暂停         🔐 权限管理完整

  **v1.1**   4-5天      QUIC，高级负载均衡4种，DNS管理                    QUIC连接测试通过     🌐 高级网络能力

  **搁置**   ---        隧道链/工单/API Key/返佣/OAuth/Passkey            架构已预留           ⏸ 待排期
  ---------- ---------- ------------------------------------------------- -------------------- -----------------

**3. 项目目录结构**

  ------------------------------- -------------------------------------------
  **路径**                        **说明**

  tunex/                          Monorepo 根目录（pnpm workspaces）

  ├── apps/dashboard/             前端 Next.js 15 + Shadcn UI

  │ ├── app/                      App Router 页面

  │ ├── components/               UI 组件

  │ └── lib/api.ts                请求封装（自动带 JWT）

  ├── apps/api/                   后端 Hono + Node.js

  │ ├── src/routes/               路由（auth/tunnel/node/stats/admin）

  │ ├── src/services/             业务服务层

  │ │ ├── portPool.ts             端口分配（Redis 锁）

  │ │ ├── nodeClient.ts           调用 Agent HTTP API

  │ │ ├── tunnelOrchestrator.ts   隧道编排（DIRECT/RELAY 两种模式下发逻辑）

  │ │ └── notify.ts               Telegram 通知

  │ ├── src/jobs/                 定时任务

  │ └── src/middleware/           auth/admin/rateLimit/audit

  ├── apps/node-agent/            Go 节点端（编译为二进制，systemd 运行）

  │ ├── api/server.go             接收面板 HTTP 指令

  │ ├── forwarder/                转发器（TCP/UDP/WS/TLS/QUIC）

  │ │ ├── interface.go            Forwarder 接口定义（MVP 就锁定）

  │ │ ├── tcp.go                  TCP 转发（MVP）

  │ │ ├── udp.go                  UDP 转发（v0.4）

  │ │ ├── ws.go                   WebSocket 转发（v0.6）

  │ │ └── tls.go                  TLS 转发（v0.6）

  │ ├── manager/                  隧道生命周期管理

  │ │ ├── tunnel.go               map\[tunnelId\]Forwarder 管理

  │ │ └── egress.go               出口目标池管理（EgressTarget 负载均衡）

  │ ├── reporter/                 心跳+流量+指标上报

  │ ├── limiter/speed.go          令牌桶限速（v1.0）

  │ └── config/config.go          从环境变量读取配置

  ├── prisma/schema.prisma        数据库 Schema（唯一数据源）

  ├── docker-compose.yml          面板服务器：mysql/redis/api/dashboard

  └── scripts/                    

  ├── deploy.sh                   CI/CD 自动部署脚本

  └── install-agent.sh            节点服务器一键安装 Agent（v0.6）
  ------------------------------- -------------------------------------------

**4. 数据库 Schema（完整定稿）**

所有变更通过 prisma migrate。MVP 只建 Node + Tunnel + EgressTarget 三张表的最小字段集。

**Node 表**

  ------------------ -------------- ---------- --------------------------------------
  **字段**           **类型**       **阶段**   **说明**

  **id**             String(cuid)   MVP        主键

  **name**           String         MVP        展示名称

  **ip**             String         MVP        节点公网 IP

  **agentPort**      Int            MVP        Agent 管理端口，默认 9090

  **token**          String         MVP        面板↔节点通信密钥，唯一

  **role**           NodeRole       MVP        INGRESS / EGRESS / BOTH，管理员配置

  **status**         NodeStatus     MVP        ONLINE / OFFLINE

  **version**        String?        v0.3       Agent 版本号，心跳时上报

  **lastSeenAt**     DateTime?      v0.3       最近心跳时间

  **portRangeMin**   Int            v0.3       可分配端口下限，默认 10000

  **portRangeMax**   Int            v0.3       可分配端口上限，默认 60000

  **nodeGroupId**    String?        v0.4       所属节点组（用于入口节点的负载均衡）
  ------------------ -------------- ---------- --------------------------------------

**EgressTarget 表（出口节点目标池）**

  -------------- -------------- ---------- --------------------------------------
  **字段**       **类型**       **阶段**   **说明**

  **id**         String(cuid)   MVP        主键

  **nodeId**     String         MVP        所属出口节点（role=EGRESS/BOTH）

  **host**       String         MVP        目标地址

  **port**       Int            MVP        目标端口

  **weight**     Int            MVP        负载均衡权重，默认1

  **order**      Int            MVP        排序，影响轮询顺序

  **remark**     String?        v0.6       备注，如「主服务器」
  -------------- -------------- ---------- --------------------------------------

**Tunnel 表**

  ------------------- -------------- ---------- --------------------------------------
  **字段**            **类型**       **阶段**   **说明**

  **id**              String(cuid)   MVP        主键

  **userId**          String?        v0.2       绑定用户（MVP 阶段为空）

  **tunnelMode**      TunnelMode     MVP        DIRECT（单跳）/ RELAY（双跳）

  **ingressNodeId**   String         MVP        入口节点 ID（必填）

  **ingressPort**     Int            MVP        用户连接的端口（系统分配）

  **egressNodeId**    String?        v0.3       出口节点 ID（RELAY 模式必填）

  **egressPort**      Int?           v0.3       入口→出口内部通信端口（系统分配）

  **remoteHost**      String?        MVP        目标地址（DIRECT 模式必填）

  **remotePort**      Int?           MVP        目标端口（DIRECT 模式必填）

  **name**            String?        v0.6       用户备注名

  **protocol**        Protocol       MVP        TCP / UDP / WS / TLS / QUIC

  **speedLimit**      Int            v1.0       速度限制 kbps，-1=不限（套餐继承）

  **status**          TunnelStatus   MVP        ACTIVE / SUSPENDED / DELETED

  **createdAt**       DateTime       MVP        
  ------------------- -------------- ---------- --------------------------------------

**NodeGroup 表（v0.4）**

  ---------------- -------------- ---------- --------------------------------------
  **字段**         **类型**       **阶段**   **说明**

  **id**           String(cuid)   v0.4       主键

  **name**         String         v0.4       组名称

  **lbStrategy**   LBStrategy     v0.4       ROUND_ROBIN / RANDOM（v1.1加4种）
  ---------------- -------------- ---------- --------------------------------------

**User 表（v0.2）**

  ------------------ -------------- ---------- --------------------------------------
  **字段**           **类型**       **阶段**   **说明**

  **id**             String(cuid)   v0.2       主键

  **email**          String         v0.2       唯一，登录用

  **passwordHash**   String         v0.2       bcrypt 加密

  **role**           Role           v0.2       USER / ADMIN

  **disabled**       Boolean        v0.2       管理员禁用，JWT 校验时拦截

  **planId**         String?        v1.0       当前套餐

  **expiredAt**      DateTime?      v1.0       套餐到期时间，null=永久

  **cycleStartAt**   DateTime?      v1.0       当前流量周期开始时间

  **trafficUsed**    BigInt         v1.0       当前周期已用流量（Redis 写回）

  **overrides**      Json?          v1.0       覆盖套餐默认值的特殊权限
  ------------------ -------------- ---------- --------------------------------------

**Plan 表（v1.0）**

  -------------------- ---------------- ---------- -----------------------------------------
  **字段**             **类型**         **阶段**   **说明**

  **id**               String(cuid)     v1.0       主键

  **name**             String           v1.0       套餐名称

  **tunnelLimit**      Int              v1.0       最大隧道数，-1=不限

  **trafficQuota**     BigInt           v1.0       流量配额 bytes，-1=不限

  **speedLimit**       Int              v1.0       速度限制 kbps，-1=不限

  **protocols**        Protocol\[\]     v1.0       允许使用的协议列表

  **allowedModes**     TunnelMode\[\]   v1.0       允许的隧道模式（DIRECT/RELAY/两者）

  **quotaType**        QuotaType        v1.0       MONTHLY（周期重置）/ CUMULATIVE（累计）

  **quotaCycleDays**   Int              v1.0       周期天数，默认30

  **duration**         Int              v1.0       有效天数，0=永久
  -------------------- ---------------- ---------- -----------------------------------------

**TrafficLog 表（v0.5）**

  -------------- -------------- ---------- --------------------------------------
  **字段**       **类型**       **阶段**   **说明**

  **id**         String(cuid)   v0.5       主键

  **tunnelId**   String         v0.5       关联隧道

  **bytes**      BigInt         v0.5       本次上报字节数

  **recordAt**   DateTime       v0.5       上报时间
  -------------- -------------- ---------- --------------------------------------

**NodeMetric 表（v0.5）**

  ----------------- -------------- ---------- --------------------------------------
  **字段**          **类型**       **阶段**   **说明**

  **id**            String(cuid)   v0.5       主键

  **nodeId**        String         v0.5       关联节点

  **connections**   Int            v0.5       当前活跃连接数

  **cpuLoad**       Float          v0.5       CPU 使用率 0\~1

  **memLoad**       Float          v0.5       内存使用率 0\~1

  **netIn**         BigInt         v0.5       入流量 bytes/s

  **netOut**        BigInt         v0.5       出流量 bytes/s

  **recordAt**      DateTime       v0.5       
  ----------------- -------------- ---------- --------------------------------------

**Enum 汇总**

  ------------------ --------------------------------------------------------------------------------------
  **Enum**           **值**

  **NodeRole**       INGRESS · EGRESS · BOTH

  **TunnelMode**     DIRECT（单跳，入口直连目标）· RELAY（双跳，入口→出口→目标池）

  **Protocol**       TCP · UDP · WS · TLS · QUIC（QUIC在v1.1实现）

  **NodeStatus**     ONLINE · OFFLINE

  **TunnelStatus**   ACTIVE · SUSPENDED · DELETED

  **Role**           USER · ADMIN

  **LBStrategy**     ROUND_ROBIN · RANDOM（v0.4） LEAST_CONN · LEAST_TRAFFIC · IP_HASH · WEIGHTED（v1.1）

  **QuotaType**      MONTHLY · CUMULATIVE
  ------------------ --------------------------------------------------------------------------------------

**5. 核心业务逻辑**

**5.1 创建隧道完整链路**

  -------- ------------ ---------------------------------------------------------------------------------
  **步**   **模式**     **操作**

  **1**    **通用**     检查用户权限（v0.2+）：登录态、套餐限制

  **2**    **通用**     从入口节点端口池分配 ingressPort（Redis NX 锁防并发）

  **3**    **RELAY**    从出口节点端口池分配 egressPort（内部通信用，Redis NX 锁）

  **4**    **通用**     写 Tunnel 记录到 MySQL（status: ACTIVE）

  **5**    **RELAY**    先通知出口节点：POST /tunnel，mode=EGRESS，下发 EgressTarget 列表和负载均衡策略

  **6**    **RELAY**    再通知入口节点：POST /tunnel，mode=RELAY，nextHop=出口节点IP:egressPort

  **6**    **DIRECT**   通知入口节点：POST /tunnel，mode=DIRECT，remoteHost:remotePort

  **7**    **通用**     释放 Redis 端口锁

  **8**    **通用**     写 AuditLog（v0.6+）

  **9**    **通用**     返回隧道信息给前端（含 ingressPort，用户连这个端口）
  -------- ------------ ---------------------------------------------------------------------------------

**5.2 Agent 行为：三种指令模式**

+-----------------------------------------------------------------------+
| // 入口节点收到 DIRECT 指令                                           |
|                                                                       |
| // → 监听 ingressPort，直接转发到 remoteHost:remotePort               |
|                                                                       |
| func (m \*Manager) CreateDirect(cfg TunnelConfig) error {             |
|                                                                       |
| f := forwarder.New(cfg) // TCP/UDP/WS/TLS                             |
|                                                                       |
| return f.Start() // 监听 ingressPort → remoteHost:remotePort          |
|                                                                       |
| }                                                                     |
|                                                                       |
| // 入口节点收到 RELAY 指令                                            |
|                                                                       |
| // → 监听 ingressPort，把流量转给出口节点的 nextHop                   |
|                                                                       |
| func (m \*Manager) CreateRelay(cfg TunnelConfig) error {              |
|                                                                       |
| // nextHop = 出口节点IP:egressPort                                    |
|                                                                       |
| f := forwarder.NewRelay(cfg.IngressPort, cfg.NextHop)                 |
|                                                                       |
| return f.Start()                                                      |
|                                                                       |
| }                                                                     |
|                                                                       |
| // 出口节点收到 EGRESS 指令                                           |
|                                                                       |
| // → 监听 egressPort，按策略从 targets 里选目标转发                   |
|                                                                       |
| func (m \*Manager) CreateEgress(cfg TunnelConfig) error {             |
|                                                                       |
| lb := NewLoadBalancer(cfg.Targets, cfg.LBStrategy)                    |
|                                                                       |
| f := forwarder.NewEgress(cfg.EgressPort, lb)                          |
|                                                                       |
| return f.Start()                                                      |
|                                                                       |
| }                                                                     |
+-----------------------------------------------------------------------+

**5.3 出口目标池热更新**

+-----------------------------------------------------------------------+
| // 管理员修改出口节点 EgressTarget 后，面板调用：                     |
|                                                                       |
| // PATCH /api/admin/nodes/:id/targets                                 |
|                                                                       |
| // → nodeClient 通知 Agent 热更新目标列表                             |
|                                                                       |
| // → Agent 收到 PATCH /node/targets                                   |
|                                                                       |
| // Agent 侧：无需重建 Forwarder，只更新 LoadBalancer                  |
|                                                                       |
| func (m \*Manager) UpdateTargets(targets \[\]Target) {                |
|                                                                       |
| m.loadBalancer.UpdateTargets(targets) // 原子替换                     |
|                                                                       |
| // 所有使用该 lb 的 Forwarder 自动生效                                |
|                                                                       |
| }                                                                     |
+-----------------------------------------------------------------------+

**5.4 流量统计链路**

  ----------------------- ----------------------------------------------------- -----------------------
  **层**                  **操作**                                              **频率**

  **Agent Forwarder**     atomic int64 实时累计字节数                           实时（内存）

  **Agent Reporter**      POST /api/internal/traffic 上报各隧道字节             每60s

  **后端**                Redis 累加 traffic:tunnel:{id} 和 traffic:user:{id}   收到即写

  **后端 trafficFlush**   Redis → MySQL TrafficLog 持久化                       每5min

  **后端 trafficFlush**   检查 trafficUsed \>= quota → 超限暂停                 写回时触发

  **前端实时**            读 Redis（延迟≤60s）                                  查询即得

  **前端历史**            查 MySQL TrafficLog 聚合                              查询即得
  ----------------------- ----------------------------------------------------- -----------------------

**5.5 节点故障处理**

  --------------------- -------------------------------------------------------------------------
  **场景**              **处理**

  **入口节点掉线**      标记 OFFLINE，通知管理员；该节点 ACTIVE 隧道的用户连接中断

  **出口节点掉线**      标记 OFFLINE，通知管理员；依赖该出口的 RELAY 隧道流量中断

  **节点重启**          启动时拉取 ACTIVE 隧道列表；RELAY 模式的出口节点需同时拉取 EgressTarget

  **心跳超时处理**      只改状态，不自动迁移隧道，避免双节点并发转发

  **删除节点**          自动暂停该节点所有 ACTIVE 隧道（SUSPENDED），数据保留

  **出口节点被删**      其上的 RELAY 隧道全部变 SUSPENDED，前端提示用户重新选择出口节点
  --------------------- -------------------------------------------------------------------------

**6. API 接口清单**

**认证（v0.2）**

  ------------ --------------------------- --------------------------- ------------------
  **Method**   **Path**                    **说明**                    **版本/调用方**

  **POST**     /api/auth/register          注册（邮箱+密码）           v0.2 / 前端

  **POST**     /api/auth/login             登录，返回 JWT              v0.2 / 前端

  **POST**     /api/auth/refresh           刷新 Token                  v0.2 / 前端

  **PATCH**    /api/auth/password          修改密码                    v0.2 / 前端

  **POST**     /api/auth/forgot-password   发送重置密码邮件            v0.2 / 前端

  **POST**     /api/auth/reset-password    用邮件 token 重置密码       v0.2 / 前端
  ------------ --------------------------- --------------------------- ------------------

**隧道**

  ------------ -------------------------- ------------------------------------ ------------------
  **Method**   **Path**                   **说明**                             **版本/调用方**

  **GET**      /api/tunnels               我的隧道列表                         MVP / 前端

  **POST**     /api/tunnels               创建隧道（DIRECT/RELAY，编排下发）   MVP / 前端

  **DELETE**   /api/tunnels/:id           删除隧道（软删除，通知两端节点）     MVP / 前端

  **PATCH**    /api/tunnels/:id/suspend   暂停隧道（通知两端节点）             v0.6 / 前端

  **PATCH**    /api/tunnels/:id/resume    恢复隧道                             v0.6 / 前端

  **PATCH**    /api/tunnels/:id/name      修改备注名                           v0.6 / 前端
  ------------ -------------------------- ------------------------------------ ------------------

**节点管理（管理员）**

  ------------ ----------------------------------- ----------------------------- ------------------
  **Method**   **Path**                            **说明**                      **版本/调用方**

  **GET**      /api/nodes                          节点列表+在线状态+角色        MVP / 前端

  **POST**     /api/admin/nodes                    添加节点（配置角色）          MVP / 前端

  **PATCH**    /api/admin/nodes/:id                修改节点信息/角色             v0.3 / 前端

  **DELETE**   /api/admin/nodes/:id                删除节点（自动暂停其隧道）    v0.3 / 前端

  **GET**      /api/admin/nodes/:id/targets        获取出口节点目标池            v0.3 / 前端

  **POST**     /api/admin/nodes/:id/targets        添加出口目标                  v0.3 / 前端

  **PATCH**    /api/admin/nodes/:id/targets/:tid   修改出口目标（weight/host）   v0.3 / 前端

  **DELETE**   /api/admin/nodes/:id/targets/:tid   删除出口目标（热更新Agent）   v0.3 / 前端
  ------------ ----------------------------------- ----------------------------- ------------------

**节点组（v0.4）**

  ------------ ---------------------------- --------------------------- ------------------
  **Method**   **Path**                     **说明**                    **版本/调用方**

  **GET**      /api/node-groups             节点组列表                  v0.4 / 前端

  **POST**     /api/admin/node-groups       创建节点组                  v0.4 / 前端

  **PATCH**    /api/admin/node-groups/:id   修改名称/负载均衡策略       v0.4 / 前端

  **DELETE**   /api/admin/node-groups/:id   删除节点组                  v0.4 / 前端
  ------------ ---------------------------- --------------------------- ------------------

**统计（v0.5）**

  ------------ ------------------------ ------------------------------------ ------------------
  **Method**   **Path**                 **说明**                             **版本/调用方**

  **GET**      /api/stats/overview      全局概览（总流量/活跃隧道/节点数）   v0.5 / 前端

  **GET**      /api/stats/tunnels/:id   单条隧道流量历史                     v0.5 / 前端

  **GET**      /api/stats/nodes/:id     节点指标历史（CPU/内存/连接数）      v0.5 / 前端

  **GET**      /api/stats/user          我的用量（已用/配额/周期剩余）       v0.5 / 前端
  ------------ ------------------------ ------------------------------------ ------------------

**套餐权限（v1.0，管理员）**

  ------------ ------------------------------ --------------------------- ------------------
  **Method**   **Path**                       **说明**                    **版本/调用方**

  **GET**      /api/admin/plans               套餐列表                    v1.0 / 前端

  **POST**     /api/admin/plans               创建套餐                    v1.0 / 前端

  **PATCH**    /api/admin/plans/:id           修改套餐（批量更新限速）    v1.0 / 前端

  **DELETE**   /api/admin/plans/:id           删除套餐                    v1.0 / 前端

  **PATCH**    /api/admin/users/:id/plan      给用户分配套餐              v1.0 / 前端

  **PATCH**    /api/admin/users/:id/disable   禁用/启用账号               v0.2 / 前端
  ------------ ------------------------------ --------------------------- ------------------

**面板 → Agent（Agent 暴露，面板调用）**

  ------------ -------------------- ------------------------------------------ ----------------------
  **Method**   **Path**             **说明**                                   **版本/调用方**

  **POST**     /tunnel              创建隧道（含 mode: DIRECT/RELAY/EGRESS）   MVP / NodeClient

  **DELETE**   /tunnel/:id          删除隧道（两端都要调）                     MVP / NodeClient

  **PATCH**    /tunnel/:id/config   更新隧道配置（限速等）                     v1.0 / NodeClient

  **PATCH**    /node/targets        热更新出口目标池                           v0.3 / NodeClient

  **GET**      /tunnels             查询当前所有活跃隧道（节点重启恢复用）     v0.3 / NodeClient

  **GET**      /health              心跳检测                                   v0.3 / heartbeat job
  ------------ -------------------- ------------------------------------------ ----------------------

**Agent → 面板（面板暴露，Agent 调用，建议独立端口 9191）**

  ------------ --------------------------------- ----------------------------------------- ------------------
  **Method**   **Path**                          **说明**                                  **版本/调用方**

  **POST**     /api/internal/heartbeat           上报在线状态+版本号+当前IP                v0.3 / Agent

  **POST**     /api/internal/traffic             上报各隧道字节数                          v0.5 / Agent

  **POST**     /api/internal/metrics             上报CPU/内存/连接数/网速                  v0.5 / Agent

  **GET**      /api/internal/nodes/:id/tunnels   拉取 ACTIVE 隧道列表（含 EgressTarget）   v0.3 / Agent
  ------------ --------------------------------- ----------------------------------------- ------------------

**7. Go Agent 架构**

**7.1 Forwarder 接口（MVP 锁定）**

+-----------------------------------------------------------------------+
| // forwarder/interface.go                                             |
|                                                                       |
| type TunnelConfig struct {                                            |
|                                                                       |
| ID string                                                             |
|                                                                       |
| Mode string // DIRECT \| RELAY \| EGRESS                              |
|                                                                       |
| IngressPort int // DIRECT/RELAY 模式：用户连接端口                    |
|                                                                       |
| EgressPort int // EGRESS 模式：内部监听端口                           |
|                                                                       |
| RemoteHost string // DIRECT 模式：目标地址                            |
|                                                                       |
| RemotePort int // DIRECT 模式：目标端口                               |
|                                                                       |
| NextHop string // RELAY 模式：出口节点IP:egressPort                   |
|                                                                       |
| Targets \[\]Target // EGRESS 模式：目标地址池                         |
|                                                                       |
| LBStrategy string // EGRESS 模式：负载均衡策略                        |
|                                                                       |
| Protocol string // TCP\|UDP\|WS\|TLS\|QUIC                            |
|                                                                       |
| SpeedLimit int64 // kbps，-1=不限                                     |
|                                                                       |
| }                                                                     |
|                                                                       |
| type Forwarder interface {                                            |
|                                                                       |
| Start() error // 开始监听并转发                                       |
|                                                                       |
| Stop() error // 停止并释放端口                                        |
|                                                                       |
| Stats() int64 // 已转发总字节数（atomic）                             |
|                                                                       |
| }                                                                     |
+-----------------------------------------------------------------------+

**7.2 模块职责**

  ------------------------ ----------------------- --------------------------------------------
  **模块**                 **文件**                **职责**

  **API Server**           api/server.go           接收面板指令，鉴权，路由到 Manager

  **Tunnel Manager**       manager/tunnel.go       map\[id\]Forwarder，增删查，启动时恢复

  **Egress Manager**       manager/egress.go       出口目标池管理，LoadBalancer 维护，热更新

  **TCP Forwarder**        forwarder/tcp.go        标准库 net，双向 io.Copy（MVP）

  **UDP Forwarder**        forwarder/udp.go        会话表+超时清理（v0.4）

  **WS Forwarder**         forwarder/ws.go         gorilla/websocket（v0.6）

  **TLS Forwarder**        forwarder/tls.go        crypto/tls，自签证书（v0.6）

  **QUIC Forwarder**       forwarder/quic.go       quic-go（v1.1）

  **Load Balancer**        manager/lb.go           轮询/随机（v0.4），4种高级策略（v1.1）

  **Speed Limiter**        limiter/speed.go        令牌桶，SpeedLimit=-1时跳过（v1.0）

  **Heartbeat Reporter**   reporter/heartbeat.go   每30s上报版本+状态+当前IP（v0.3）

  **Traffic Reporter**     reporter/traffic.go     每60s上报各隧道字节数（v0.5）

  **Metrics Reporter**     reporter/metrics.go     每60s上报CPU/内存/连接数（v0.5）

  **Config**               config/config.go        环境变量读取（PANEL_URL/TOKEN/PORT_RANGE）
  ------------------------ ----------------------- --------------------------------------------

**8. 部署架构**

  ---------------- ----------------------------------------------- ---------------------------------------
                   **面板服务器**                                  **节点服务器（任意数量）**

  **部署方式**     Docker Compose                                  Go 二进制 + systemd

  **包含服务**     mysql / redis / api(3001) / dashboard(3000)     tunex-agent（端口9090对外，9191上报）

  **开放端口**     3000（前端）· 3001（API）· 9191（内部上报）     9090（管理）· 10000-60000（隧道）

  **数据持久化**   Docker Volume（mysql_data / redis_data）        无状态，重启从面板恢复

  **更新方式**     git push → CI/CD → docker compose up \--build   重新编译二进制 → systemctl restart

  **配置方式**     根目录 .env 文件                                /etc/tunex-agent.env
  ---------------- ----------------------------------------------- ---------------------------------------

**docker-compose.yml 范围（面板服务器）**

只包含 mysql / redis / api / dashboard 四个服务。Go Agent 不容器化，直接跑在节点服务器宿主机上。

原因：Agent 需要直接监听宿主机大范围端口（10000-60000），容器端口映射无法支持动态大范围端口。

**Agent 环境变量**

+-----------------------------------------------------------------------+
| \# /etc/tunex-agent.env（节点服务器上手动配置）                       |
|                                                                       |
| PANEL_URL=http://面板服务器IP:3001                                    |
|                                                                       |
| AGENT_TOKEN=面板分配的节点密钥                                        |
|                                                                       |
| NODE_ID=node-01                                                       |
|                                                                       |
| AGENT_PORT=9090                                                       |
|                                                                       |
| INTERNAL_PORT=9191                                                    |
|                                                                       |
| PORT_RANGE_MIN=10000                                                  |
|                                                                       |
| PORT_RANGE_MAX=60000                                                  |
+-----------------------------------------------------------------------+

**9. 安全边界**

  ------------------------ ----------------------------------------------------------------------------------
  **安全项**               **实现方式**

  **前端→后端**            HTTPS + JWT（1天有效）+ Refresh Token（7天）

  **后端→Agent**           HTTP + Bearer Token（每节点独立Token）；内网可降级 HTTP

  **Agent→后端（上报）**   独立端口9191 + Bearer Token，与用户接口物理隔离

  **RELAY模式入口→出口**   Agent间直接 TCP 连接，无额外加密（内网部署时可接受；公网建议 v0.6 后升级为 TLS）

  **敏感配置**             Bot Token/SMTP/JWT_SECRET 只从环境变量读取，禁止进 DB

  **端口黑名单**           22/80/443/3306/5432/6379/27017/9090/9191，portPool+创建接口双重校验

  **登录限流**             5次/分钟，超限锁定15分钟，Redis 计数

  **注册开关**             Config 表 allow_register，管理员可关闭

  **管理员接口**           独立 admin 中间件，role≠ADMIN 返回 403

  **账号禁用**             JWT 鉴权时查 disabled，true → 403 + 暂停所有隧道

  **一键安装Token**        一次性安装码（10分钟有效），用完即失效

  **出口节点访问限制**     egressPort 只接受来自对应入口节点 IP 的连接（v0.3 实现）
  ------------------------ ----------------------------------------------------------------------------------

**10. 分阶段开发任务**

每阶段完成验收后再进入下一阶段。Claude Code 每次只执行当前阶段任务。

  ---------------------------------------------------- --------------------------------------------------------------- -------------------------------- ------------------
  **MVP 单跳转发（DIRECT模式）跑通，无登录** ⏱ 3-4天                                                                                                    

  **模块**                                             **任务**                                                        **文件**                         **验收**

  **环境**                                             Monorepo + pnpm workspaces + docker-compose（mysql+redis）      docker-compose.yml               容器正常运行

  **DB**                                               Prisma Schema（Node+Tunnel+EgressTarget），执行 migrate         prisma/schema.prisma             三张表存在

  **Agent**                                            定义 TunnelConfig + Forwarder interface（含 Mode 字段）         forwarder/interface.go           编译通过

  **Agent**                                            实现 TCPForwarder（DIRECT模式：监听→io.Copy→remoteHost）        forwarder/tcp.go                 nc 转发测试通过

  **Agent**                                            实现 TunnelManager（map增删查）                                 manager/tunnel.go                并发安全

  **Agent**                                            实现 HTTP API Server（POST/DELETE /tunnel，Bearer Token鉴权）   api/server.go                    curl 创建成功

  **后端**                                             Hono 项目 + Prisma client + Redis client                        apps/api/src/index.ts            服务启动无报错

  **后端**                                             portPool 端口分配（Redis NX 锁）                                services/portPool.ts             并发不重复

  **后端**                                             NodeClient（封装调 Agent HTTP API）                             services/nodeClient.ts           调通节点端

  **后端**                                             tunnelOrchestrator（DIRECT模式下发逻辑）                        services/tunnelOrchestrator.ts   Postman 测试通过

  **后端**                                             GET/POST/DELETE /api/tunnels                                    routes/tunnel.ts                 CRUD 全通

  **前端**                                             Next.js + Shadcn UI + Tailwind                                  apps/dashboard/                  页面渲染正常

  **前端**                                             隧道列表页 + 创建表单（选入口节点+填目标地址）                  app/tunnels/                     表单提交成功

  **验收**                                             前端建DIRECT隧道 → nc 验证流量转发                              ---                              流量实际转发 ✓
  ---------------------------------------------------- --------------------------------------------------------------- -------------------------------- ------------------

  --------------------------- ----------------------------------------------------- ------------------------- ----------------
  **v0.2 用户系统** ⏱ 2-3天                                                                                   

  **模块**                    **任务**                                              **文件**                  **验收**

  **DB**                      User 表 migrate，Tunnel 加 userId，User 加 disabled   schema.prisma             migrate 成功

  **后端**                    注册/登录/刷新/修改密码/忘记密码（bcrypt+JWT）        routes/auth.ts            token 正常签发

  **后端**                    JWT 鉴权中间件 + 管理员中间件                         middleware/auth.ts        401/403 正常

  **后端**                    账号禁用（PATCH /admin/users/:id/disable）            routes/admin.ts           禁用后403

  **后端**                    登录限流（5次/分钟，Redis 计数）                      middleware/rateLimit.ts   超限429

  **前端**                    登录/注册页 + Token 存储 + 请求拦截器                 app/auth/                 登录后跳首页

  **验收**                    两账号数据互不可见，禁用账号无法登录                  ---                       权限隔离 ✓
  --------------------------- ----------------------------------------------------- ------------------------- ----------------

  ------------------------------------------- ------------------------------------------------------------------------- -------------------------------- -----------------
  **v0.3 RELAY双跳模式 + 出口节点** ⏱ 3-4天                                                                                                              

  **模块**                                    **任务**                                                                  **文件**                         **验收**

  **DB**                                      Node 加 version/lastSeenAt/portRange，Tunnel 加 egressNodeId/egressPort   schema.prisma                    migrate 成功

  **Agent**                                   实现 RELAY 模式 Forwarder（监听ingressPort→转发nextHop）                  forwarder/tcp.go                 流量转发正确

  **Agent**                                   实现 EGRESS 模式 Forwarder（监听egressPort→按策略选target）               manager/egress.go                目标选择正确

  **Agent**                                   实现 EgressManager（目标池管理，轮询/随机策略）                           manager/lb.go                    策略生效

  **Agent**                                   实现热更新接口 PATCH /node/targets                                        api/server.go                    无需重启生效

  **Agent**                                   实现 heartbeat reporter（每30s，带版本号+IP）                             reporter/heartbeat.go            面板收到心跳

  **Agent**                                   启动时拉取 ACTIVE 隧道恢复（含 EGRESS 目标）                              main.go                          重启后自动恢复

  **后端**                                    tunnelOrchestrator 补全 RELAY 模式（两次下发逻辑）                        services/tunnelOrchestrator.ts   双跳测试通过

  **后端**                                    出口节点目标池 CRUD API                                                   routes/node.ts                   目标可增删改

  **后端**                                    heartbeat job（90s超时→OFFLINE+通知）                                     jobs/heartbeat.ts                掉线自动变色

  **后端**                                    删除节点时自动暂停隧道（含RELAY两端）                                     routes/admin.ts                  隧道变SUSPENDED

  **前端**                                    节点管理页（角色标签+状态灯+出口目标配置）                                app/admin/nodes/                 目标池可管理

  **前端**                                    创建隧道支持选模式（DIRECT/RELAY）+选入口+选出口                          components/CreateTunnel          两种模式可切换

  **验收**                                    RELAY模式：用户→入口→出口→目标，流量全程转发正确                          ---                              双跳架构 ✓
  ------------------------------------------- ------------------------------------------------------------------------- -------------------------------- -----------------

  ------------------------------------------ ----------------------------------------------- --------------------- ----------------
  **v0.4 UDP + 节点组 + 负载均衡** ⏱ 2-3天                                                                         

  **模块**                                   **任务**                                        **文件**              **验收**

  **DB**                                     NodeGroup 表，Node 加 nodeGroupId               schema.prisma         migrate 成功

  **Agent**                                  实现 UDPForwarder（会话表+超时清理）            forwarder/udp.go      UDP 转发通过

  **后端**                                   节点组 CRUD + 轮询/随机负载均衡（入口节点组）   routes/nodeGroup.ts   策略切换生效

  **前端**                                   节点组管理页 + 创建隧道支持选节点组             app/admin/groups/     节点组可配置

  **验收**                                   UDP 转发通过，节点组轮询分配验证                ---                   多协议多节点 ✓
  ------------------------------------------ ----------------------------------------------- --------------------- ----------------

  ------------------------------------------------------ ------------------------------------------------------ ------------------------- -----------------
  **v0.5 流量统计 + 节点监控 + WebSocket推送** ⏱ 3-4天                                                                                    

  **模块**                                               **任务**                                               **文件**                  **验收**

  **DB**                                                 TrafficLog + NodeMetric 表 migrate                     schema.prisma             migrate 成功

  **Agent**                                              Stats() atomic int64 + traffic reporter（每60s）       reporter/traffic.go       后端收到数据

  **Agent**                                              metrics reporter（CPU/内存/连接数）                    reporter/metrics.go       指标正常上报

  **后端**                                               接收上报→Redis累加→trafficFlush job（每5min→MySQL）    jobs/trafficFlush.ts      MySQL有历史记录

  **后端**                                               统计 API（overview/tunnel/node/user）                  routes/stats.ts           返回时序数据

  **后端**                                               WebSocket 推送节点状态变更                             lib/ws.ts                 前端实时收推送

  **前端**                                               Dashboard 总览卡片 + 流量折线图（recharts）            app/dashboard/            图表正常渲染

  **前端**                                               节点监控仪表盘（CPU/内存/连接数）                      app/admin/nodes/\[id\]/   指标实时刷新

  **验收**                                               发流量后图表2min内更新，节点掉线实时变色（无需刷新）   ---                       数据可视化 ✓
  ------------------------------------------------------ ------------------------------------------------------ ------------------------- -----------------

  --------------------------- ---------------------------------------------------- -------------------------- ----------------
  **v0.6 体验打磨** ⏱ 3-4天                                                                                   

  **模块**                    **任务**                                             **文件**                   **验收**

  **Agent**                   WSForwarder（gorilla/websocket）                     forwarder/ws.go            WS 转发通过

  **Agent**                   TLSForwarder（crypto/tls+自签证书）                  forwarder/tls.go           TLS 连接通过

  **Agent**                   一键安装脚本（一次性安装码，自动注册+systemd）       scripts/install-agent.sh   curl安装成功

  **后端**                    暂停/恢复隧道（通知两端节点）                        routes/tunnel.ts           暂停后流量中断

  **后端**                    连接日志（IP+时间，Redis存7天）                      services/connLog.ts        日志可查

  **后端**                    AuditLog 中间件（关键操作记录）                      middleware/audit.ts        操作有记录

  **后端**                    Telegram 通知（节点掉线/流量超限/到期）              lib/notify.ts              Bot收到消息

  **后端**                    节点延迟检测 job + mysqldump 定时备份                jobs/                      备份文件存在

  **前端**                    隧道备注名inline编辑 + 连接日志展示 + 节点延迟标签   components/                功能可用

  **验收**                    日常运维无需SSH，所有状态前端可见                    ---                        运维体验 ✓
  --------------------------- ---------------------------------------------------- -------------------------- ----------------

  --------------------------- -------------------------------------------------------------------------- ---------------------- ----------------
  **v1.0 权限管理** ⏱ 4-5天                                                                                                     

  **模块**                    **任务**                                                                   **文件**               **验收**

  **DB**                      Plan+PlanNodeGroup 表，User 加 planId/expiredAt/cycleStartAt/trafficUsed   schema.prisma          migrate 成功

  **后端**                    套餐 CRUD（allowedModes 支持限制 DIRECT/RELAY）                            routes/plan.ts         套餐可配置

  **后端**                    创建隧道时权限检查（隧道数/节点/协议/模式）                                services/quota.ts      超限返回403

  **后端**                    流量写回时超限暂停（两端节点都暂停）                                       jobs/trafficFlush.ts   超限隧道暂停

  **后端**                    quotaReset job（自定义天数周期重置）                                       jobs/quotaReset.ts     周期重置正确

  **后端**                    到期检查 job + 套餐变更批量同步限速                                        jobs/                  到期暂停生效

  **Agent**                   limiter/speed.go 令牌桶 + PATCH /tunnel/:id/config 热更新                  limiter/speed.go       限速实测生效

  **前端**                    套餐管理页 + 用户管理页 + 个人中心（用量进度条）                           app/admin/             权限可管理

  **验收**                    超限自动暂停，到期自动暂停，限速实测生效                                   ---                    权限管理 ✓
  --------------------------- -------------------------------------------------------------------------- ---------------------- ----------------

  --------------------------- ------------------------------------------------------- ------------------- ----------------
  **v1.1 高级网络** ⏱ 4-5天                                                                               

  **模块**                    **任务**                                                **文件**            **验收**

  **Agent**                   QUICForwarder（quic-go）                                forwarder/quic.go   QUIC连接通过

  **Agent**                   4种高级负载均衡策略（最小连接/最小流量/IP Hash/加权）   manager/lb.go       策略切换生效

  **后端**                    DNS管理（Cloudflare/阿里云 API，节点IP变动自动更新）    services/dns.ts     DNS自动更新

  **前端**                    DNS管理页                                               app/admin/dns/      记录可管理

  **验收**                    QUIC转发通过，节点IP变更DNS自动更新                     ---                 高级网络 ✓
  --------------------------- ------------------------------------------------------- ------------------- ----------------

**11. Claude Code 开发规范**

  -------------------- ---------------------------------------------------------------------------------
  **规则**             **说明**

  **按阶段执行**       每次只做当前阶段任务，不提前实现后续功能

  **Schema 优先**      改数据库必须先改 schema.prisma，再 migrate，禁止手写 SQL

  **接口定义先行**     新增 API 先对照第6节确认路径和版本，再写实现

  **Forwarder 接口**   所有新协议必须实现 interface.go 的 Forwarder 接口

  **Mode 字段**        TunnelConfig.Mode 必须明确传入（DIRECT/RELAY/EGRESS），Agent 根据 Mode 选择行为

  **两端下发顺序**     RELAY模式：先通知出口节点（EGRESS），再通知入口节点（RELAY），顺序不能反

  **出口目标管理**     EgressTarget 只在 Node 层面配置，Tunnel 层面不存目标地址（RELAY模式）

  **热更新原则**       修改出口目标池通过 PATCH /node/targets 热更新，无需重建隧道

  **软删除原则**       所有删除用 status=DELETED，不做物理删除

  **端口黑名单**       portPool 和创建接口双重校验，出口内部端口同样需要校验

  **环境变量**         JWT_SECRET/DB_URL/NODE_TOKEN/BOT_TOKEN 必须从 .env 读，禁止硬编码

  **内部接口**         Agent 上报接口部署在独立端口9191，不与用户接口混用

  **心跳超时**         只标记状态，不自动迁移隧道

  **测试再推进**       每完成一个模块先验收（curl/nc），再继续下一个
  -------------------- ---------------------------------------------------------------------------------

**Claude Code 标准提示词模板**

+-----------------------------------------------------------------------+
| 我在开发 TuneX 隧道转发平台                                           |
|                                                                       |
| 技术栈：Next.js 15 + Hono + Prisma + MySQL + Redis + Go 1.22          |
|                                                                       |
| 架构：INGRESS/EGRESS/BOTH 节点角色，DIRECT/RELAY 两种隧道模式         |
|                                                                       |
| 当前阶段：\[如 v0.3\]                                                 |
|                                                                       |
| 当前任务：\[如「实现 EGRESS 模式 Forwarder」\]                        |
|                                                                       |
| 相关文件：\[如 apps/node-agent/manager/egress.go\]                    |
|                                                                       |
| 验收标准：\[如「RELAY模式双跳流量转发测试通过」\]                     |
|                                                                       |
| 约束：                                                                |
|                                                                       |
| \- 只实现当前任务，不提前实现后续功能                                 |
|                                                                       |
| \- 必须实现 forwarder/interface.go 的 Forwarder 接口                  |
|                                                                       |
| \- RELAY模式下发顺序：先出口节点，再入口节点                          |
|                                                                       |
| \- EgressTarget 只在 Node 层面配置，不存在 Tunnel 上                  |
|                                                                       |
| \- 删除用软删除（status=DELETED）                                     |
|                                                                       |
| \- 敏感配置只从环境变量读取                                           |
|                                                                       |
| 先给方案，确认后再写代码                                              |
+-----------------------------------------------------------------------+

TuneX · v3.0 最终定稿 · 入口/出口节点架构 · 按阶段推进
