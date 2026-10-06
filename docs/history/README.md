# 历史开发与兼容资料

本目录保存 V3/V4/V5/WP 时期的设计、交付、Gate 与发布记录。它们用于：

- 解释为什么某些兼容约束存在；
- 追溯 migration / protocol / runtime 决策；
- 为仍在执行的 compatibility Gate 提供背景。

它们**不是当前路线图或当前架构真相**。当前开发请从仓库根 [DEVELOPMENT.md](../../DEVELOPMENT.md) 开始。

## 历史主文档

- `development-v4-v5.md`：原 3686 行开发执行手册快照；
- `tunex-devmap-v3.md`：V3 架构与迁移背景；
- `release-notes-v4.md` / `release-record-v4.5.md`：V4/V4.5 发布记录。

## 历史契约

目录中 `v5-*.md` 文件是能力扩展阶段的冻结契约或 draft。当前实现可能已经超过当时的交付点；判断现状时以当前代码、migration、[architecture.md](../architecture.md) 与 CI/Integration 为准。

## Evidence

`../evidence/` 保存历史 Gate 结果快照。当前 workflow 仍执行的 Gate 以 `.github/workflows/` 和 `scripts/v3-e2e/` 为准。
