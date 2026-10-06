# TuneX 工程规范

## 1. 唯一真相

每个领域只能有一个 authoritative implementation。新增能力前先搜索现有服务、路由、类型与测试；如果已有实现，扩展它而不是复制一份。

## 2. 依赖方向

- Web 只投影后端事实，不复制授权、健康、生命周期、failover 或计费规则；
- Route 负责 HTTP 适配，复杂业务进入 service；
- Service 可以拆成 contract / policy / persistence / executor，但不要形成互相循环的第二套状态机；
- Agent 执行 runtime contract，不拥有产品授权真相；
- Integration 验证跨进程行为，不替代 unit/contract test。

## 3. 重构规则

结构重构优先保持行为等价：

1. 先建立/确认行为测试；
2. 提取纯类型、纯函数或明确子模块；
3. 保持旧 public surface 的兼容 re-export；
4. 测试通过后再删除旧内部路径；
5. 产品语义变化另开提交。

不要用源码字符串、注释文本、JSX 形状或目录枚举作为主要行为 Gate；优先测试导出 contract 或真实请求行为。

## 4. 数据库

- 已合入 `main` 的 migration 不重命名、不重写；
- 新 migration 只向前演进；
- 删除实体时先确认不可变 ledger / audit / billing 数据不被级联误删；
- 旧数据升级验证属于 landed-main / release qualification 证据。

## 5. Fail-closed

以下领域默认 fail-closed：授权、License、资源所有权、port/placement/federation lease、teardown、跨 Panel 副作用、计费归属和 migration。

## 6. 文件边界

当一个文件同时承担 contract、validation、persistence、execution、reconcile 等多种职责时，优先按领域职责拆文件，不按历史 WP 拆文件。测试与实现应采用相同领域边界。

## 7. 命名

新代码与当前文档使用产品领域名，不再新增 `v3/v4/v5/wp/gate` 产品命名。历史 migration、历史测试、兼容 Gate 可保留原名以维持追溯性。
