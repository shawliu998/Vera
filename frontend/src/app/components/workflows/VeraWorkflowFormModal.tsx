"use client";

/**
 * Adapted from Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238
 * frontend/src/app/components/workflows/NewWorkflowModal.tsx.
 *
 * Vera removes cloud sharing, open-source submission, and fixture imports.
 */

import { useMemo, useState } from "react";
import { MessageSquare, Table2 } from "lucide-react";

import { Modal } from "@/app/components/shared/Modal";
import type {
  VeraWorkflow,
  VeraWorkflowCreateInput,
  VeraWorkflowType,
  VeraWorkflowUpdateInput,
} from "@/app/lib/veraWorkflowApi";

const LANGUAGES = ["中文", "English", "日本語", "한국어", "Other"] as const;
const PRACTICES = [
  "通用",
  "公司",
  "争议解决",
  "合规",
  "知识产权",
  "Other",
] as const;

interface VeraWorkflowFormModalCommonProps {
  open: boolean;
  workflow?: VeraWorkflow | null;
  busy?: boolean;
  error?: string | null;
  onClose: () => void;
}

type VeraWorkflowFormModalProps =
  | (VeraWorkflowFormModalCommonProps & {
      mode: "create";
      onCreate: (input: VeraWorkflowCreateInput) => Promise<void>;
    })
  | (VeraWorkflowFormModalCommonProps & {
      mode: "edit";
      workflow: VeraWorkflow;
      onUpdate: (input: VeraWorkflowUpdateInput) => Promise<void>;
    });

function initialValue(workflow?: VeraWorkflow | null) {
  return {
    title: workflow?.metadata.title ?? "",
    type: workflow?.metadata.type ?? ("assistant" as VeraWorkflowType),
    language: workflow?.metadata.language ?? "中文",
    practice: workflow?.metadata.practice ?? "通用",
    jurisdictions: workflow?.metadata.jurisdictions?.join("，") ?? "",
    skillMarkdown: workflow?.skill_md ?? "",
  };
}

export function VeraWorkflowFormModal(props: VeraWorkflowFormModalProps) {
  const { open, mode, workflow, busy = false, error, onClose } = props;
  const [value, setValue] = useState(() => initialValue(workflow));
  const formId =
    mode === "create" ? "vera-workflow-create" : "vera-workflow-edit";
  const isEdit = mode === "edit";
  const normalizedJurisdictions = useMemo(
    () =>
      value.jurisdictions
        .split(/[，,]/)
        .map((item) => item.trim())
        .filter(Boolean),
    [value.jurisdictions],
  );
  const languageOptions = LANGUAGES.includes(
    value.language as (typeof LANGUAGES)[number],
  )
    ? LANGUAGES
    : [value.language, ...LANGUAGES];
  const practiceOptions = PRACTICES.includes(
    value.practice as (typeof PRACTICES)[number],
  )
    ? PRACTICES
    : [value.practice, ...PRACTICES];

  if (!open) return null;

  const canSubmit = value.title.trim().length > 0 && !busy;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    const metadata = {
      title: value.title.trim(),
      language: value.language.trim() || null,
      practice: value.practice.trim() || null,
      jurisdictions: normalizedJurisdictions.length
        ? normalizedJurisdictions
        : null,
    };
    if (isEdit) {
      await props.onUpdate({
        metadata,
        ...(value.type === "assistant"
          ? { skill_md: value.skillMarkdown }
          : {}),
      });
      return;
    }
    await props.onCreate({
      metadata: { ...metadata, type: value.type },
      ...(value.type === "assistant"
        ? { skill_md: value.skillMarkdown }
        : { columns_config: [] }),
    });
  }

  return (
    <Modal
      open
      onClose={busy ? () => undefined : onClose}
      breadcrumbs={["工作流", isEdit ? "编辑信息" : "新建工作流"]}
      primaryAction={{
        type: "submit",
        form: formId,
        label: busy ? "正在保存…" : isEdit ? "保存更改" : "创建工作流",
        disabled: !canSubmit,
      }}
      cancelAction={{ label: "取消", onClick: onClose, disabled: busy }}
    >
      <form
        id={formId}
        onSubmit={(event) => void submit(event)}
        className="space-y-5 py-2"
      >
        <p className="rounded-xl border border-blue-100 bg-blue-50/70 px-3 py-2 text-xs leading-5 text-blue-900">
          工作流模板独立保存；项目仅是可选的使用容器，不会在这里创建共享或云端关联。
        </p>
        {error && (
          <p
            role="alert"
            className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            {error}
          </p>
        )}
        <label className="block text-sm font-medium text-gray-800">
          名称
          <input
            autoFocus
            value={value.title}
            maxLength={200}
            onChange={(event) =>
              setValue((current) => ({ ...current, title: event.target.value }))
            }
            placeholder="例如：合同风险摘要"
            className="mt-1.5 h-10 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm outline-none transition focus:border-gray-500"
          />
        </label>
        {!isEdit && (
          <fieldset>
            <legend className="text-sm font-medium text-gray-800">类型</legend>
            <div className="mt-1.5 grid grid-cols-2 gap-2">
              {(
                [
                  ["assistant", "助手工作流", MessageSquare],
                  ["tabular", "表格审阅工作流", Table2],
                ] as const
              ).map(([type, label, Icon]) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => setValue((current) => ({ ...current, type }))}
                  className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-left text-sm transition ${
                    value.type === type
                      ? "border-gray-700 bg-gray-900 text-white"
                      : "border-gray-200 text-gray-700 hover:border-gray-400"
                  }`}
                  aria-pressed={value.type === type}
                >
                  <Icon className="h-4 w-4" />
                  {label}
                </button>
              ))}
            </div>
          </fieldset>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm font-medium text-gray-800">
            语言
            <select
              value={value.language}
              onChange={(event) =>
                setValue((current) => ({
                  ...current,
                  language: event.target.value,
                }))
              }
              className="mt-1.5 h-10 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm outline-none focus:border-gray-500"
            >
              {languageOptions.map((language) => (
                <option key={language}>{language}</option>
              ))}
            </select>
          </label>
          <label className="block text-sm font-medium text-gray-800">
            业务领域
            <select
              value={value.practice}
              onChange={(event) =>
                setValue((current) => ({
                  ...current,
                  practice: event.target.value,
                }))
              }
              className="mt-1.5 h-10 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm outline-none focus:border-gray-500"
            >
              {practiceOptions.map((practice) => (
                <option key={practice}>{practice}</option>
              ))}
            </select>
          </label>
        </div>
        <label className="block text-sm font-medium text-gray-800">
          司法辖区（可选，逗号分隔）
          <input
            value={value.jurisdictions}
            maxLength={1_600}
            onChange={(event) =>
              setValue((current) => ({
                ...current,
                jurisdictions: event.target.value,
              }))
            }
            placeholder="中国大陆，香港特别行政区"
            className="mt-1.5 h-10 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm outline-none focus:border-gray-500"
          />
        </label>
        {value.type === "assistant" && (
          <label className="block text-sm font-medium text-gray-800">
            工作流指令（可选）
            <textarea
              value={value.skillMarkdown}
              maxLength={100_000}
              onChange={(event) =>
                setValue((current) => ({
                  ...current,
                  skillMarkdown: event.target.value,
                }))
              }
              placeholder="写下可复用的分析指令…"
              className="mt-1.5 min-h-32 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 font-mono text-sm leading-6 outline-none focus:border-gray-500"
            />
          </label>
        )}
      </form>
    </Modal>
  );
}
