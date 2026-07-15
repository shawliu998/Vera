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
import { useI18n, type MessageKey } from "@/app/i18n";
import type {
  VeraWorkflow,
  VeraWorkflowCreateInput,
  VeraWorkflowType,
  VeraWorkflowUpdateInput,
} from "@/app/lib/veraWorkflowApi";

type FormOption = { value: string; labelKey: MessageKey | null };

const LANGUAGE_OPTIONS: readonly FormOption[] = [
  { value: "中文", labelKey: "workflows.form.options.languageChinese" },
  { value: "English", labelKey: "workflows.form.options.languageEnglish" },
  { value: "日本語", labelKey: "workflows.form.options.languageJapanese" },
  { value: "한국어", labelKey: "workflows.form.options.languageKorean" },
  { value: "Other", labelKey: "workflows.form.options.other" },
];
const PRACTICE_OPTIONS: readonly FormOption[] = [
  { value: "通用", labelKey: "workflows.form.options.practiceGeneral" },
  { value: "公司", labelKey: "workflows.form.options.practiceCorporate" },
  { value: "争议解决", labelKey: "workflows.form.options.practiceDisputes" },
  { value: "合规", labelKey: "workflows.form.options.practiceCompliance" },
  { value: "知识产权", labelKey: "workflows.form.options.practiceIp" },
  { value: "Other", labelKey: "workflows.form.options.other" },
];

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
  const { t } = useI18n();
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
  const languageOptions = LANGUAGE_OPTIONS.some(
    (option) => option.value === value.language,
  )
    ? LANGUAGE_OPTIONS
    : [{ value: value.language, labelKey: null }, ...LANGUAGE_OPTIONS];
  const practiceOptions = PRACTICE_OPTIONS.some(
    (option) => option.value === value.practice,
  )
    ? PRACTICE_OPTIONS
    : [{ value: value.practice, labelKey: null }, ...PRACTICE_OPTIONS];

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
      breadcrumbs={[
        t("workflows.title"),
        isEdit ? t("workflows.form.edit") : t("workflows.form.create"),
      ]}
      primaryAction={{
        type: "submit",
        form: formId,
        label: busy
          ? t("workflows.form.saving")
          : isEdit
            ? t("workflows.form.saveChanges")
            : t("workflows.form.createAction"),
        disabled: !canSubmit,
      }}
      cancelAction={{
        label: t("common.actions.cancel"),
        onClick: onClose,
        disabled: busy,
      }}
    >
      <form
        id={formId}
        onSubmit={(event) => void submit(event)}
        className="space-y-5 py-2"
      >
        <p className="rounded-xl border border-blue-100 bg-blue-50/70 px-3 py-2 text-xs leading-5 text-blue-900">
          {t("workflows.form.localHint")}
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
          {t("workflows.form.name")}
          <input
            autoFocus
            value={value.title}
            maxLength={200}
            onChange={(event) =>
              setValue((current) => ({ ...current, title: event.target.value }))
            }
            placeholder={t("workflows.form.namePlaceholder")}
            className="mt-1.5 h-10 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm outline-none transition focus:border-gray-500"
          />
        </label>
        {!isEdit && (
          <fieldset>
            <legend className="text-sm font-medium text-gray-800">
              {t("workflows.form.type")}
            </legend>
            <div className="mt-1.5 grid grid-cols-2 gap-2">
              {(
                [
                  ["assistant", t("workflows.form.assistant"), MessageSquare],
                  ["tabular", t("workflows.form.tabular"), Table2],
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
            {t("workflows.form.language")}
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
              {languageOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.labelKey ? t(option.labelKey) : option.value}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm font-medium text-gray-800">
            {t("workflows.form.practice")}
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
              {practiceOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.labelKey ? t(option.labelKey) : option.value}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="block text-sm font-medium text-gray-800">
          {t("workflows.form.jurisdiction")}
          <input
            value={value.jurisdictions}
            maxLength={1_600}
            onChange={(event) =>
              setValue((current) => ({
                ...current,
                jurisdictions: event.target.value,
              }))
            }
            placeholder={t("workflows.form.jurisdictionPlaceholder")}
            className="mt-1.5 h-10 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm outline-none focus:border-gray-500"
          />
        </label>
        {value.type === "assistant" && (
          <label className="block text-sm font-medium text-gray-800">
            {t("workflows.form.instructions")}
            <textarea
              value={value.skillMarkdown}
              maxLength={100_000}
              onChange={(event) =>
                setValue((current) => ({
                  ...current,
                  skillMarkdown: event.target.value,
                }))
              }
              placeholder={t("workflows.form.instructionsPlaceholder")}
              className="mt-1.5 min-h-32 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 font-mono text-sm leading-6 outline-none focus:border-gray-500"
            />
          </label>
        )}
      </form>
    </Modal>
  );
}
