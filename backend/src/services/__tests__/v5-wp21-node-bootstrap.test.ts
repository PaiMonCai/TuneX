/**
 * V5-WP21（Lead 裁决）—— 节点引导脚本**钉住 Docker 版本**，不回落到安装最新。
 *
 * 为什么用源码级断言而不是"渲染出来再断言"：渲染函数所在的模块在 import 期要读一整套
 * 环境密钥（`env.ts` 的 `requireSecret`），为一个"脚本里写了什么"的断言搭一套 env 是把
 * 测试的复杂度挪到了断言之外。而这里要钉的恰恰是**文本本身**：
 *
 *   · 版本锚点是一个**写死的常量**（不是"最新"，也不是空）；
 *   · 安装调用带上 `--version`；
 *   · 那个不带版本的裸调用**必须消失**（它就是"今天 27、明天 28"的来源）；
 *   · 失败**不静默**：脚本要明确报错并非零退出，而不是"装不上就算了"。
 *
 * 另外钉住一条容易踩的坑：这段脚本是 **TS 模板字符串**，所以
 * ① shell 变量的 `${...}` 会被 TS 当插值（要用 `$VAR`）；
 * ② 注释里出现反引号会**提前终止模板**（本文件第一次改动就是这么坏的）。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "node-enrollment.ts"), "utf8");

describe("V5-WP21: 节点引导脚本钉住 Docker 版本", () => {
  test("版本锚点是一个具体的三段版本号（不是 latest、不是空）", () => {
    const match = SRC.match(/export const NODE_BOOTSTRAP_DOCKER_VERSION = "([^"]+)"/);
    expect(match, "找不到版本锚点常量").not.toBeNull();
    expect(match![1]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("安装调用带 --version，且不再有「装最新」的裸调用", () => {
    expect(SRC).toContain('sh "$TMP_DOCKER" --version "$DOCKER_PIN"');
    // 裸调用（不带版本）是版本漂移的来源：它必须不存在。
    expect(SRC).not.toContain('sh "$TMP_DOCKER"\n');
    expect(SRC).toContain('curl -fsSL https://get.docker.com -o "$TMP_DOCKER"');
  });

  test("失败必须可见：显式报错 + 非零退出，并明确「不回落」", () => {
    expect(SRC).toContain("本脚本**不**回落到安装最新版");
    const failed = SRC.slice(SRC.indexOf("if ! sh \"$TMP_DOCKER\""));
    expect(failed.slice(0, 400)).toContain("exit 4");
  });

  test("shell 变量用 `$VAR` 写法（`${...}` 会被 TS 模板插值掉）", () => {
    // 只有那个**故意**插值 TS 常量的位置允许出现 `${`。
    const shellInterpolations = [...SRC.matchAll(/\$\{(?!NODE_BOOTSTRAP_DOCKER_VERSION)[A-Z_]+/g)].map((m) => m[0]);
    expect(shellInterpolations).toEqual([]);
  });
});
