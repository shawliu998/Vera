// Adapted from Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/components/tabular/columnFormat.ts
import type { LucideIcon } from "lucide-react";
import {
  AlignLeft,
  Banknote,
  Calendar,
  DollarSign,
  Hash,
  List,
  Percent,
  Tag,
  ToggleLeft,
} from "lucide-react";
import type { MessageKey } from "@/app/i18n";
import type { VeraTabularFormat } from "@/app/lib/veraTabularApi";

export const FORMAT_OPTIONS: Array<{
  value: VeraTabularFormat;
  labelKey: MessageKey;
  icon: LucideIcon;
  iconClassName: string;
}> = [
  {
    value: "text",
    labelKey: "tabular.formats.text",
    icon: AlignLeft,
    iconClassName: "text-sky-500",
  },
  {
    value: "bulleted_list",
    labelKey: "tabular.formats.bulletedList",
    icon: List,
    iconClassName: "text-indigo-500",
  },
  {
    value: "number",
    labelKey: "tabular.formats.number",
    icon: Hash,
    iconClassName: "text-violet-500",
  },
  {
    value: "percentage",
    labelKey: "tabular.formats.percentage",
    icon: Percent,
    iconClassName: "text-fuchsia-500",
  },
  {
    value: "monetary_amount",
    labelKey: "tabular.formats.monetaryAmount",
    icon: Banknote,
    iconClassName: "text-emerald-600",
  },
  {
    value: "currency",
    labelKey: "tabular.formats.currency",
    icon: DollarSign,
    iconClassName: "text-teal-600",
  },
  {
    value: "yes_no",
    labelKey: "tabular.formats.yesNo",
    icon: ToggleLeft,
    iconClassName: "text-amber-500",
  },
  {
    value: "date",
    labelKey: "tabular.formats.date",
    icon: Calendar,
    iconClassName: "text-rose-500",
  },
  {
    value: "tag",
    labelKey: "tabular.formats.tag",
    icon: Tag,
    iconClassName: "text-orange-500",
  },
];

export function formatOption(format: VeraTabularFormat) {
  return FORMAT_OPTIONS.find((option) => option.value === format) ?? FORMAT_OPTIONS[0]!;
}
