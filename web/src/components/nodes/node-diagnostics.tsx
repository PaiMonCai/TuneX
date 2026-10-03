"use client";

/**
 * V4-WP11C / WP11B：Node 级诊断、Support Bundle 与升级命令。
 *
 * 三件事拼在一个面板里，因为它们回答的是同一个运维问题："这个节点现在怎么了"。
 * 界面必须守住三条契约语义：
 *
 *  1. **离线是结论，不是错误**：后端先判活，过期上报直接返回 `offline` 且不下发命令。
 *     界面要把它渲染成"节点离线（未下发任何自检）"，而不是一个红色的失败框——
 *     红色会让人以为诊断本身坏了。
 *  2. **自述事实和面板事实要分开**：`agent_facts` 是节点进程自己的说法，
 *     `panel.reported` 是面板存的那份。两者不一致本身就是最有用的诊断信息，
 *     所以不能合并成一块，也不能互相覆盖。
 *  3. **升级脚本是给人在节点上执行的**：界面必须明确"控制面不会远程替换 Agent"，
 *     并把"不变量（身份/凭据/LKG/Forward 关系保持）"和"停机窗口"一起展示出来，
 *     否则操作者会以为点了按钮就完事。
 */

import { useState } from "react";
import { api } from "@/lib/api";
import type { ID, NodeDiagnosticsReport, NodeUpgradeCommand } from "@/lib/types";

const REACHABILITY_TEXT: Record<NodeDiagnosticsReport["reachability"], string> = {
  online: "在线",
  offline: "离线（未下发自检命令）",
  unknown: "从未上报",
};

