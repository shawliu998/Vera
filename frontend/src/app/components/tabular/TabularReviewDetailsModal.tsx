"use client";

// Adapted from Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/components/tabular/TabularReviewDetailsModal.tsx
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Modal } from "@/app/components/shared/Modal";
import { useI18n } from "@/app/i18n";
import type { VeraModelProfile } from "@/app/lib/veraModelSettingsApi";
import type { VeraProjectWire } from "@/app/lib/veraWireTypes";
import type { VeraTabularReview } from "@/app/lib/veraTabularApi";

export function TabularReviewDetailsModal({
  open,
  review,
  projects,
  models,
  busy = false,
  lockProject = false,
  onClose,
  onSave,
}: {
  open: boolean;
  review: VeraTabularReview | null;
  projects: VeraProjectWire[];
  models: VeraModelProfile[];
  busy?: boolean;
  lockProject?: boolean;
  onClose: () => void;
  onSave: (input: {
    title: string;
    project_id: string;
    model_profile_id: string;
  }) => Promise<void>;
}) {
  const { t, errorMessage } = useI18n();
  const [title, setTitle] = useState("");
  const [projectId, setProjectId] = useState("");
  const [modelProfileId, setModelProfileId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formId = "vera-tabular-review-details";

  useEffect(() => {
    if (!open || !review) return;
    queueMicrotask(() => {
      setTitle(review.title);
      setProjectId(review.project_id ?? "");
      setModelProfileId(review.model_profile_id ?? "");
      setSaving(false);
      setError(null);
    });
  }, [open, review]);

  const projectIsValid = projects.some(
    (project) => project.id === projectId && project.status === "active",
  );
  const modelIsValid = models.some((model) => model.id === modelProfileId);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (
      !review ||
      !title.trim() ||
      !projectIsValid ||
      !modelIsValid ||
      saving ||
      busy
    ) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({
        title: title.trim(),
        project_id: projectId,
        model_profile_id: modelProfileId,
      });
      onClose();
    } catch (reason) {
      setError(errorMessage(reason as Error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!saving && !busy) onClose();
      }}
      breadcrumbs={[t("tabular.title"), t("tabular.details.title")]}
      primaryAction={{
        label: saving ? t("common.status.saving") : t("common.actions.save"),
        type: "submit",
        form: formId,
        disabled:
          !review ||
          !title.trim() ||
          !projectIsValid ||
          !modelIsValid ||
          saving ||
          busy,
        icon: saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : undefined,
      }}
      cancelAction={{
        label: t("common.actions.cancel"),
        onClick: onClose,
        disabled: saving || busy,
      }}
    >
      <form id={formId} onSubmit={(event) => void save(event)} className="space-y-4 pb-5">
        {error && (
          <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </p>
        )}
        <label className="block space-y-1.5 text-xs font-medium text-gray-700">
          <span>{t("tabular.new.name")}</span>
          <input
            autoFocus
            value={title}
            maxLength={240}
            onChange={(event) => setTitle(event.target.value)}
            className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-400"
          />
        </label>

        <label className="block space-y-1.5 text-xs font-medium text-gray-700">
          <span>{t("tabular.new.project")}</span>
          <select
            value={projectId}
            disabled={lockProject || saving || busy}
            onChange={(event) => setProjectId(event.target.value)}
            className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-400 disabled:bg-gray-50 disabled:text-gray-500"
          >
            <option value="">{t("tabular.new.chooseProject")}</option>
            {projects
              .filter((project) => project.status === "active")
              .map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
          </select>
          {lockProject && (
            <span className="block text-[11px] font-normal text-gray-400">
              {t("tabular.details.projectLocked")}
            </span>
          )}
        </label>

        <label className="block space-y-1.5 text-xs font-medium text-gray-700">
          <span>{t("tabular.new.model")}</span>
          <select
            value={modelProfileId}
            disabled={saving || busy}
            onChange={(event) => setModelProfileId(event.target.value)}
            className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-400"
          >
            <option value="">{t("tabular.new.chooseModel")}</option>
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name} · {model.model}
              </option>
            ))}
          </select>
        </label>
      </form>
    </Modal>
  );
}
