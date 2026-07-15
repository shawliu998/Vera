"use client";

/**
 * Directly adapted from Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238
 * frontend/src/app/components/workflows/WorkflowPromptEditor.tsx.
 *
 * Shared Vera editor retaining Mike's TipTap Markdown model, rich/raw editing,
 * formatting controls and table insertion.
 */

import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import { Markdown } from "tiptap-markdown";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Bold,
  Code2,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  List,
  ListOrdered,
  Table2,
} from "lucide-react";
import { useI18n } from "@/app/i18n";

export interface VeraRichTextEditorProps {
  value: string;
  onChange?: (markdown: string) => void;
  readOnly?: boolean;
  ariaLabel?: string;
  maxLength?: number;
}

const TABLE_PICKER_MAX_ROWS = 6;
const TABLE_PICKER_MAX_COLS = 6;
const INACTIVE_FORMATTING = {
  heading1: false,
  heading2: false,
  heading3: false,
  bold: false,
  italic: false,
  bulletList: false,
  orderedList: false,
};

function ToolbarButton({
  onClick,
  active = false,
  title,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  title: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={`inline-flex h-7 w-7 items-center justify-center rounded-md text-gray-600 transition-colors hover:bg-white hover:text-gray-900 ${
        active ? "bg-gray-300 text-gray-950" : ""
      }`}
    >
      {children}
    </button>
  );
}

function getEditorMarkdown(editor: NonNullable<ReturnType<typeof useEditor>>) {
  const storage = editor.storage as unknown as {
    markdown: { getMarkdown: () => string };
  };
  return storage.markdown.getMarkdown();
}