/** 把秒数说成人话；非有限值不猜，返回 null 让调用方决定不展示。 */
export function humanUptime(seconds: number | null | undefined): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return null;
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分`;
}

/** LKG 缓存状态的三种用户可见结论：正常 / 缺失 / 无效（三者修法不同）。 */
export function cacheStateText(state: NodeDiagnosticsReport["panel"] extends never ? never : NonNullable<NodeDiagnosticsReport["agent_facts"]>["state_dir"]): string {
  if (!state.configured) return "未配置状态目录（该 Agent 不保存本地缓存）";
  if (!state.cache_present) return "没有本地缓存：面板停机重启时该节点无法恢复监听";
  if (!state.cache_valid) return "缓存存在但未通过校验：重启时可能无法恢复";
  return "缓存有效：面板停机重启时可恢复";
}

export type NodeDiagnosticsProps = {
  nodeId: ID;
  nodeKey: string;
  /** 便于测试注入（客户端组件之间可传函数；服务端组件不能传函数给客户端组件）。 */
  loadDiagnostics?: (id: ID) => Promise<NodeDiagnosticsReport>;
  loadBundle?: (id: ID) => Promise<Record<string, unknown>>;
  requestUpgrade?: (
    id: ID,
    input: { agent_image: string; allow_active?: boolean },
  ) => Promise<NodeUpgradeCommand>;
  onDownload?: (filename: string, json: string) => void;
};

export function NodeDiagnostics({
  nodeId,
  nodeKey,
  loadDiagnostics,
  loadBundle,
  requestUpgrade,
  onDownload,
}: NodeDiagnosticsProps) {
  const [report, setReport] = useState<NodeDiagnosticsReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [bundleBusy, setBundleBusy] = useState(false);
  const [bundleNote, setBundleNote] = useState<string | null>(null);

  const [image, setImage] = useState("");
  const [allowActive, setAllowActive] = useState(false);
  const [upgrade, setUpgrade] = useState<NodeUpgradeCommand | null>(null);
  const [upgradeError, setUpgradeError] = useState<string | null>(null);
  const [upgradeBusy, setUpgradeBusy] = useState(false);

  async function runDiagnostics() {
    setBusy(true);
    setError(null);
    try {
      const result = await (loadDiagnostics ?? ((id: ID) => api.nodes.diagnostics(id)))(nodeId);
      setReport(result);
    } catch (e) {
      setReport(null);
      setError(e instanceof Error ? e.message : "诊断失败");
    } finally {
      setBusy(false);
    }
  }

  async function downloadBundle() {
    setBundleBusy(true);
    setBundleNote(null);
    try {
      const data = await (loadBundle ?? ((id: ID) => api.nodes.supportBundle(id)))(nodeId);
      const json = JSON.stringify(data, null, 2);
      const name = `tunex-support-bundle-${nodeKey}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}.json`;
      if (onDownload) onDownload(name, json);
      else if (typeof window !== "undefined") {
        const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        a.click();
        URL.revokeObjectURL(url);
      }
      // The bundle is whitelisted and redacted server-side; say so, because the
      // operator is about to hand this file to someone else.
      setBundleNote("支持包已生成（服务端已按白名单采集并脱敏，不含凭据）。");
    } catch (e) {
      setBundleNote(e instanceof Error ? `支持包生成失败：${e.message}` : "支持包生成失败");
    } finally {
      setBundleBusy(false);
    }
  }

  async function buildUpgrade() {
    setUpgradeBusy(true);
    setUpgradeError(null);
    try {
      const result = await (requestUpgrade ?? ((id: ID, input: { agent_image: string; allow_active?: boolean }) =>
        api.nodes.upgradeCommand(id, input)))(nodeId, {
        agent_image: image.trim(),
        allow_active: allowActive,
      });
      setUpgrade(result);
    } catch (e) {
      setUpgrade(null);
      setUpgradeError(e instanceof Error ? e.message : "生成升级命令失败");
    } finally {
      setUpgradeBusy(false);
    }
  }

  const facts = report?.agent_facts ?? null;

  return (
    <section className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">节点诊断</h3>
          <p className="mt-1 text-xs text-neutral-500">
            事实来自两处：面板保存的状态上报，以及节点进程自己的自述。离线节点不会下发任何命令。
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={runDiagnostics}
            disabled={busy}
            className="rounded border border-neutral-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-neutral-700"
          >
            {busy ? "诊断中…" : "开始诊断"}
          </button>
          <button
            type="button"
            onClick={downloadBundle}
            disabled={bundleBusy}
            className="rounded border border-neutral-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-neutral-700"
          >
            {bundleBusy ? "生成中…" : "下载 Support Bundle"}
          </button>
        </div>
      </header>

      {error ? (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      ) : null}
      {bundleNote ? <p className="text-xs text-neutral-500">{bundleNote}</p> : null}

      {report ? (
        <div className="space-y-3">
          <p className="text-sm">
            可达性：
            <span data-testid="reachability" data-state={report.reachability} className="ml-1 font-medium">
              {REACHABILITY_TEXT[report.reachability]}
            </span>
            {report.panel.reported?.age_seconds !== null && report.panel.reported ? (
              <span className="ml-2 text-xs text-neutral-500">（最近一次上报 {report.panel.reported.age_seconds} 秒前）</span>
            ) : null}
          </p>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded border border-neutral-200 p-3 dark:border-neutral-800">
              <h4 className="text-xs font-medium text-neutral-500">面板侧事实</h4>
              <ul className="mt-2 space-y-1 text-xs">
                <li>节点标识：<span className="font-mono">{report.panel.node_id}</span></li>
                <li>生命周期：{report.panel.lifecycle ?? "—"}</li>
                <li>
                  转发：共 {report.panel.forwards.total}，活跃 {report.panel.forwards.active}，待生效{" "}
                  {report.panel.forwards.pending}，失败 {report.panel.forwards.failed}，未收敛 {report.panel.forwards.unconverged}
                </li>
                <li>上报版本：{report.panel.reported?.version ?? "—"}</li>
              </ul>
            </div>

            <div className="rounded border border-neutral-200 p-3 dark:border-neutral-800">
              <h4 className="text-xs font-medium text-neutral-500">节点自述</h4>
              {facts ? (
                <ul className="mt-2 space-y-1 text-xs">
                  <li>版本：{facts.version}（{facts.process.os}/{facts.process.arch}）</li>
                  <li>已运行：{humanUptime(facts.process.uptime_seconds) ?? "—"}</li>
                  <li>
                    运行时：{facts.runtime.tunnel_count} 条
                    {facts.runtime.truncated ? `（列表只显示前 ${facts.runtime.tunnels.length} 条）` : ""}
                  </li>
                  <li>监听端口：{facts.runtime.listen_ports.length > 0 ? facts.runtime.listen_ports.join("、") : "无"}</li>
                  <li data-testid="cache-state">{cacheStateText(facts.state_dir)}</li>
                  {facts.shutting_down ? <li>状态：正在关机/排空</li> : null}
                </ul>
              ) : (
                <p className="mt-2 text-xs text-neutral-500">
                  {report.agent_facts_error
                    ? `未取到自述事实：${report.agent_facts_error.message}`
                    : "未取到自述事实。"}
                </p>
              )}
            </div>
          </div>

          {report.next_step ? (
            <p data-testid="node-next-step" className="rounded bg-neutral-50 p-3 text-sm dark:bg-neutral-900">
              {report.next_step}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="rounded border border-neutral-200 p-3 dark:border-neutral-800">
        <h4 className="text-sm font-medium">升级 Agent</h4>
        <p className="mt-1 text-xs text-neutral-500">
          控制面不会远程替换节点上的 Agent。这里生成一段脚本，由你在节点主机上执行；节点身份、凭据、本地缓存与 Forward
          关系都会保持不变，脚本失败会自动回退到当前镜像。
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            aria-label="目标镜像"
            placeholder="ghcr.io/tunex/agent:1.4.0"
            value={image}
            onChange={(e) => setImage(e.target.value)}
            className="w-64 rounded border border-neutral-300 px-2 py-1.5 text-sm dark:border-neutral-700"
          />
          <label className="flex items-center gap-1 text-xs text-neutral-600 dark:text-neutral-400">
            <input type="checkbox" checked={allowActive} onChange={(e) => setAllowActive(e.target.checked)} />
            允许在业务运行中升级（节点未处于 maintenance）
          </label>
          <button
            type="button"
            onClick={buildUpgrade}
            disabled={upgradeBusy || image.trim() === ""}
            className="rounded border border-neutral-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-neutral-700"
          >
            {upgradeBusy ? "生成中…" : "生成升级命令"}
          </button>
        </div>

        {upgradeError ? (
          <p role="alert" className="mt-2 text-sm text-red-600">
            {upgradeError}
          </p>
        ) : null}

        {upgrade ? (
          <div className="mt-3 space-y-2">
            <p className="text-xs text-neutral-500">
              目标镜像 <span className="font-mono">{upgrade.target_image}</span> · {upgrade.downtime}
            </p>
            <ul className="text-xs text-neutral-500">
              <li>保持不变：节点身份 / 长期凭据 / 本地缓存 / Forward 关系</li>
              <li>回退方式：{upgrade.rollback_hint}</li>
            </ul>
            <pre data-testid="upgrade-script" className="max-h-64 overflow-auto rounded bg-neutral-900 p-3 text-xs text-neutral-100">
              {upgrade.script}
            </pre>
            <p className="text-xs text-neutral-500">
              请在**节点主机**上以 root 执行该脚本；脚本会先拉取镜像、再优雅排空并重建容器。
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}
