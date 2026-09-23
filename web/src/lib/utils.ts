import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** 字节 → 人类可读（后端流量单位：字节） */
export function formatBytes(bytes: number | null | undefined, digits = 2): string {
  const n = Number(bytes ?? 0);
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
}

/** 金额格式化 */
export function formatMoney(v: number | null | undefined, symbol = "¥"): string {
  const n = Number(v ?? 0);
  return `${symbol}${n.toFixed(2)}`;
}

export function formatDateTime(v: string | Date | null | undefined): string {
  if (!v) return "-";
  const d = typeof v === "string" ? new Date(v) : v;
  if (Number.isNaN(d.getTime())) return "-";
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function formatDate(v: string | Date | null | undefined): string {
  if (!v) return "-";
  const d = typeof v === "string" ? new Date(v) : v;
  if (Number.isNaN(d.getTime())) return "-";
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 表单里的数字输入：空串 / 非法值 → null（用于「不限」「留空」语义） */
export function toNumOrNull(v: string): number | null {
  const s = v.trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 反向：number | null → 表单可编辑的字符串（null 渲染成空串，而不是 "null"） */
export function strOf(v: number | string | null | undefined): string {
  return v === null || v === undefined ? "" : String(v);
}

/** 逗号 / 换行分隔的列表 → 精简后的字符串数组；空 → null */
export function parseStringList(s: string): string[] | null {
  const items = s
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean);
  return items.length ? items : null;
}
