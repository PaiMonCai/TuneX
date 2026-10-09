"use client";

/**
 * V5-WP5-A1：Forward **协议徽标** —— 列表 / 详情 / Dashboard / 编辑器四处**共用
 * 同一个实现**。
 *
 * 为什么单独一个文件、而不是塞进 `forward-edit-dialog.tsx`（`RunningVsDesiredBadge`
 * 就放在那里）：Dashboard 是服务端组件，只需要这一枚徽标；从编辑器模块里取它会
 * 把整个对话框（Radix dialog/select…）拖进 Dashboard 的客户端 bundle。
 *
 * 为什么不能各画一遍：协议事实现在有三个可取值（tcp/tls/ws）**加上**历史行上的
 * 「未开放」值（wss/udp/…），四处各写一段 switch 必然有人漏掉新值，退化成
 * 「unknown protocol」这种把事实替换掉的兜底。这里的规则只有一条：
 *
 *   · 标签永远是行上写着的事实本身（`wss` → `WSS`），**不存在** unknown 分支；
 *   · 未被当前运行时开放（后端 `protocol_supported === false`）时**另加**一个
 *     「未开放」注记，而不是把协议名换成别的词 —— 事实与可用性是两个问题。
 */
import { useI18n } from "@/components/providers";
import { Badge } from "@/components/ui/card";
import { forwardProtocolFact, forwardProtocolLabel, forwardTransportFor } from "@/lib/forward-protocol";
import type { PortForward } from "@/lib/types";

export function ForwardProtocolBadge({
  forward,
}: {
  forward: Pick<PortForward, "protocol" | "protocol_supported">;
}) {
  const { t } = useI18n();
  const label = forwardProtocolLabel(forward.protocol);
  // 缺字段（旧后端 / 旧 fixture）按「开放」处理：那是「不知道」而不是「没开放」，
  // 把它说成未开放会把一条正常运行中的转发画成异常。
  const supported = forward.protocol_supported !== false;
  /**
   * 传输维度（V5.1b）。udp 之外的协议都是 stream；`udp` 是 datagram。
   *
   * 这里刻意把事实放在 `data-transport` 上而不是多画一个徽标：协议名本身已经回答了
   * 「客户端说什么」，而 shell/测试需要能断言「udp 不是 stream 协议」时，读属性比
   * 读文案稳定。未开放的历史协议没有可声明的传输（`null` → 属性不出现），因为
   * 「这条协议不在此运行时上」与「它是哪种传输」是两个问题。
   */
  const transport = forwardTransportFor(forward.protocol);
  return (
    <span
      className="inline-flex items-center gap-1.5"
      {...(transport === null ? {} : { "data-transport": transport })}
    >
      <Badge
        variant={supported ? "secondary" : "outline"}
        data-testid={`forward-protocol-${forwardProtocolFact(forward.protocol)}`}
      >
        {label}
      </Badge>
      {supported ? null : (
        <span
          className="text-xs text-[var(--muted-foreground)]"
          data-testid="forward-protocol-unsupported"
        >
          {t("forward.protocolUnsupported")}
        </span>
      )}
    </span>
  );
}
