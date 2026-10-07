/**
 * I1-A —— 安装等待组件的**渲染行为**测试（不读源码字符串）。
 *
 * 用 `renderToStaticMarkup` 渲染真实 JSX，钉住用户能看见、且最容易说错的事实：
 *
 *   ① 有效期/过期来自服务端 `expires_at`，过期提示**只**给真正等待安装的节点
 *      （online / 已安装离线绝不标「失败」）；
 *   ② 闭环前不出现「已连接」与成功 CTA；闭环后 CTA 在横幅或对话框里出现一次；
 *   ③ 取数失败只提示「暂时取不到」，不冒充成功；
 *   ④ 重新生成的确认框把三件后果分开说：旧未用命令立即失效、已注册节点重装会
 *      轮换长期凭据、已装离线「重签不修网络」；
 *   ⑤ 上个节点的命令不会显示在新节点名下。
 *
 * 说明：Radix 的 Portal 在静态渲染下不产出 DOM，所以对话框正文/确认框正文用
 * 单独导出的纯展示组件（`NodeInstallDialogBody` / `NodeInstallRegenerateConfirmBody`）
 * 渲染断言——这正是它们被拆出来的原因。
 *
 * 长时异步行为（轮询/超时/晚到响应）在 `@/lib/__tests__/node-install-polling.test.ts`
 * 用受控假时钟覆盖。
 *
 * 跑法（web 目录）：bun test src/components/admin/__tests__/node-install-waiting.test.tsx
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/components/providers";
import { getDictionary } from "@/lib/i18n";
import {
  enrollmentBelongsToNode,
  installCommandExpired,
  NodeInstallDialogBody,
  NodeInstallRegenerateConfirmBody,
  NodeInstallWaiting,
} from "@/components/admin/node-install-waiting";
import { nodeLifecycleText } from "@/lib/node-lifecycle-i18n";
import type { NodeEnrollmentIssued } from "@/lib/types";

const NODE_ID = 42;
const txt = nodeLifecycleText("zh");
const en = nodeLifecycleText("en");

function enrollment(over: Partial<NodeEnrollmentIssued> = {}): NodeEnrollmentIssued {
  return {
    token: "enroll-secret-token",
    node_id: NODE_ID,
    node_key: "hk-in-01",
    agent_id: "agent-hk-in-01",
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    install_command: "curl -fsSL https://panel.example/install.sh | bash -s -- --token enroll-secret-token",
    ...over,
  };
}

const expiredEnrollment = () => enrollment({ expires_at: new Date(Date.now() - 60_000).toISOString() });

const render = (node: React.ReactNode, locale: "zh" | "en" = "zh") =>
  renderToStaticMarkup(<I18nProvider locale={locale} dict={getDictionary(locale)}>{node}</I18nProvider>);

const noop = () => undefined;

/** 取出含某个 testid 的开标签，便于断言同一元素上的 aria/disabled 等属性。 */
function tagOf(html: string, testid: string): string {
  const at = html.indexOf(`data-testid="${testid}"`);
  expect(at).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<", at), html.indexOf(">", at));
}

function body(over: Partial<Parameters<typeof NodeInstallDialogBody>[0]> = {}) {
  return render(
    <NodeInstallDialogBody
      enrollment={null}
      generating={false}
      phase="awaiting_install"
      waiting={false}
      timedOut={false}
      pollFailed={false}
      onRegenerate={noop}
      onStop={noop}
      onRetry={noop}
      onCopy={noop}
      onClose={noop}
      {...over}
    />,
  );
}

/* ------------------------------------------------------------------ */
/* 有效期 / 过期 / 取数失败                                             */
/* ------------------------------------------------------------------ */

