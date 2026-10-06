"use client";

/**
 * 用户域「通知偏好」卡片（切片 N1 —— 纯 EXPOSE，不新增后端）。
 *
 * ── 它暴露的是**已有**能力 ──
 * `GET/PUT /api/announcements/preferences`（`backend/src/routes/announcements.ts:151-180`）：
 * 服务端连同**可选的闭集**（`channels` / `categories`）一起下发，PUT 是**全量替换**且 fail-closed
 * （不认识的渠道/类别会让整个请求 400）。本文件只做三件事：取数、把服务端下发的闭集渲染成矩阵、
 * 提交整份清单。**不新增端点、不做本地推导的静默期、不猜用户是否会收到。**
 *
 * ── 四条硬纪律（都有对应测试）──
 *  ① **只渲染服务端下发的闭集**：矩阵的行列来自 `payload.categories` / `payload.channels`；
 *     服务端新增/删除值时页面跟着变。本文件没有一份"可选值副本"。类别**是否真的会投递**
 *     是另一件事，按 `lib/notification-i18n.ts` 的接线注解逐类如实标注（G9：今天 6 类里
 *     只有 `announcement` 真的会投递，node/forward 待 N3 接线，其余三个连派生都没有）。
 *  ② **三态**：`loading` / `degraded` / `ready`。`degraded` 时**不渲染任何开关** ——
 *     "没读到偏好"绝不折叠成"全部未静音"（那是在替用户声称一个我们从没看到过的状态）。
 *  ③ **400 与 503 分开**：`unknown_*` / `not_an_array` 是"页面与服务端闭集不一致 ⇒ 刷新"；
 *     `storage_error`/网络是"存储暂时不可用 ⇒ 可重试"。两者都**不改变用户的草稿**。
 *  ④ **user 级、跨工作空间**：不在任何请求里表达作用域，也不随工作空间切换重取；只把在途
 *     响应按 fence 作废（切换瞬间的晚到响应不许画到新上下文里）。服务端本来就只认会话用户。
 *
 * ── 为什么把异步编排抽成 `createPreferencesController()` ──
 * 本仓没有 happy-dom / testing-library（组件测试走 `renderToStaticMarkup`），因此"晚到响应被丢
 * 弃""400 与 503 分成两个状态"这类**时序**行为不能靠点 DOM 来证明。把编排做成注入式的纯逻辑，
 * 就能用受控 promise 真正跑一遍每条分支 —— 与 `lib/node-install-polling.ts` 同一取向。
 */

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/form";
import { useI18n } from "@/components/providers";
import { useWorkspace } from "@/components/workspace/workspace-context";
import { api, ApiError } from "@/lib/api";
import type { NotificationMutePreference, NotificationPreferencesPayload } from "@/lib/api/announcements";
import {
  categoryDeliveryCopy,
  categoryLabel,
  channelDeliveryCopy,
  channelLabel,
  muteToggleLabel,
  notificationErrorText,
  notificationText,
} from "@/lib/notification-i18n";
import { createPermissionRequestFence } from "@/lib/workspace-permissions";

/* ================================================================== */
/* 纯函数：三元组的集合运算与提交形状                                    */
/* ================================================================== */

/** 一条免打扰偏好（服务端形状的一个子集；额外字段一律不带）。 */
export interface MutePair {
  channel_kind: string;
  category: string;
}

/** 三元组的规范串（比较/查找用；落库的唯一索引是它的结构版本）。 */
export function muteKey(pair: MutePair): string {
  return `${pair.channel_kind}\u0000${pair.category}`;
}

/**
 * 归一化服务端返回的清单：丢掉形状非法的项（不是合法偏好，渲染不出来也不该拿它去写库）、
 * 按 `(渠道, 类别)` 去重。**不丢弃"值合法但那不在闭集里"的项** —— 那是另一件事，见 `unrepresentable`。
 */
export function normalizeMutes(input: unknown): MutePair[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: MutePair[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const channel = (raw as { channel_kind?: unknown }).channel_kind;
    const category = (raw as { category?: unknown }).category;
    if (typeof channel !== "string" || channel === "" || typeof category !== "string" || category === "") continue;
    const pair = { channel_kind: channel, category };
    const key = muteKey(pair);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(pair);
  }
  return out;
}

/** 提交顺序确定化（同一份意图两次提交得到同一个请求体，便于断言与排障）。 */
export function sortMutes(mutes: readonly MutePair[]): MutePair[] {
  return [...mutes].sort((a, b) =>
    a.channel_kind === b.channel_kind
      ? a.category.localeCompare(b.category)
      : a.channel_kind.localeCompare(b.channel_kind),
  );
}

