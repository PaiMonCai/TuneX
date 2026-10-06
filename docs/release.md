# TuneX 发布流程

TuneX 使用 **build once, qualify, promote same digest** 的发布模型。

```text
main commit
  → Source CI
  → build candidate Unified / Agent images once
  → record immutable digests
  → full Integration against those digests
  → Release promotes the same digests
```

Release 不重新构建已经验证过的源码，避免“测试的是 A，发布的是 B”。

## Merge 前

PR 必须通过适用的 Source CI；影响真实运行面的 PR 还必须通过 PR Integration。

## Merge 后

`main` 运行完整 Source CI，并执行 landed-main qualification。历史数据库升级回放与较重的兼容验证可以放在这一层，而不是拖慢所有 PR。

## Promotion

只有完整 qualification 成功的候选 digest 才能被 Release 提升。Release 过程应保持单调性：旧的成功 run 不得覆盖更新 commit 的 latest。

## 生产部署

实际部署、升级、备份、恢复与回滚步骤见 [production-deploy.md](production-deploy.md)。
