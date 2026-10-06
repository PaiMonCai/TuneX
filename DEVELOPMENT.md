# TuneX 开发入口

> 本文件只描述**当前怎么开发 TuneX**。V3/V4/V5/WP 的路线、交付记录、Gate 结果和旧契约已经归档到 [docs/history/](docs/history/)；它们用于解释历史兼容性，不再充当当前路线图。

## 当前目标

TuneX 当前阶段是 **V1 / Production Beta 产品化与维护性收口**。默认原则是：

1. 从最新 `main` 开始；
2. 先确认现有能力与唯一真相源，禁止创建第二套路由、状态机、计费口径或运行态；
3. 优先做小批、可回滚、可由现有测试证明的改动；
4. 未开放能力继续 fail-closed；
5. Schema migration 一旦进入 `main` 就视为历史事实，不重命名、不重写；
6. 运行语义重构必须先保持行为等价，再单独讨论产品语义变化。

## 当前文档真相

- [docs/architecture.md](docs/architecture.md)：产品模型、运行时真相链、服务边界；
- [docs/engineering.md](docs/engineering.md)：代码组织、依赖方向、提交与重构规则；
- [docs/testing.md](docs/testing.md)：本地测试、Source CI、Integration；
- [docs/release.md](docs/release.md)：候选镜像、完整验证、Release；
- [docs/production-deploy.md](docs/production-deploy.md)：生产部署与运维；
- [docs/history/README.md](docs/history/README.md)：旧 V3/V4/V5/WP 契约与证据。

## 开工前固定检查

- 找到用户可见对象与内部对象的边界；
- 搜索同名/同义服务，确认不会产生双实现；
- 明确修改属于 Web、Backend、Agent、Ops、Integration 哪个 surface；
- 找到对应行为测试，优先扩展现有测试而不是写源码字符串扫描；
- 涉及持久化时确认 migration、回滚与旧数据升级路径；
- 涉及 runtime/lease/port/federation 时默认按 fail-closed 设计。

## 代码组织方向

长期按 domain 而不是历史 WP 划分。新代码不要再使用 `v4-`、`v5-`、`wp*` 作为产品模块名。
历史测试和 migration 可保留原名；当前代码与当前文档应使用产品领域命名。

## 合并纪律

- PR 必须说明“当前事实 → 缺口 → 改动 → 验证”；
- 结构重构与语义变化尽量分开；
- CI 绿色不代表运行时安全，涉及真实拓扑的变化必须看 Integration；
- `main` 是唯一基线，不在长期 feature branch 上继续堆叠下一轮工作。

历史完整开发手册快照保存在 [docs/history/development-v4-v5.md](docs/history/development-v4-v5.md)。
