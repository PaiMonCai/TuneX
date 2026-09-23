export const TUNNEL_TYPES = ["tcp", "mtcp", "udp", "tunex", "mtls", "mwss", "wss", "tls", "quic"] as const;

export const LOAD_BALANCE_TYPES = ["round", "rand", "fifo", "hash", "ll", "lc"] as const;

export const BILLING_CYCLES: { value: string; zh: string; en: string }[] = [
  { value: "month", zh: "1 个月", en: "1 month" },
  { value: "quarter", zh: "3 个月", en: "3 months" },
  { value: "half_year", zh: "6 个月", en: "6 months" },
  { value: "year", zh: "12 个月", en: "12 months" },
  { value: "lifetime", zh: "永久", en: "Lifetime" },
];

export const STATUSES = ["active", "inactive"] as const;
export const NODE_TYPES = ["in", "out"] as const;
export const IP_TYPES = ["auto", "ipv4", "ipv6"] as const;
export const BYPASS_TYPES = ["whitelist", "blacklist"] as const;
export const TUNNEL_CATEGORIES = ["port_forward", "remote_port_forward"] as const;
export const PROTOCOLS = ["tcp", "udp"] as const;

/** 选项展示元数据：中英label + i18n key（labelKey 命中词典时优先用词典） */
export interface OptionMeta<V extends string = string> {
  value: V;
  labelKey?: string;
  zh: string;
  en: string;
}

export const STATUS_OPTIONS: OptionMeta[] = [
  { value: "active", labelKey: "common.active", zh: "启用", en: "Active" },
  { value: "inactive", labelKey: "common.inactive", zh: "停用", en: "Inactive" },
];

export const NODE_TYPE_OPTIONS: OptionMeta[] = [
  { value: "in", labelKey: "fields.in", zh: "入口", en: "In" },
  { value: "out", labelKey: "fields.out", zh: "出口", en: "Out" },
];

export const IP_TYPE_OPTIONS: OptionMeta[] = [
  { value: "auto", zh: "自动", en: "Auto" },
  { value: "ipv4", zh: "IPv4", en: "IPv4" },
  { value: "ipv6", zh: "IPv6", en: "IPv6" },
];

export const BYPASS_TYPE_OPTIONS: OptionMeta[] = [
  { value: "blacklist", zh: "黑名单", en: "Blacklist" },
  { value: "whitelist", zh: "白名单", en: "Whitelist" },
];

export const CATEGORY_OPTIONS: OptionMeta[] = [
  { value: "port_forward", labelKey: "tunnel.portForward", zh: "端口转发", en: "Port forward" },
  { value: "remote_port_forward", labelKey: "tunnel.remotePortForward", zh: "远程端口转发", en: "Remote port forward" },
];
