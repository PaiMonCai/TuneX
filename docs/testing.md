# TuneX 测试与验证

## 本地快速验证

Backend：

```bash
cd backend
bun ci
bunx prisma generate
bunx tsc --noEmit
bun run test:unit
```

需要 MySQL / Redis 的 HTTP 与数据库集成：

```bash
cd backend
TUNEX_DB_TEST=1 bun run test:integration
```

Web：

```bash
cd web
npm ci
npm run typecheck
bun test src
npm run build
```

Agent：

```bash
cd agent
go vet ./...
go test ./...
go build -buildvcs=false ./...
```

## Source CI

PR 根据变更 surface 运行 Backend、Web、Agent、Ops 与 secret scan。当前测试树直接按 source root 执行，不维护手写测试目录白名单。

## PR Integration

涉及 runtime / protocol / Agent / Backend 等真实拓扑 surface 时运行快速 PR topology，用真实进程和 Agent 验证关键协议回归。

## Landed-main qualification

`main` 除 Source CI 外还负责：

- 历史数据库升级回放；
- 必要 race / compatibility 验证；
- 构建 Unified / Agent 候选镜像；
- 按不可变 digest 运行完整 Integration；
- 生成 Release 所需资格证据。

## Integration 入口

当前自动化拓扑验证统一从 `scripts/integration/` 进入。该目录是唯一受支持的 Integration 脚本入口；workflow、文档与人工排障都不依赖阶段编号或旧里程碑脚本名。