describe("安装等待：有效期与过期只说事实", () => {
  test("过期判定是纯展示派生（只认服务端 expires_at）", () => {
    expect(installCommandExpired("2026-10-06T00:00:00.000Z", Date.parse("2026-10-06T00:00:01.000Z"))).toBe(true);
    expect(installCommandExpired("2026-10-06T00:10:00.000Z", Date.parse("2026-10-06T00:00:01.000Z"))).toBe(false);
    expect(installCommandExpired(null, Date.now())).toBe(false);
    expect(installCommandExpired("not-a-date", Date.now())).toBe(false);
  });

  test("等待安装 + 命令过期：显示命令、有效期与「已过期，请重新生成」", () => {
    const html = body({ enrollment: expiredEnrollment() });
    expect(html).toContain('data-testid="node-install-command"');
    expect(html).toContain("enroll-secret-token");
    expect(html).toContain('data-testid="node-install-expires"');
    expect(html).toContain(txt.installExpiresLabel);
    expect(html).toContain('data-testid="node-install-expired"');
    expect(html).toContain(txt.installExpiredHint);
    // 显式重签入口必须看得见
    expect(html).toContain('data-testid="node-install-regenerate"');
  });

  test("online：命令即使过期也不标失败，闭环 + 成功 CTA（对话框内）", () => {
    const html = body({
      enrollment: expiredEnrollment(),
      phase: "online",
      successAction: <button type="button">创建第一条转发</button>,
    });
    expect(html).not.toContain('data-testid="node-install-expired"');
    expect(html).toContain('data-testid="node-install-closed"');
    expect(html).toContain(txt.installPhaseHint.online);
    expect(html).toContain('data-testid="node-install-success-action-dialog"');
    expect(html).toContain("创建第一条转发");
  });

  test("已安装但离线：不显示过期失败、不冒充成功，提示指向连接问题", () => {
    const html = body({
      enrollment: expiredEnrollment(),
      phase: "installed_offline",
      waiting: false,
      successAction: <button type="button">创建第一条转发</button>,
    });
    expect(html).not.toContain('data-testid="node-install-expired"');
    expect(html).not.toContain('data-testid="node-install-closed"');
    expect(html).not.toContain("node-install-success-action");
    expect(html).toContain(txt.installPhaseHint.installed_offline);
  });

  test("等待中取数失败：显示「暂时取不到」，不显示已连接/成功", () => {
    const html = body({
      enrollment: enrollment(),
      waiting: true,
      pollFailed: true,
      successAction: <button type="button">创建第一条转发</button>,
    });
    expect(html).toContain('data-testid="node-install-waiting-state"');
    expect(html).toContain('data-testid="node-install-poll-error"');
    expect(html).toContain(txt.installPollError);
    expect(html).not.toContain('data-testid="node-install-closed"');
    expect(html).not.toContain("node-install-success-action");
  });

  test("等待中（无错误）：有停止入口、没有重试入口", () => {
    const html = body({ enrollment: enrollment(), waiting: true });
    expect(html).toContain('data-testid="node-install-waiting-state"');
    expect(html).toContain('data-testid="node-install-stop"');
    expect(html).not.toContain('data-testid="node-install-retry"');
    expect(html).not.toContain('data-testid="node-install-poll-error"');
  });

  test("超时：给出「命令仍在、可继续或重签」的说明与重试入口", () => {
    const html = body({ enrollment: enrollment(), waiting: false, timedOut: true });
    expect(html).toContain(txt.installTimeoutHint);
    expect(html).toContain('data-testid="node-install-retry"');
    expect(html).not.toContain('data-testid="node-install-closed"');
  });

  test("没有命令：不渲染命令块，复制按钮不可用", () => {
    const html = body({ enrollment: null, generating: true });
    expect(html).not.toContain('data-testid="node-install-command"');
    expect(html).not.toContain('data-testid="node-install-expires"');
    expect(html).toContain(txt.loading);
    // 取 testid 所在的开标签再判断（React 的属性顺序不保证；class 里还有
    // `disabled:pointer-events-none`，直接 includes("disabled") 会假阳性）。
    const at = html.indexOf('data-testid="node-install-copy"');
    const tag = html.slice(html.lastIndexOf("<", at), html.indexOf(">", at));
    expect(/(?:^|\s)disabled(?:=""|="true"|\s|>)/.test(tag)).toBe(true);
  });

  test("调用方没有确认框时，按钮旁就地说明「旧未用命令立即失效」", () => {
    const withNotice = body({ enrollment: enrollment(), regenerateNotice: txt.installRegenerateInvalidate });
    expect(withNotice).toContain('data-testid="node-install-regenerate-hint"');
    expect(withNotice).toContain(txt.installRegenerateInvalidate);
    // 调用方自己会弹确认框时不重复渲染同一条说明
    expect(body({ enrollment: enrollment() })).not.toContain('data-testid="node-install-regenerate-hint"');
  });

  test("英文界面用英文词条（不是中文硬编码）", () => {    const html = render(
      <NodeInstallDialogBody
        enrollment={expiredEnrollment()}
        generating={false}
        phase="awaiting_install"
        waiting={false}
        timedOut={false}
        pollFailed={false}
        onRegenerate={noop}
        onStop={noop}
        onRetry={noop}
        onCopy={noop}
        onClose={noop}
      />,
      "en",
    );
    expect(html).toContain(en.installExpiresLabel);
    expect(html).toContain(en.installExpiredHint);
    expect(html).not.toContain(txt.installExpiredHint);
  });
});