export function isMuted(mutes: readonly MutePair[], channel: string, category: string): boolean {
  const key = muteKey({ channel_kind: channel, category });
  return mutes.some((mute) => muteKey(mute) === key);
}

/** 显式设置（不是取反）：`muted=true` 加入，`false` 移除。返回新数组，不改入参。 */
export function setMuted(
  mutes: readonly MutePair[],
  channel: string,
  category: string,
  muted: boolean,
): MutePair[] {
  const key = muteKey({ channel_kind: channel, category });
  const without = mutes.filter((mute) => muteKey(mute) !== key);
  return muted ? [...without, { channel_kind: channel, category }] : without;
}

/** 集合相等（顺序无关）。用于 `dirty` 判定：**顺序变化不算改动**。 */
export function sameMuteSet(a: readonly MutePair[], b: readonly MutePair[]): boolean {
  if (a.length !== b.length) return false;
  const keys = new Set(b.map(muteKey));
  return a.every((mute) => keys.has(muteKey(mute)));
}

/**
 * 读取 PUT 的**回显清单**（服务端已落库的真相）。
 * `null` = 响应里没有可辨认的清单（防御）⇒ 调用方保留本地意图，而不是把"没回显"当成"清空了"。
 */
export function readSaveEcho(echoed: unknown): MutePair[] | null {
  if (!echoed || typeof echoed !== "object") return null;
  const raw = (echoed as { mutes?: unknown }).mutes;
  if (!Array.isArray(raw)) return null;
  return normalizeMutes(raw);
}

/* ================================================================== */
/* 视图与状态（三态 + 400/503 分开）                                     */
/* ================================================================== */

export type PreferencesView =
  | { kind: "loading" }
  /** 没读到：**不等于**"全部未静音"（因此这个形态里没有任何开关）。 */
  | { kind: "degraded"; code: string | null; message: string }
  | {
      kind: "ready";
      channels: string[];
      categories: string[];
      /** 当前草稿（含 `unrepresentable`：保存时原样保留，绝不静默丢弃）。 */
      mutes: MutePair[];
      /** 服务端返回、但不在本次下发的闭集里（页面过期）：只提示，不假装能显示开关。 */
      unrepresentable: MutePair[];
    };

export type PreferencesSave =
  | { kind: "idle" }
  | { kind: "saving" }
  /** 服务端已记下这份偏好。**不等于**"你会收到"。 */
  | { kind: "saved" }
  /** 400：页面与服务端闭集不一致（刷新后重选）。 */
  | { kind: "rejected"; code: string | null; message: string }
  /** 503/网络：存储暂时不可用（可重试）。 */
  | { kind: "unavailable"; code: string | null; message: string };

export interface PreferencesSnapshot {
  view: PreferencesView;
  save: PreferencesSave;
  dirty: boolean;
}

function errorCodeOf(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const data = err.data;
  if (!data || typeof data !== "object") return null;
  const code = (data as { code?: unknown }).code;
  return typeof code === "string" && code !== "" ? code : null;
}

/**
 * 装载失败 → `degraded`。**只有** HTTP 状态可用来分档：`503` / 网络错误都是"存储/链路不可用"，
 * 两者都**不是**"用户什么都没静音"。未知状态码一律归入 `storage_error` 之外的 `unknown`，
 * 不编造理由（文案层用后端 message 兜底）。
 */
export function classifyLoadFailure(err: unknown, fallbackMessage: string): { code: string; message: string } {
  const code = errorCodeOf(err);
  const message = err instanceof Error && err.message !== "" ? err.message : fallbackMessage;
  if (code !== null) return { code, message };
  return { code: err instanceof ApiError ? `http_${err.status}` : "network_error", message };
}

/**
 * 保存失败 → `rejected`(400) 或 `unavailable`(其它)。
 *
 * 为什么必须分开：400 是"这份清单本身不被接受"（未知渠道/类别 ⇒ 页面过期，重试一百次也一样），
 * 503/网络是"这次没写进去"（可以重试）。把两者混成一句"保存失败，请重试"，等于让用户
 * 在一个不可能成功的操作上反复试。
 */
export function classifySaveFailure(err: unknown, fallbackMessage: string): PreferencesSave {
  const code = errorCodeOf(err);
  const message = err instanceof Error && err.message !== "" ? err.message : fallbackMessage;
  if (err instanceof ApiError && err.status === 400) return { kind: "rejected", code, message };
  // 非 400 一律"这次没写成"：优先保留服务端给的具体码（`storage_error`），
  // 没有码时退回 HTTP 状态/网络错误 —— 不编一个更具体的理由。
  return {
    kind: "unavailable",
    code: code ?? (err instanceof ApiError ? `http_${err.status}` : "network_error"),
    message,
  };
}

