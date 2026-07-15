"use client";

// Typography and citation treatment ported from Mike
// e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/components/assistant/message/MarkdownContent.tsx
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import type { CitationAnnotation } from "@/app/components/shared/types";
import { useI18n } from "@/app/i18n";

function withoutNode<P extends { node?: unknown }>(props: P): Omit<P, "node"> {
  const { node, ...rest } = props;
  void node;
  return rest;
}

function citationText(
  text: string,
  citations: readonly CitationAnnotation[],
): { text: string; targets: CitationAnnotation[] } {
  const targets: CitationAnnotation[] = [];
  const byRef = new Map(citations.map((citation) => [citation.ref, citation]));
  return {
    text: text.replace(/\[(\d+)]/g, (match, raw: string) => {
      const citation = byRef.get(Number(raw));
      if (!citation) return match;
      const index = targets.push(citation) - 1;
      return `\`§${index}§\``;
    }),
    targets,
  };
}

export function AssistantMarkdown({
  text,
  citations,
  onCitationClick,
}: {
  text: string;
  citations: readonly CitationAnnotation[];
  onCitationClick: (citation: CitationAnnotation) => void;
}) {
  const { t } = useI18n();
  const processed = citationText(text, citations);
  return (
    <div className="prose prose-sm mb-4 max-w-none font-serif text-base text-gray-900">
      <ReactMarkdown
        remarkPlugins={[[remarkMath, { singleDollarTextMath: false }], remarkGfm]}
        rehypePlugins={[rehypeKatex]}
        urlTransform={defaultUrlTransform}
        components={{
          table: (props) => (
            <div className="my-4 overflow-x-auto rounded-lg">
              <table
                className="min-w-full divide-y divide-gray-300 overflow-hidden"
                {...withoutNode(props)}
              />
            </div>
          ),
          thead: (props) => (
            <thead className="bg-gray-100" {...withoutNode(props)} />
          ),
          tbody: (props) => (
            <tbody className="divide-y divide-gray-200" {...withoutNode(props)} />
          ),
          th: (props) => (
            <th
              className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900"
              {...withoutNode(props)}
            />
          ),
          td: (props) => (
            <td
              className="whitespace-normal px-3 py-4 text-sm text-gray-900"
              {...withoutNode(props)}
            />
          ),
          h1: (props) => (
            <h1 className="mb-4 mt-6 font-serif text-3xl font-semibold" {...withoutNode(props)} />
          ),
          h2: (props) => (
            <h2 className="mb-3 mt-5 font-serif text-2xl font-semibold" {...withoutNode(props)} />
          ),
          h3: (props) => (
            <h3 className="mb-2 mt-4 text-xl font-semibold" {...withoutNode(props)} />
          ),
          p: (props) => <p className="mb-4 leading-7" {...withoutNode(props)} />,
          ul: (props) => (
            <ul className="mb-4 list-outside list-disc pl-6" {...withoutNode(props)} />
          ),
          ol: (props) => (
            <ol className="mb-4 list-outside list-decimal pl-6" {...withoutNode(props)} />
          ),
          li: (props) => <li className="mb-2 leading-7" {...withoutNode(props)} />,
          blockquote: (props) => (
            <blockquote
              className="my-4 border-l-4 border-gray-300 pl-4 italic"
              {...withoutNode(props)}
            />
          ),
          code: (props) => {
            const { children, ...rest } = withoutNode(props);
            const match = String(children).match(/^§(\d+)§$/);
            if (match) {
              const citation = processed.targets[Number(match[1])];
              if (citation) {
                return (
                  <button
                    type="button"
                    onClick={() => onCitationClick(citation)}
                    className="mx-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full border border-gray-200/60 bg-gray-200/80 align-super font-serif text-[12px] font-medium text-gray-800 shadow-sm transition-colors hover:bg-gray-200 hover:text-gray-950"
                    title={
                      citation.kind === "case"
                        ? t("assistant.citation")
                        : citation.filename
                    }
                  >
                    {citation.ref}
                  </button>
                );
              }
            }
            return (
              <code
                className="rounded bg-gray-100 px-1.5 py-0.5 font-serif text-sm"
                {...rest}
              >
                {children}
              </code>
            );
          },
          a: (props) => {
            const { href, ...rest } = withoutNode(props);
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 underline hover:text-blue-700"
                {...rest}
              />
            );
          },
        }}
      >
        {processed.text}
      </ReactMarkdown>
    </div>
  );
}
