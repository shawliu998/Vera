import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/app/lib/utils";

export function AgentTaskResult({
  children,
  compact = false,
}: {
  children: string;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "mt-1 overflow-auto pr-2 text-gray-500 [&_a]:underline [&_a]:underline-offset-2 [&_code]:rounded [&_code]:bg-gray-100 [&_code]:px-1 [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_li]:ml-4 [&_li]:list-disc [&_ol_li]:list-decimal [&_p+p]:mt-1.5 [&_table]:my-2 [&_table]:w-full [&_td]:border-b [&_td]:border-gray-100 [&_td]:px-2 [&_td]:py-1 [&_th]:border-b [&_th]:border-gray-200 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left",
        compact
          ? "max-h-24 text-[11px] leading-4"
          : "max-h-40 text-xs leading-5",
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