/* ================================================================== */
/* 编排器（注入式，可离线驱动）                                          */
/* ================================================================== */

export interface RequestFence {
  next(): number;
  current(ticket: number): boolean;
}

export interface PreferencesControllerOptions {
  fence: RequestFence;
  fetchPreferences: () => Promise<NotificationPreferencesPayload>;
  savePreferences: (mutes: readonly MutePair[]) => Promise<unknown>;
  onChange: (snapshot: PreferencesSnapshot) => void;
  fallbackLoadMessage: string;
  fallbackSaveMessage: string;
}

export interface PreferencesController {
  load(): Promise<void>;
  save(): Promise<void>;
  setMuted(channel: string, category: string, muted: boolean): void;
  /**
   * 页面上下文变化（切换工作空间）：
   *  ① 作废在途请求（晚到回执一律丢弃，不画到新上下文里）；
   *  ② 偏好是 **user 级**的 ⇒ **不重取**（已就绪的数据跨空间依然有效）；
   *  ③ 但别把用户卡住：若正停在 `loading`（从没读到过），重启一次装载；
   *     若正停在 `saving`，回到可操作状态（写入可能已落库，界面如实显示"还有未保存的更改"，
   *     用户可再存一次 —— PUT 是全量替换，重复提交是幂等的）。
   */
  onContextChanged(): void;
  snapshot(): PreferencesSnapshot;
  dispose(): void;
}

/**
 * 纯编排：状态转移只有 load / save / setMuted 三条路径，所有异步结果都要过一个 **fence**
 * （`createPermissionRequestFence()`：`next()` 作废此前所有在途请求，`current(ticket)` 判定）。
 * 于是"重试""保存""切换工作空间"三种情形下的晚到响应都会被丢弃 —— 不会出现
 * "切换空间后旧上下文的答案画上来"这种假状态。
 */
export function createPreferencesController(options: PreferencesControllerOptions): PreferencesController {
  let view: PreferencesView = { kind: "loading" };
  let save: PreferencesSave = { kind: "idle" };
  let channels: string[] = [];
  let categories: string[] = [];
  let draft: MutePair[] = [];
  let persisted: MutePair[] = [];
  let unrepresentable: MutePair[] = [];
  let disposed = false;

  const dirty = (): boolean => !sameMuteSet(draft, persisted);

  function emit(): void {
    if (disposed) return;
    options.onChange({ view, save, dirty: dirty() });
  }

  function readyView(): PreferencesView {
    return {
      kind: "ready",
      channels: [...channels],
      categories: [...categories],
      mutes: [...draft],
      unrepresentable: [...unrepresentable],
    };
  }

  function applyPayload(payload: NotificationPreferencesPayload, adopt: boolean): void {
    channels = Array.isArray(payload?.channels) ? [...payload.channels] : [];
    categories = Array.isArray(payload?.categories) ? [...payload.categories] : [];
    const mutes = normalizeMutes(payload?.mutes);
    if (adopt) {
      draft = [...mutes];
      persisted = [...mutes];
    }
    unrepresentable = mutes.filter(
      (mute) => !channels.includes(mute.channel_kind) || !categories.includes(mute.category),
    );
  }

  return {
    async load(): Promise<void> {
      const ticket = options.fence.next();
      view = { kind: "loading" };
      save = { kind: "idle" };
      emit();
      try {
        const payload = await options.fetchPreferences();
        // 切换工作空间 / 又点了一次重试 ⇒ 这份答案属于上一个上下文，丢弃（不弹任何错）。
        if (!options.fence.current(ticket)) return;
        applyPayload(payload, true);
        view = readyView();
        save = { kind: "idle" };
        emit();
      } catch (err) {
        if (!options.fence.current(ticket)) return;
        const failure = classifyLoadFailure(err, options.fallbackLoadMessage);
        view = { kind: "degraded", code: failure.code, message: failure.message };
        save = { kind: "idle" };
        emit();
      }
    },

    async save(): Promise<void> {
      if (view.kind !== "ready") return;
      const ticket = options.fence.next();
      save = { kind: "saving" };
      emit();
      const payload = sortMutes(draft);
      try {
        const stored = readSaveEcho(await options.savePreferences(payload));
        if (!options.fence.current(ticket)) return;
        // 服务端回显的是**已落库**的清单（PUT 全量替换）⇒ 以它为准；
        // 没有可辨认的回显（防御路径）时保留本地意图，绝不把"缺回显"读成"清单被清空"。
        persisted = stored ?? [...payload];
        draft = [...persisted];
        unrepresentable = draft.filter(
          (mute) => !channels.includes(mute.channel_kind) || !categories.includes(mute.category),
        );
        save = { kind: "saved" };
        view = readyView();
        emit();
      } catch (err) {
        if (!options.fence.current(ticket)) return;
        // 草稿原样保留：失败不该顺手改掉用户的选择（无论是 400 还是 503）。
        save = classifySaveFailure(err, options.fallbackSaveMessage);
        emit();
      }
    },

    setMuted(channel: string, category: string, muted: boolean): void {
      if (view.kind !== "ready") return;
      draft = setMuted(draft, channel, category, muted);
      if (save.kind !== "saving") save = { kind: "idle" };
      view = readyView();
      emit();
    },

    snapshot(): PreferencesSnapshot {
      return { view, save, dirty: dirty() };
    },

    onContextChanged(): void {
      if (disposed) return;
      const wasLoading = view.kind === "loading";
      const wasSaving = save.kind === "saving";
      options.fence.next();
      if (wasSaving) save = { kind: "idle" };
      if (wasLoading) {
        void this.load();
        return;
      }
      emit();
    },

    dispose(): void {
      disposed = true;
      // 卸载/切页后到达的响应一律丢弃（fence 作废在途请求）。
      options.fence.next();
    },
  };
}

