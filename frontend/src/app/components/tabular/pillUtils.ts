// Direct adaptation of Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/components/tabular/pillUtils.ts
import type { VeraTabularColumn } from "@/app/lib/veraTabularApi";

export const TAG_COLORS = [
  "bg-blue-100 text-blue-700",
  "bg-violet-100 text-violet-700",
  "bg-pink-100 text-pink-700",
  "bg-orange-100 text-orange-700",
  "bg-teal-100 text-teal-700",
  "bg-amber-100 text-amber-700",
  "bg-indigo-100 text-indigo-700",
  "bg-rose-100 text-rose-700",
] as const;

const CURRENCY_COLORS: Record<string, string> = {
  USD: "bg-green-100 text-green-700",
  EUR: "bg-blue-100 text-blue-700",
  GBP: "bg-purple-100 text-purple-700",
  JPY: "bg-red-100 text-red-700",
  CHF: "bg-orange-100 text-orange-700",
  AUD: "bg-cyan-100 text-cyan-700",
  CAD: "bg-teal-100 text-teal-700",
  SGD: "bg-pink-100 text-pink-700",
  HKD: "bg-rose-100 text-rose-700",
  NZD: "bg-lime-100 text-lime-700",
  CNY: "bg-amber-100 text-amber-700",
};

export function getPillClass(
  content: string,
  column?: VeraTabularColumn,
): string {
  if (column?.format === "yes_no") {
    const lower = content.toLowerCase();
    if (["yes", "true", "是"].includes(lower)) {
      return "bg-green-100 text-green-700";
    }
    if (["no", "false", "否"].includes(lower)) {
      return "bg-red-100 text-red-700";
    }
    return "bg-gray-100 text-gray-700";
  }
  if (column?.format === "currency") {
    return CURRENCY_COLORS[content.toUpperCase()] ?? "bg-slate-100 text-slate-700";
  }
  if (column?.format === "tag") {
    const index = column.tags.findIndex(
      (tag) => tag.toLowerCase() === content.toLowerCase(),
    );
    if (index >= 0) return TAG_COLORS[index % TAG_COLORS.length]!;
  }
  return "bg-gray-100 text-gray-700";
}

export type PillSegment =
  | { type: "text"; content: string }
  | { type: "pill"; content: string };

export function parsePills(text: string): PillSegment[] {
  const segments: PillSegment[] = [];
  const expression = /\[\[([^\]]+)\]\]/g;
  let previous = 0;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(text)) !== null) {
    if (match.index > previous) {
      segments.push({ type: "text", content: text.slice(previous, match.index) });
    }
    segments.push({ type: "pill", content: match[1] ?? "" });
    previous = expression.lastIndex;
  }
  if (previous < text.length) {
    segments.push({ type: "text", content: text.slice(previous) });
  }
  return segments;
}
