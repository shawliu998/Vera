"use client";

// Direct port of Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/components/projects/NewProjectModal.tsx

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import { FileText, Upload, X } from "lucide-react";
import { FileDirectory } from "@/app/components/shared/FileDirectory";
import { Modal } from "@/app/components/shared/Modal";
import { useDirectoryData } from "@/app/components/shared/useDirectoryData";
import { useI18n } from "@/app/i18n";
import { SUPPORTED_DOCUMENT_ACCEPT } from "@/app/lib/documentUploadValidation";
import {
  attachVeraProjectDocument,
  createVeraProject,
  uploadVeraDocument,
} from "@/app/lib/veraApi";
import type { VeraProjectWire } from "@/app/lib/veraWireTypes";
import { useProjectModalA11y } from "./useProjectModalA11y";

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (project: VeraProjectWire) => void;
}

export function NewProjectModal({ open, onClose, onCreated }: Props) {
  const [step, setStep] = useState<"details" | "documents">("details");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(new Set());
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [createdProject, setCreatedProject] = useState<VeraProjectWire | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const { t, formatNumber, errorMessage } = useI18n();
  const formId = "vera-new-project-modal-form";
  const {
    loading: directoryLoading,
    error: directoryError,
    standaloneDocuments,
  } = useDirectoryData(open && step === "documents");

  const resetForm = useCallback(() => {
    requestRef.current?.abort();
    requestRef.current = null;
    setStep("details");
    setName("");
    setDescription("");
    setSelectedDocIds(new Set());
    setPendingFiles([]);
    setCreatedProject(null);
    setLoading(false);
    setError(null);
  }, []);

  const handleClose = useCallback(() => {
    resetForm();
    onClose();
  }, [onClose, resetForm]);

  useProjectModalA11y(
    open,
    handleClose,
    contentRef,
    t("projects.create"),
    step,
  );

  useEffect(() => () => requestRef.current?.abort(), []);

  if (!open) return null;

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!files.length) return;
    setPendingFiles((current) => [
      ...current,
      ...files.filter(
        (file) =>
          !current.some(
            (candidate) =>
              candidate.name === file.name &&
              candidate.size === file.size &&
              candidate.lastModified === file.lastModified,
          ),
      ),
    ]);
    setError(null);
  }

  function removePendingFile(file: File) {
    setPendingFiles((current) =>
      current.filter((candidate) => candidate !== file),
    );
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || loading) return;
    if (step === "details") {
      setStep("documents");
      return;
    }

    const controller = new AbortController();
    requestRef.current?.abort();
    requestRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const project =
        createdProject ??
        (await createVeraProject(
          {
            name: name.trim(),
            description: description.trim() || null,
          },
          controller.signal,
        ));
      if (!createdProject) {
        setCreatedProject(project);
        onCreated(project);
      }

      const selectedIds = [...selectedDocIds];
      const mutations = await Promise.allSettled([
        ...selectedIds.map((documentId) =>
          attachVeraProjectDocument(project.id, documentId, controller.signal),
        ),
        ...pendingFiles.map((file) =>
          uploadVeraDocument(
            { file, projectId: project.id },
            controller.signal,
          ),
        ),
      ]);
      if (controller.signal.aborted) return;
      const failedDocIds = new Set(
        selectedIds.filter(
          (_, index) => mutations[index]?.status === "rejected",
        ),
      );
      const failedFiles = pendingFiles.filter(
        (_, index) =>
          mutations[selectedIds.length + index]?.status === "rejected",
      );
      const completedCount =
        mutations.length - failedDocIds.size - failedFiles.length;
      const updatedProject = {
        ...project,
        document_count: project.document_count + completedCount,
      };
      setCreatedProject(updatedProject);
      onCreated(updatedProject);
      setSelectedDocIds(failedDocIds);
      setPendingFiles(failedFiles);
      const failure = mutations.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (failure) {
        setError(errorMessage(failure.reason as Error));
        return;
      }
      resetForm();
      onClose();
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(errorMessage(cause as Error));
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      breadcrumbs={[
        t("projects.title"),
        t("projects.create"),
        step === "details" ? t("common.fields.name") : t("documents.title"),
      ]}
      secondaryAction={
        step === "documents"
          ? {
              label:
                pendingFiles.length > 0
                  ? `${t("common.actions.upload")} (${formatNumber(pendingFiles.length)})`
                  : t("common.actions.upload"),
              icon: <Upload className="h-3.5 w-3.5" />,
              onClick: () => fileInputRef.current?.click(),
              disabled: loading,
            }
          : undefined
      }
      cancelAction={
        step === "documents" && !createdProject
          ? {
              label: t("common.actions.back"),
              onClick: () => setStep("details"),
              disabled: loading,
            }
          : {
              label: t("common.actions.cancel"),
              onClick: handleClose,
              disabled: loading,
            }
      }
      primaryAction={{
        label:
          step === "details"
            ? t("common.actions.open")
            : loading
              ? t("common.status.processing")
              : createdProject
                ? t("common.actions.retry")
                : t("projects.create"),
        type: "submit",
        form: formId,
        disabled:
          !name.trim() ||
          loading ||
          (Boolean(createdProject) &&
            pendingFiles.length === 0 &&
            selectedDocIds.size === 0),
      }}
    >
      <div ref={contentRef} className="flex min-h-0 flex-1 flex-col">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={SUPPORTED_DOCUMENT_ACCEPT}
          className="hidden"
          onChange={handleFileChange}
        />
        <form
          id={formId}
          onSubmit={handleSubmit}
          className="flex min-h-0 flex-1 flex-col"
        >
          {step === "details" ? (
            <div className="space-y-6 py-1">
              <div>
                <label
                  htmlFor="vera-new-project-name"
                  className="mb-1 block text-xs font-medium text-gray-500"
                >
                  {t("projects.nameLabel")}
                </label>
                <input
                  id="vera-new-project-name"
                  data-project-modal-autofocus
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                    setError(null);
                  }}
                  maxLength={240}
                  placeholder={t("projects.namePlaceholder")}
                  className="w-full border-0 border-b border-gray-100 bg-transparent px-0 py-2 text-2xl font-medium text-gray-900 outline-none transition-colors placeholder:text-gray-300 focus:border-gray-300"
                />
              </div>
              <div>
                <label
                  htmlFor="vera-new-project-description"
                  className="mb-1 block text-xs font-medium text-gray-500"
                >
                  {t("projects.descriptionLabel")}
                </label>
                <textarea
                  id="vera-new-project-description"
                  value={description}
                  onChange={(event) => {
                    setDescription(event.target.value);
                    setError(null);
                  }}
                  maxLength={2000}
                  rows={5}
                  placeholder={t("projects.descriptionPlaceholder")}
                  className="w-full resize-none border-0 border-b border-gray-100 bg-transparent px-0 py-2 text-sm text-gray-600 outline-none transition-colors placeholder:text-gray-300 focus:border-gray-300"
                />
              </div>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col gap-3 py-1">
              <FileDirectory
                standaloneDocs={standaloneDocuments}
                directoryProjects={[]}
                loading={directoryLoading}
                selectedIds={selectedDocIds}
                onChange={setSelectedDocIds}
                searchable
                searchAutoFocus
                showProjectTabs={false}
              />
              {pendingFiles.length > 0 && (
                <ul className="divide-y divide-gray-100">
                  {pendingFiles.map((file) => (
                    <li
                      key={`${file.name}:${file.size}:${file.lastModified}`}
                      className="flex items-center gap-3 py-3"
                    >
                      <FileText className="h-4 w-4 shrink-0 text-gray-400" />
                      <span className="min-w-0 flex-1 truncate text-sm text-gray-700">
                        {file.name}
                      </span>
                      <button
                        type="button"
                        onClick={() => removePendingFile(file)}
                        disabled={loading}
                        aria-label={`${t("common.actions.delete")} ${file.name}`}
                        className="rounded-full p-1 text-gray-400 transition-colors hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {Boolean(directoryError) && (
                <p role="alert" className="text-sm text-red-500">
                  {errorMessage(directoryError as Error)}
                </p>
              )}
            </div>
          )}
          {error && (
            <p role="alert" className="mt-3 text-sm text-red-500">
              {error}
            </p>
          )}
        </form>
      </div>
    </Modal>
  );
}