/* ================================================================== */
/* 视图（纯展示；测试用静态渲染驱动每一个分支）                          */
/* ================================================================== */

export interface NotificationPreferencesBodyProps {
  view: PreferencesView;
  save: PreferencesSave;
  dirty: boolean;
  onToggle: (channel: string, category: string, muted: boolean) => void;
  onSave: () => void;
  onRetry: () => void;
}

export function NotificationPreferencesBody({
  view,
  save,
  dirty,
  onToggle,
  onSave,
  onRetry,
}: NotificationPreferencesBodyProps) {
  const { locale } = useI18n();
  const text = notificationText(locale);
  const emptyClosedSet = view.kind === "ready" && (view.channels.length === 0 || view.categories.length === 0);

  return (
    <Card data-testid="notification-preferences">
      <CardHeader>
        <CardTitle>{text.cardTitle}</CardTitle>
        <CardDescription>{text.cardSubtitle}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="field-hint" data-testid="notification-scope-note">
          {text.scopeNote}
        </p>
        <p className="field-hint" data-testid="notification-not-subscription">
          {text.notSubscription}
        </p>

        {view.kind === "loading" && (
          <p className="field-hint" data-testid="notification-preferences-loading">
            {text.loading}
          </p>
        )}

        {view.kind === "degraded" && (
          <div className="flex flex-col gap-2 rounded-md border border-[var(--border)] px-3 py-3" role="alert" data-testid="notification-preferences-degraded">
            <div className="text-sm font-medium">{text.unavailableTitle}</div>
            <div className="field-hint">{text.unavailableHint}</div>
            <div className="field-hint" data-testid="notification-preferences-degraded-detail">
              {notificationErrorText(locale, view.code, view.message)}
            </div>
            <div>
              <Button variant="outline" size="sm" onClick={onRetry} data-testid="notification-preferences-retry">
                {text.retry}
              </Button>
            </div>
          </div>
        )}

        {view.kind === "ready" && (
          <>
            {emptyClosedSet && (
              <div className="field-hint" role="alert" data-testid="notification-preferences-empty">
                {text.emptyClosedSet}
              </div>
            )}

            {!emptyClosedSet && (
              <p className="field-hint" data-testid="notification-closed-set-hint">
                {text.closedSetHint}
              </p>
            )}

            {view.unrepresentable.length > 0 && (
              <div className="field-hint" role="alert" data-testid="notification-preferences-unrepresentable">
                {text.unrepresentableHint.replace(
                  "{items}",
                  view.unrepresentable
                    .map((mute) => `${channelLabel(locale, mute.channel_kind)} × ${categoryLabel(locale, mute.category)}`)
                    .join("、"),
                )}
              </div>
            )}

            {view.channels.map((channel) => {
              const channelCopy = channelDeliveryCopy(locale, channel);
              return (
                <div key={channel} className="flex flex-col gap-2" data-testid={`notification-channel-${channel}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{channelLabel(locale, channel)}</span>
                    <Badge variant="outline">{channelCopy.title}</Badge>
                  </div>
                  <p className="field-hint" data-testid={`notification-channel-note-${channel}`}>
                    {channelCopy.note}
                  </p>
                  <div className="flex flex-col gap-2">
                    {view.categories.map((category) => {
                      const delivery = categoryDeliveryCopy(locale, category);
                      const muted = isMuted(view.mutes, channel, category);
                      const cell = `${channel}-${category}`;
                      return (
                        <div
                          key={cell}
                          className="flex items-start justify-between gap-4 rounded-md border border-[var(--border)] px-3 py-2"
                          data-testid={`notification-cell-${cell}`}
                        >
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm">{categoryLabel(locale, category)}</span>
                              <Badge variant="outline" data-testid={`notification-delivery-${cell}`}>
                                {delivery.title}
                              </Badge>
                              <span className="field-hint" data-testid={`notification-mute-state-${cell}`}>
                                {muted ? text.muted : text.unmuted}
                              </span>
                            </div>
                            <p className="field-hint mt-1">{delivery.note}</p>
                          </div>
                          <Switch
                            checked={muted}
                            onCheckedChange={(value) => onToggle(channel, category, value)}
                            id={`notification-mute-${cell}`}
                          />
                          <span className="sr-only">{muteToggleLabel(locale, channel, category)}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}

            {save.kind === "rejected" && (
              <div className="flex flex-col gap-2 rounded-md border border-[var(--border)] px-3 py-3" role="alert" data-testid="notification-save-rejected">
                <div className="text-sm font-medium">{text.rejectedTitle}</div>
                <div className="field-hint">{text.rejectedHint}</div>
                <div className="field-hint" data-testid="notification-save-rejected-detail">
                  {notificationErrorText(locale, save.code, save.message)}
                </div>
              </div>
            )}

            {save.kind === "unavailable" && (
              <div className="flex flex-col gap-2 rounded-md border border-[var(--border)] px-3 py-3" role="alert" data-testid="notification-save-unavailable">
                <div className="text-sm font-medium">{text.unavailableSaveTitle}</div>
                <div className="field-hint">{text.unavailableSaveHint}</div>
                <div className="field-hint" data-testid="notification-save-unavailable-detail">
                  {notificationErrorText(locale, save.code, save.message)}
                </div>
                <div>
                  <Button variant="outline" size="sm" onClick={onSave} data-testid="notification-save-retry">
                    {text.retry}
                  </Button>
                </div>
              </div>
            )}

            {save.kind === "saved" && (
              <div className="flex flex-col gap-1" data-testid="notification-save-saved">
                <div className="text-sm font-medium">{text.saved}</div>
                <div className="field-hint" data-testid="notification-save-saved-hint">
                  {text.savedNotDelivered}
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="field-hint" data-testid="notification-dirty-state">
                {dirty ? text.unsavedHint : ""}
              </span>
              <Button onClick={onSave} disabled={save.kind === "saving"} data-testid="notification-save">
                {save.kind === "saving" ? text.saving : text.save}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/* ================================================================== */
/* 容器（只做取数/提交接线，逻辑全在上面）                                */
/* ================================================================== */

export function NotificationPreferences() {
  const { locale } = useI18n();
  const text = notificationText(locale);
  const { currentId } = useWorkspace();

  const fenceRef = useRef<RequestFence>(createPermissionRequestFence());
  const controllerRef = useRef<PreferencesController | null>(null);
  const contextRef = useRef<number | null>(null);
  const [snapshot, setSnapshot] = useState<PreferencesSnapshot>({
    view: { kind: "loading" },
    save: { kind: "idle" },
    dirty: false,
  });

  useEffect(() => {
    const controller = createPreferencesController({
      fence: fenceRef.current,
      fetchPreferences: () => api.announcements.getPreferences(),
      savePreferences: (mutes) => api.announcements.putPreferences(mutes),
      onChange: setSnapshot,
      fallbackLoadMessage: text.unavailableTitle,
      fallbackSaveMessage: text.failedFallback,
    });
    controllerRef.current = controller;
    void controller.load();
    return () => controller.dispose();
    // 只装一次：这是 **user 级**偏好，不随工作空间或数据变化重取。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // 工作空间切换：**不重取**（偏好跨空间），只作废在途响应 ——
    // 否则切换瞬间返回的旧答案会被画成新上下文里的状态。
    if (contextRef.current === null) {
      contextRef.current = currentId;
      return;
    }
    if (contextRef.current === currentId) return;
    contextRef.current = currentId;
    controllerRef.current?.onContextChanged();
  }, [currentId]);

  return (
    <NotificationPreferencesBody
      view={snapshot.view}
      save={snapshot.save}
      dirty={snapshot.dirty}
      onToggle={(channel, category, muted) => controllerRef.current?.setMuted(channel, category, muted)}
      onSave={() => void controllerRef.current?.save()}
      onRetry={() => void controllerRef.current?.load()}
    />
  );
}