export function VeraRichTextEditor({
  value,
  onChange,
  readOnly = false,
  ariaLabel,
  maxLength = 100_000,
}: VeraRichTextEditorProps) {
  const { t } = useI18n();
  const lastEmittedRef = useRef(value);
  const rawTextareaRef = useRef<HTMLTextAreaElement>(null);
  const tablePickerRef = useRef<HTMLDivElement>(null);
  const [rawMode, setRawMode] = useState(false);
  const [rawDraft, setRawDraft] = useState({
    sourceValue: value,
    markdown: value,
  });
  const rawMarkdown =
    rawDraft.sourceValue === value ? rawDraft.markdown : value;
  const [tablePickerOpen, setTablePickerOpen] = useState(false);
  const [tablePickerSize, setTablePickerSize] = useState<{
    rows: number;
    cols: number;
  } | null>(null);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        codeBlock: false,
        code: false,
        blockquote: false,
        horizontalRule: false,
      }),
      TableKit.configure({ table: { renderWrapper: true } }),
      Markdown.configure({
        html: false,
        transformPastedText: true,
        transformCopiedText: true,
      }),
    ],
    content: value,
    editable: !readOnly,
    immediatelyRender: false,
    onUpdate: ({ editor: updatedEditor, transaction }) => {
      if (!transaction.docChanged) return;
      const markdown = getEditorMarkdown(updatedEditor);
      lastEmittedRef.current = markdown;
      setRawDraft({ sourceValue: value, markdown });
      onChange?.(markdown);
    },
    editorProps: {
      attributes: {
        class: "tiptap vera-rich-text-editor-content workflow-editor-content",
        ...(ariaLabel ? { "aria-label": ariaLabel } : {}),
      },
    },
  });

  const activeFormatting =
    useEditorState({
      editor,
      selector: ({ editor: current }) => ({
        heading1: current?.isActive("heading", { level: 1 }) ?? false,
        heading2: current?.isActive("heading", { level: 2 }) ?? false,
        heading3: current?.isActive("heading", { level: 3 }) ?? false,
        bold: current?.isActive("bold") ?? false,
        italic: current?.isActive("italic") ?? false,
        bulletList: current?.isActive("bulletList") ?? false,
        orderedList: current?.isActive("orderedList") ?? false,
      }),
    }) ?? INACTIVE_FORMATTING;

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.setEditable(!readOnly, false);
  }, [editor, readOnly]);

  useEffect(() => {
    if (!editor || editor.isDestroyed || value === lastEmittedRef.current)
      return;
    lastEmittedRef.current = value;
    editor.commands.setContent(value, { emitUpdate: false });
  }, [editor, value]);

  useEffect(() => {
    if (!tablePickerOpen) return;
    const closeFromPointer = (event: MouseEvent) => {
      if (!tablePickerRef.current?.contains(event.target as Node)) {
        setTablePickerOpen(false);
        setTablePickerSize(null);
      }
    };
    const closeFromKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setTablePickerOpen(false);
        setTablePickerSize(null);
      }
    };
    document.addEventListener("mousedown", closeFromPointer);
    document.addEventListener("keydown", closeFromKeyboard);
    return () => {
      document.removeEventListener("mousedown", closeFromPointer);
      document.removeEventListener("keydown", closeFromKeyboard);
    };
  }, [tablePickerOpen]);

  function emitRaw(next: string, start?: number, end?: number) {
    setRawDraft({ sourceValue: value, markdown: next });
    lastEmittedRef.current = next;
    onChange?.(next);
    if (start !== undefined) {
      window.requestAnimationFrame(() => {
        rawTextareaRef.current?.focus();
        rawTextareaRef.current?.setSelectionRange(start, end ?? start);
      });
    }
  }

  function toggleRaw() {
    if (!editor || editor.isDestroyed) return;
    if (rawMode) {
      editor.commands.setContent(rawMarkdown, { emitUpdate: false });
      lastEmittedRef.current = rawMarkdown;
      onChange?.(rawMarkdown);
    } else {
      setRawDraft({
        sourceValue: value,
        markdown: getEditorMarkdown(editor),
      });
    }
    setRawMode((current) => !current);
  }

  function transformRawSelection(marker: "*" | "**") {
    const textarea = rawTextareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = rawMarkdown.slice(start, end);
    const replacement = `${marker}${selected}${marker}`;
    emitRaw(
      rawMarkdown.slice(0, start) + replacement + rawMarkdown.slice(end),
      start + marker.length,
      start + marker.length + selected.length,
    );
  }

  function transformRawLines(
    transform: (line: string, index: number) => string,
  ) {
    const textarea = rawTextareaRef.current;
    if (!textarea) return;
    const selectionStart = textarea.selectionStart;
    const selectionEnd = textarea.selectionEnd;
    const start =
      rawMarkdown.lastIndexOf("\n", Math.max(0, selectionStart - 1)) + 1;
    const foundEnd = rawMarkdown.indexOf("\n", selectionEnd);
    const end = foundEnd === -1 ? rawMarkdown.length : foundEnd;
    let item = 0;
    const replacement = rawMarkdown
      .slice(start, end)
      .split("\n")
      .map((line) => {
        if (!line.trim()) return line;
        const result = transform(line, item);
        item += 1;
        return result;
      })
      .join("\n");
    emitRaw(
      rawMarkdown.slice(0, start) + replacement + rawMarkdown.slice(end),
      start,
      start + replacement.length,
    );
  }

  function applyRawHeading(level: 1 | 2 | 3) {
    transformRawLines(
      (line) => `${"#".repeat(level)} ${line.replace(/^#{1,6}\s+/, "")}`,
    );
  }

  function insertRawTable(rows: number, cols: number) {
    const textarea = rawTextareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const before = rawMarkdown.slice(0, start);
    const after = rawMarkdown.slice(end);
    const lead = before.length === 0 || before.endsWith("\n") ? "" : "\n";
    const trail = after.length === 0 || after.startsWith("\n") ? "" : "\n";
    const header = `| ${Array.from({ length: cols }, (_, index) =>
      t("workflows.promptEditor.column", { index: index + 1 }),
    ).join(" | ")} |`;
    const separator = `| ${Array.from({ length: cols }, () => "---").join(" | ")} |`;
    const body = Array.from(
      { length: Math.max(0, rows - 1) },
      () => `| ${Array.from({ length: cols }, () => " ").join(" | ")} |`,
    );
    const table = `${lead}${[header, separator, ...body].join("\n")}\n${trail}`;
    emitRaw(before + table + after, before.length + table.length);
  }

  function insertTable(rows: number, cols: number) {
    setTablePickerOpen(false);
    setTablePickerSize(null);
    if (rawMode) {
      insertRawTable(rows, cols);
    } else {
      editor
        ?.chain()
        .focus()
        .insertTable({ rows, cols, withHeaderRow: true })
        .run();
    }
  }

  const icon = "h-4 w-4";
  const rawOr = (rawAction: () => void, richAction: () => void) =>
    rawMode ? rawAction() : richAction();

  return (
    <div className="flex h-full min-h-72 flex-col overflow-hidden rounded-xl border border-gray-200 bg-white">
      <div className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-gray-100 bg-gray-50 px-2 py-1.5">
        {!readOnly && editor && (
          <>
            {([1, 2, 3] as const).map((level) => {
              const Icon =
                level === 1 ? Heading1 : level === 2 ? Heading2 : Heading3;
              const key = `heading${level}` as const;
              return (
                <ToolbarButton
                  key={level}
                  title={t("workflows.promptEditor.heading", { level })}
                  active={!rawMode && activeFormatting[key]}
                  onClick={() =>
                    rawOr(
                      () => applyRawHeading(level),
                      () =>
                        editor.chain().focus().toggleHeading({ level }).run(),
                    )
                  }
                >
                  <Icon className={icon} />
                </ToolbarButton>
              );
            })}
            <span className="mx-1 h-4 w-px shrink-0 bg-gray-200" />
            <ToolbarButton
              title={t("workflows.promptEditor.bold")}
              active={!rawMode && activeFormatting.bold}
              onClick={() =>
                rawOr(
                  () => transformRawSelection("**"),
                  () => editor.chain().focus().toggleBold().run(),
                )
              }
            >
              <Bold className={icon} />
            </ToolbarButton>
            <ToolbarButton
              title={t("workflows.promptEditor.italic")}
              active={!rawMode && activeFormatting.italic}
              onClick={() =>
                rawOr(
                  () => transformRawSelection("*"),
                  () => editor.chain().focus().toggleItalic().run(),
                )
              }
            >
              <Italic className={icon} />
            </ToolbarButton>
            <span className="mx-1 h-4 w-px shrink-0 bg-gray-200" />
            <ToolbarButton
              title={t("workflows.promptEditor.bulletList")}
              active={!rawMode && activeFormatting.bulletList}
              onClick={() =>
                rawOr(
                  () =>
                    transformRawLines((line) =>
                      line.replace(/^(\s*)(?:[-*+]|\d+\.)\s+/, "$1- "),
                    ),
                  () => editor.chain().focus().toggleBulletList().run(),
                )
              }
            >
              <List className={icon} />
            </ToolbarButton>
            <ToolbarButton
              title={t("workflows.promptEditor.orderedList")}
              active={!rawMode && activeFormatting.orderedList}
              onClick={() =>
                rawOr(
                  () =>
                    transformRawLines((line, index) =>
                      line.replace(
                        /^(\s*)(?:[-*+]|\d+\.)\s+/,
                        `$1${index + 1}. `,
                      ),
                    ),
                  () => editor.chain().focus().toggleOrderedList().run(),
                )
              }
            >
              <ListOrdered className={icon} />
            </ToolbarButton>
            <span className="mx-1 h-4 w-px shrink-0 bg-gray-200" />
            <div ref={tablePickerRef} className="relative">
              <ToolbarButton
                title={t("workflows.promptEditor.insertTable")}
                active={tablePickerOpen}
                onClick={() => setTablePickerOpen((current) => !current)}
              >
                <Table2 className={icon} />
              </ToolbarButton>
              {tablePickerOpen && (
                <div
                  role="dialog"
                  aria-label={t("workflows.promptEditor.insertTable")}
                  className="absolute left-0 top-full z-[250] mt-1 w-max rounded-lg border border-gray-200 bg-white p-2 shadow-lg"
                >
                  <div
                    className="grid gap-1"
                    style={{
                      gridTemplateColumns: `repeat(${TABLE_PICKER_MAX_COLS}, 1rem)`,
                    }}
                  >
                    {Array.from({ length: TABLE_PICKER_MAX_ROWS }, (_, row) =>
                      Array.from(
                        { length: TABLE_PICKER_MAX_COLS },
                        (_, col) => {
                          const rows = row + 1;
                          const cols = col + 1;
                          const selected =
                            tablePickerSize !== null &&
                            rows <= tablePickerSize.rows &&
                            cols <= tablePickerSize.cols;
                          return (
                            <button
                              key={`${rows}-${cols}`}
                              type="button"
                              aria-label={t(
                                "workflows.promptEditor.insertTableSize",
                                { rows, cols },
                              )}
                              onMouseEnter={() =>
                                setTablePickerSize({ rows, cols })
                              }
                              onFocus={() => setTablePickerSize({ rows, cols })}
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() => insertTable(rows, cols)}
                              className={`h-4 w-4 rounded-[3px] border ${
                                selected
                                  ? "border-gray-700 bg-gray-800"
                                  : "border-gray-200 bg-white"
                              }`}
                            />
                          );
                        },
                      ),
                    )}
                  </div>
                  <p className="mt-2 text-center text-[11px] text-gray-500">
                    {tablePickerSize
                      ? `${tablePickerSize.rows} × ${tablePickerSize.cols}`
                      : t("workflows.promptEditor.chooseTableSize")}
                  </p>
                </div>
              )}
            </div>
          </>
        )}
        {readOnly && (
          <span className="px-2 text-xs font-medium text-gray-500">
            {t("workflows.promptEditor.readOnly")}
          </span>
        )}
        <span className="ml-auto" />
        <ToolbarButton
          onClick={toggleRaw}
          active={rawMode}
          title={
            rawMode
              ? t("workflows.promptEditor.richMode")
              : t("workflows.promptEditor.rawMode")
          }
        >
          <Code2 className={icon} />
        </ToolbarButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {rawMode ? (
          <textarea
            ref={rawTextareaRef}
            value={rawMarkdown}
            onChange={(event) => emitRaw(event.target.value)}
            readOnly={readOnly}
            spellCheck={false}
            maxLength={maxLength}
            aria-label={ariaLabel ?? t("workflows.promptEditor.rawLabel")}
            className="h-full min-h-full w-full resize-none bg-white px-5 py-4 font-mono text-xs leading-6 text-gray-800 outline-none read-only:cursor-default"
          />
        ) : (
          <EditorContent editor={editor} />
        )}
      </div>
    </div>
  );
}