/* ------------------------------------------------------------------ */
/* 组件外壳（横幅）：阶段可见、关掉对话框也有下一步                        */
/* ------------------------------------------------------------------ */

describe("安装等待：横幅（关掉对话框仍有下文）", () => {
  test("等待安装阶段直接可见，并给出打开命令的入口", () => {
    const html = render(
      <NodeInstallWaiting
        nodeId={NODE_ID}
        view={{ connection: "waiting", has_credential: false }}
        open={false}
        onOpenChange={noop}
      />,
    );
    expect(html).toContain('data-testid="node-install-waiting"');
    expect(html).toContain(txt.installPhase.awaiting_install);
    expect(html).toContain(txt.installPhaseHint.awaiting_install);
    expect(html).toContain('data-testid="node-install-open"');
    expect(html).not.toContain('data-testid="node-install-success-action"');
  });

  test("已闭环且对话框关着：横幅上就出现成功 CTA（关掉也有下一步）", () => {
    const html = render(
      <NodeInstallWaiting
        nodeId={NODE_ID}
        view={{ connection: "online", has_credential: true }}
        open={false}
        onOpenChange={noop}
        successAction={<button type="button">创建第一条转发</button>}
      />,
    );
    expect(html).toContain(txt.installPhase.online);
    expect(html).toContain('data-testid="node-install-success-action"');
    expect(html).toContain("创建第一条转发");
    // 对话框关着时不应该同时出现对话框内的那份
    expect(html).not.toContain('data-testid="node-install-success-action-dialog"');
  });

  test("状态未知（view=null）：不宣称在线、不宣称成功", () => {
    const html = render(
      <NodeInstallWaiting
        nodeId={NODE_ID}
        view={null}
        open={false}
        onOpenChange={noop}
        successAction={<button type="button">创建第一条转发</button>}
      />,
    );
    expect(html).toContain(txt.installPhase.unknown);
    expect(html).not.toContain('data-testid="node-install-success-action"');
  });

  test("用户域视图（UserNode 形状）+ 注入数据源：不需要 admin 视图类型也能渲染", () => {
    // 只带 connection / has_credential 的用户投影，LoadView 也是用户侧的 Promise。
    type UserView = { node_id: string; connection: "waiting" | "online" | "offline" | null; has_credential: boolean | null };
    const userView: UserView = { node_id: "hk-in-01", connection: "waiting", has_credential: false };
    const html = render(
      <NodeInstallWaiting<UserView>
        nodeId={NODE_ID}
        view={userView}
        loadView={async () => userView}
        createEnrollment={async () => enrollment()}
        open={false}
        onOpenChange={noop}
      />,
    );
    expect(html).toContain(txt.installPhase.awaiting_install);
  });
});

/* ------------------------------------------------------------------ */
/* 重新生成的确认框                                                     */
/* ------------------------------------------------------------------ */

