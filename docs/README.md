# TuneX 文档

更新：2026-10-10。当前主线是把隧道转发做完整：能部署、能持续传输、能切换、能恢复，运行状态和流量必须可信。

| 文档 | 用途 |
| --- | --- |
| [后续开发方案](DEVELOPMENT_PLAN.md) | 当前差距、优先级、工作包、依赖和交付标准；后续开发的统一入口。 |
| [转发运行边界](forwarding-runtime.md) | 已有能力、资源关系、变更影响、限额与流量口径。 |
| [测试与验收](testing.md) | 自动测试、真实 Linux 多 Agent 验收、证据范围和发布要求。 |
| [生产部署](production-deploy.md) | 生产栈、反代、迁移、Agent、实验功能、备份与回退。 |

## 当前基线

| 层级 | 已确认状态 |
| --- | --- |
| 已合并基线 | [PR #75](https://github.com/PaiMonCai/TuneX/pull/75) 已合入 `main`，合并提交 `ef159eb`；[main CI 37944370097](https://github.com/PaiMonCai/TuneX/actions/runs/37944370097) required 通过。包含 F1/F2 首切片、F3 共享 TCP 来源、F4 Linux 原生 both 限定组合，不等于全部工作包或发布条件完成。 |
| 当前开发 | `feat/forward-link-maintenance`，[PR #76](https://github.com/PaiMonCai/TuneX/pull/76) 为未合并草稿。F5 只读影响预览与迁移契约源码 `cdb8470` 的 [CI 37952731562](https://github.com/PaiMonCai/TuneX/actions/runs/37952731562) required 通过；在线迁移执行器尚未交付。 |
| 发布边界 | 本轮没有生产部署、tag 或发行；`TUNEX_FXP_LINKS_ENABLED`、`FORWARD_NATIVE_BOTH_ENABLED` 仍默认关闭，公共 FXP 支持矩阵仍为 planned。 |

当前功能范围与限制统一看 [运行边界](forwarding-runtime.md)，对应源码 SHA、实网结果和未运行项统一看 [测试说明](testing.md)。文档提交不改变上述源码验收归属，不用旧 CI 为新代码背书。

下一阶段优先完成 [F5 持久迁移状态机与提交 CAS](DEVELOPMENT_PLAN.md#f5-next-slice)，再接候选出口准备、入口切换、旧路径排空/退役及故障补偿。F1 真实跨日/长期运行、数据库归档、真实 Panel 浏览器和公开发布门禁仍待完成。Windows 适配暂停；保留现有原生 Agent LKG 恢复功能，没有性能基线和明显收益时不新增缓存优化。支付及其他外围功能继续后置。

ForwardX 对标基线为项目 2.3.281、提交 `cb0ef0bb156dc114e4344c887328018491fbd638`。实际导入组件及来源说明见 [third_party/forwardx](../third_party/forwardx/README.md)。本地 `Forwardx/` 是参考源码，不是构建依赖，也不属于本次文档清理范围。

## 文档维护

`docs/` 保持一个入口与四份职责明确的正文：开发方案、运行契约、验收、部署。过时的阶段方案、重复功能对比、失败修复流水账不另设当前入口；历史过程通过 Git 历史和验收页中的固定提交/CI 链接查阅。组件旁的 README、历史测试证据以及许可证、来源和修改清单继续保留，不因日期较旧而删除。

新增能力时，同一 PR 更新运行边界、开发方案中的状态和相关验收要求。只在验收确实完成后标记交付，记录对应源码 SHA；避免另建一份长期并行的路线图。本文档目录不保存密码、部署环境文件、原始生产日志或测试夹具凭据。
