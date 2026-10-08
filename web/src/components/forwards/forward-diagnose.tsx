"use client";

/**
 * V4-WP11C：Forward 诊断面板。
 *
 * 三条来自后端的语义必须**原样**出现在界面上，不能在渲染时被抹平：
 *
 *  1. `method === "node_facts"`（`verified: false`）的那一段**没有做过连通性验证**。
 *     它对 RELAY 转发的"入口↔出口"一段永远成立——因为那段的目标是出口节点的业务
 *     监听端口，探测它会真的产生一条业务连接。界面必须把它画成"未验证"，否则用户
 *     会把"两端事实一致"读成"链路已确认可达"。
 *  2. 结论只有"可达 / 拒绝 / 超时 / DNS 失败 / 结论不足"这些**互斥**状态，
 *     不能让一个绿色的"正常"覆盖掉部分失败。
 *  3. `next_step` 是后端给的**可执行下一步**，必须真的展示出来——用户点诊断是为了
 *     知道"我该做什么"，不是为了看状态码。
 */

import { useState } from "react";
import { api } from "@/lib/api";
import type { DiagnoseProbeResult, DiagnoseReport, DiagnoseSegment, ID } from "@/lib/types";
import { forwardTransportFor } from "@/lib/forward-protocol";
import { useI18nOptional } from "@/components/providers";

const SEGMENT_LABEL: Record<DiagnoseSegment["segment"], string> = {
  ingress_to_target: "入口节点 → 目标",
  ingress_to_egress: "入口节点 ←→ 出口节点",
  egress_to_target: "出口节点 → 目标池",
};

const OUTCOME_TEXT: Record<DiagnoseSegment["outcome"], string> = {
  ok: "通过",
  unreachable: "不通",
  unsupported: "节点版本不支持",
  failed: "诊断失败",
  unknown: "结论不足",
};

/** 结果行的用户文案：状态码是机器可判定的，但用户需要一句人话。 */
export function probeStatusText(status: DiagnoseProbeResult["status"]): string {
  switch (status) {
    case "reachable":
      return "TCP 可达";
    case "refused":
      return "端口拒绝连接";
    case "timeout":
      return "无响应（超时）";
    case "dns_error":
      return "域名无法解析";
    case "invalid_target":
      return "目标地址不合法";
    case "unsupported":
      return "节点不支持该探测";
    default:
      return "未知错误";
  }
}

/** 段结论 + 验证状态 → 界面色调。未验证的"通过"不能渲染成绿色确定态。 */
export function segmentTone(segment: DiagnoseSegment): "ok" | "unverified" | "bad" | "warn" {
  if (segment.outcome === "ok") return segment.verified ? "ok" : "unverified";
  if (segment.outcome === "unreachable" || segment.outcome === "failed") return "bad";
  return "warn";
}

export type ForwardDiagnoseProps = {
  forwardId: ID;
  protocol?: string;
  /** 便于测试注入；生产用 api.forwards.diagnose。 */
  runDiagnose?: (id: ID) => Promise<DiagnoseReport>;
};

export function ForwardDiagnose({ forwardId, protocol, runDiagnose }: ForwardDiagnoseProps) {
  const [report, setReport] = useState<DiagnoseReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const result = await (runDiagnose ?? ((id: ID) => api.forwards.diagnose(id)))(forwardId);
      setReport(result);
    } catch (e) {
      setReport(null);
      setError(e instanceof Error ? e.message : "诊断失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">转发诊断</h3>
          <p className="mt-1 text-xs text-neutral-500">
            探针目标由服务端从这条转发的期望状态推导；诊断不产生业务流量，也不会重启监听。
          </p>
        </div>
        <button
          type="button"
          onClick={start}
          disabled={busy}
          className="rounded border border-neutral-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-neutral-700"
        >
          {busy ? "诊断中…" : "开始诊断"}
        </button>
      </header>

      {error ? (
        <p role="alert" className="mt-3 text-sm text-red-600">
          {error}
        </p>
      ) : null}

      {report ? <ForwardDiagnoseReportView report={report} protocol={protocol} /> : null}
    </section>
  );
}


/**
 * 已加载的只读视图（纯展示，无取数）。
 *
 * 单独拆出来是为了可测：静态渲染不会跑 useEffect，所以"点击后"的状态必须能用
 * 一个 report 直接渲染出来，否则那些语义（未验证标记、下一步文案）就只能靠源码
 * 字符串扫描来"证明"，等于没测。
 */
export function ForwardDiagnoseReportView({ report, protocol }: { report: DiagnoseReport; protocol?: string }) {
  const mixed = forwardTransportFor(protocol ?? report.protocol) === "mixed";
  const en = useI18nOptional()?.locale === "en";
  return (
    <div className="mt-3 space-y-3">
      {mixed ? <p data-testid="forward-both-probe-scope" className="text-xs text-neutral-500">{en
        ? "TCP + UDP: a TCP probe verifies only the TCP target, not UDP mappings, datagrams or the entire mixed path. Runtime facts are not connectivity proof."
        : "TCP + UDP：TCP 探测只证明 TCP 目标可达，不验证 UDP 映射、UDP 报文或整个混合链路；节点运行态事实也不是连通性证明。"}</p> : null}
      {report.segments.map((segment) => (
        <div
          key={`${segment.segment}-${segment.node_id}`}
          className="rounded border border-neutral-200 p-3 dark:border-neutral-800"
        >
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{SEGMENT_LABEL[segment.segment]}</span>
            <span className="text-xs text-neutral-500">（{segment.node_key}）</span>
            <span data-tone={segmentTone(segment)} className="text-xs">
              {mixed && segment.method === "tcp_probe" && segment.outcome === "ok" ? (en ? "TCP probe passed (UDP unverified)" : "TCP 探测通过（UDP 未验证）") : OUTCOME_TEXT[segment.outcome]}
            </span>
            {!segment.verified ? (
              <span
                data-testid="unverified-segment"
                className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
              >
                未验证连通性
              </span>
            ) : null}
          </div>

          {segment.method === "node_facts" ? (
            <p className="mt-2 text-xs text-neutral-500">
              这一段不做 TCP 探测（探测目标指向出口节点的业务端口，会产生真实业务连接），只核对两端上报的运行态事实。
            </p>
          ) : null}

          {segment.message ? <p className="mt-2 text-xs">{segment.message}</p> : null}

          {segment.results.length > 0 ? (
            <ul className="mt-2 space-y-1 text-xs">
              {segment.results.map((r) => (
                <li key={`${r.host}:${r.port}`}>
                  <span className="font-mono">
                    {r.host}:{r.port}
                  </span>
                  {" — "}
                  {probeStatusText(r.status)}
                  <span className="text-neutral-500">
                    （{r.elapsed_ms}ms{r.resolved_ip ? `，解析到 ${r.resolved_ip}` : ""}）
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          {segment.error_code ? (
            <p className="mt-2 text-xs text-neutral-500">原因代码：{segment.error_code}</p>
          ) : null}
        </div>
      ))}

      {report.next_step ? (
        <p data-testid="diagnose-next-step" className="rounded bg-neutral-50 p-3 text-sm dark:bg-neutral-900">
          {report.next_step}
        </p>
      ) : null}
    </div>
  );
}
