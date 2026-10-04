"use client";

import { useCallback, useState } from "react";
import { federationErrorInfo, type FederationErrorInfo } from "@/components/admin/federation/federation-status";

/**
 * 联邦写操作的统一交互（V5-WP14/15/16）。
 *
 * 三个必须一致的地方，收在一处实现：
 *  1. **就地完成**：写操作在对话框里进行，不跳页（§9.4.7）；
 *  2. **错误分层**：失败时把后端 `{ code, retryable, … }` 原样交给
 *     `FederationErrorNotice` 渲染，绝不替换成一句 "操作失败"；
 *  3. **单飞**：同一时刻只允许一个动作在跑（`pending` 非空时按钮禁用），
 *     避免「连点两次撤销」这类不可逆操作被重复提交。
 */
export interface FederationActionState {
  /** 正在跑的动作用 label 标识（null = 空闲） */
  pending: string | null;
  error: FederationErrorInfo | null;
  /** 成功反馈（一句话，含后端返回的关键标识，例如 grant_ref / revoked_leases） */
  notice: string | null;
}

export function useFederationAction() {
  const [state, setState] = useState<FederationActionState>({ pending: null, error: null, notice: null });

  const clear = useCallback(() => setState({ pending: null, error: null, notice: null }), []);

  /**
   * 跑一个写操作。
   *
   * `describe` 用后端返回体生成成功文案（例如「已轮转 key_id=…」），
   * 让管理员不必去翻日志确认刚刚发生了什么。
   */
  const run = useCallback(
    async (
      label: string,
      action: () => Promise<unknown>,
      hooks: { describe?: (result: never) => string; onSuccess?: (result: never) => void | Promise<void> } = {},
    ): Promise<boolean> => {
      setState({ pending: label, error: null, notice: null });
      try {
        const result = (await action()) as never;
        setState({
          pending: null,
          error: null,
          notice: hooks.describe ? hooks.describe(result) : null,
        });
        if (hooks.onSuccess) await hooks.onSuccess(result);
        return true;
      } catch (e) {
        setState({ pending: null, error: federationErrorInfo(e), notice: null });
        return false;
      }
    },
    [],
  );

  return { ...state, run, clear };
}