describe("重新生成命令：确认框分开说清后果", () => {
  test("旧未用命令立即失效 + 调用方安全提示 + 已有凭据会被轮换 + 已装离线不修网络", () => {
    const html = render(
      <NodeInstallRegenerateConfirmBody
        confirm="该节点已注册为入口：重装会轮换凭据，正在运行的 Agent 会断开。"
        hasCredential
        phase="installed_offline"
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    expect(html).toContain("该节点已注册为入口：重装会轮换凭据，正在运行的 Agent 会断开。");
    expect(html).toContain('data-testid="node-install-regenerate-credential"');
    expect(html).toContain(txt.installRegenerateCredential);
    // 已装离线：明确「重签不修网络」，不把重装暗示成修网手段
    expect(html).toContain('data-testid="node-install-regenerate-offline-hint"');
    expect(html).toContain(txt.installRegenerateOfflineHint);
    // 取消 / 确认两个动作都在
    expect(html).toContain('data-testid="node-install-regenerate-cancel"');
    expect(html).toContain('data-testid="node-install-regenerate-apply"');
    expect(html).toContain(txt.installRegenerateCancel);
    expect(html).toContain(txt.installRegenerateApply);
  });

  test("英文界面同样给出后果，且未装过的节点不提「凭据轮换」", () => {
    const html = render(
      <NodeInstallRegenerateConfirmBody
        confirm="Reinstalling rotates the credential."
        hasCredential={false}
        phase="awaiting_install"
        onConfirm={noop}
        onCancel={noop}
      />,
      "en",
    );
    expect(html).toContain("Reinstalling rotates the credential.");
    expect(html).toContain(en.installRegenerateCancel);
    expect(html).toContain(en.installRegenerateApply);
    expect(html).not.toContain(txt.installRegenerateCancel);
    expect(html).not.toContain('data-testid="node-install-regenerate-credential"');
    expect(html).not.toContain('data-testid="node-install-regenerate-offline-hint"');
    expect(html).toContain('data-testid="node-install-regenerate-apply"');
    expect(html).not.toContain(txt.installRegenerateOfflineHint);
  });
});

/* ------------------------------------------------------------------ */
/* 归属：跨节点不串命令                                                 */
/* ------------------------------------------------------------------ */

describe("安装命令归属：跨节点不串命令", () => {
  test("node_id 不匹配的命令一律不采纳（切 Workspace/节点不泄漏别人节点的令牌）", () => {
    expect(enrollmentBelongsToNode(enrollment(), NODE_ID)).toBe(true);
    expect(enrollmentBelongsToNode(enrollment({ node_id: 99 }), NODE_ID)).toBe(false);
    expect(enrollmentBelongsToNode(null, NODE_ID)).toBe(false);
    expect(enrollmentBelongsToNode(undefined, NODE_ID)).toBe(false);
    // 老后端缺 node_id：不因此吞掉命令
    expect(enrollmentBelongsToNode({ ...enrollment(), node_id: undefined } as unknown as NodeEnrollmentIssued, NODE_ID)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 在线 ≠ 命令已被消费                                                  */
/* ------------------------------------------------------------------ */

describe("在线命令：不谎称已消费", () => {
  test("online + 本地命令：给一次性 / 勿他处重复执行 / 显式重签的诚实提示", () => {
    const html = body({ enrollment: enrollment(), phase: "online" });
    expect(html).toContain('data-testid="node-install-online-command-notice"');
    expect(html).toContain(txt.installOnlineCommandNotice);
    // 不夸 health / version / 已消费
    expect(html).not.toContain("健康检查通过");
  });

  test("只在 online 且有命令时出现（等待安装 / 已装离线 / 无命令都不出现）", () => {
    expect(body({ enrollment: enrollment(), phase: "awaiting_install" })).not.toContain(
      'data-testid="node-install-online-command-notice"',
    );
    expect(body({ enrollment: enrollment(), phase: "installed_offline" })).not.toContain(
      'data-testid="node-install-online-command-notice"',
    );
    expect(body({ enrollment: null, phase: "online" })).not.toContain(
      'data-testid="node-install-online-command-notice"',
    );
  });

  test("英文界面同样给出诚实提示（不是中文回退）", () => {
    const html = render(
      <NodeInstallDialogBody
        enrollment={enrollment()}
        generating={false}
        phase="online"
        waiting={false}
        timedOut={false}
        pollFailed={false}
        onRegenerate={noop}
        onStop={noop}
        onRetry={noop}
        onCopy={noop}
        onClose={noop}
      />,
      "en",
    );
    expect(html).toContain(en.installOnlineCommandNotice);
    expect(html).not.toContain(txt.installOnlineCommandNotice);
  });
});

/* ------------------------------------------------------------------ */
/* 过期展示由「现在」驱动，不只是首次渲染                                  */
/* ------------------------------------------------------------------ */

describe("过期提示：由显式时间驱动", () => {
  const expiring = () => enrollment({ expires_at: "2026-10-06T00:10:00.000Z" });

  test("now 跨过截止点后立刻显示（组件把本地时钟传进正文）", () => {
    expect(body({ enrollment: expiring(), now: Date.parse("2026-10-06T00:09:59.000Z") })).not.toContain(
      'data-testid="node-install-expired"',
    );
    const after = body({ enrollment: expiring(), now: Date.parse("2026-10-06T00:10:00.000Z") });
    expect(after).toContain('data-testid="node-install-expired"');
    expect(after).toContain(txt.installExpiredHint);
  });

  test("已 online / 已装离线：时间跨过截止点也不标安装失败", () => {
    const late = Date.parse("2026-10-06T02:00:00.000Z");
    expect(body({ enrollment: expiring(), phase: "online", now: late })).not.toContain(
      'data-testid="node-install-expired"',
    );
    expect(body({ enrollment: expiring(), phase: "installed_offline", now: late })).not.toContain(
      'data-testid="node-install-expired"',
    );
  });
});

/* ------------------------------------------------------------------ */
/* 停止 / 失败 / 超时的可见性                                           */
/* ------------------------------------------------------------------ */

describe("停止与失败：对话框里有明确说明与重试", () => {
  test("用户手动停止：说明状态不再自动更新，并给出重试入口", () => {
    const html = body({ enrollment: enrollment(), waiting: false, stoppedByUser: true });
    expect(html).toContain(txt.installBannerStoppedHint);
    expect(html).toContain('data-testid="node-install-retry"');
    expect(html).not.toContain('data-testid="node-install-waiting-state"');
  });

  test("阶段与进度是 aria-live polite（状态被轮询推进时要能被读屏听到）", () => {
    const banner = render(
      <NodeInstallWaiting
        nodeId={NODE_ID}
        view={{ connection: "waiting", has_credential: false }}
        open={false}
        onOpenChange={noop}
      />,
    );
    expect(tagOf(banner, "node-install-phase-hint")).toContain('aria-live="polite"');
    const panel = body({ enrollment: enrollment(), waiting: true });
    expect(tagOf(panel, "node-install-progress")).toContain('aria-live="polite"');
    expect(tagOf(panel, "node-install-progress")).toContain('role="status"');
  });
});

/* ------------------------------------------------------------------ */
/* openLabel：调用方可换词条，管理端默认不变                              */
/* ------------------------------------------------------------------ */

describe("打开入口的文案", () => {
  const shell = (extra: { openLabel?: string } = {}) =>
    render(
      <NodeInstallWaiting
        nodeId={NODE_ID}
        view={{ connection: "waiting", has_credential: false }}
        open={false}
        onOpenChange={noop}
        {...extra}
      />,
    );

  test("传 openLabel 时用调用方文案（用户域「查看安装命令」）", () => {
    const html = shell({ openLabel: "查看安装命令" });
    expect(html).toContain("查看安装命令");
    expect(html).not.toContain(txt.installReopen);
  });

  test("不传时仍是共享默认词条（管理端默认行为不变）", () => {
    expect(shell()).toContain(txt.installReopen);
  });
});
