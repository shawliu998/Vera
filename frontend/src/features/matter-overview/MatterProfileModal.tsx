"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Modal } from "@/app/components/shared/Modal";
import { useProjectModalA11y } from "@/app/components/projects/useProjectModalA11y";
import { useI18n } from "@/app/i18n";
import {
  createVeraMatter,
  createVeraMatterProfile,
  updateVeraMatterProfile,
  VERA_WORKSPACE_TYPES,
  type VeraMatterCreateWire,
  type VeraMatterProfileCreateWire,
  type VeraMatterProfileUpdateWire,
  type VeraMatterProfileWire,
  type VeraMatterProjectWire,
  type VeraMatterWire,
  type VeraWorkspaceType,
} from "@/app/lib/veraMatterApi";

export type MatterProfileModalMode =
  | "create-matter"
  | "create-profile"
  | "edit-profile";

interface MatterProfileModalProps {
  open: boolean;
  mode: MatterProfileModalMode;
  project?: VeraMatterProjectWire;
  profile?: VeraMatterProfileWire | null;
  onClose: () => void;
  onSaved: (matter: VeraMatterWire) => void;
}

type FormState = {
  name: string;
  description: string;
  matterNumber: string;
  practiceArea: string;
  workspaceType: VeraWorkspaceType | "";
  clientName: string;
  jurisdiction: string;
  representedRole: string;
  objective: string;
};

const EMPTY_FORM: FormState = {
  name: "",
  description: "",
  matterNumber: "",
  practiceArea: "",
  workspaceType: "",
  clientName: "",
  jurisdiction: "",
  representedRole: "",
  objective: "",
};

function optionalText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function profileFields(form: FormState): VeraMatterProfileCreateWire {
  if (!form.workspaceType) throw new Error("Matter classification is required.");
  return {
    workspace_type: form.workspaceType,
    client_name: optionalText(form.clientName),
    jurisdiction: optionalText(form.jurisdiction),
    represented_role: optionalText(form.representedRole),
    objective: optionalText(form.objective),
  };
}

function formFromMatter(
  project?: VeraMatterProjectWire,
  profile?: VeraMatterProfileWire | null,
): FormState {
  return {
    ...EMPTY_FORM,
    name: project?.name ?? "",
    description: project?.description ?? "",
    matterNumber: project?.cm_number ?? "",
    practiceArea: project?.practice ?? "",
    workspaceType: profile?.workspace_type ?? "",
    clientName: profile?.client_name ?? "",
    jurisdiction: profile?.jurisdiction ?? "",
    representedRole: profile?.represented_role ?? "",
    objective: profile?.objective ?? "",
  };
}

export function MatterProfileModal({
  open,
  mode,
  project,
  profile,
  onClose,
  onSaved,
}: MatterProfileModalProps) {
  const { t, errorMessage } = useI18n();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const formId = "vera-matter-profile-form";

  useEffect(() => {
    if (!open) return;
    setForm(formFromMatter(project, profile));
    setSaving(false);
    setError(null);
  }, [open, profile, project]);

  const handleClose = useCallback(() => {
    requestRef.current?.abort();
    requestRef.current = null;
    setSaving(false);
    setError(null);
    onClose();
  }, [onClose]);

  const title =
    mode === "create-matter"
      ? t("matters.create")
      : mode === "create-profile"
        ? t("matters.profile.create")
        : profile?.workspace_type === null
          ? t("matters.profile.classify")
          : t("matters.profile.edit");

  useProjectModalA11y(open, handleClose, contentRef, title, mode);
  useEffect(() => () => requestRef.current?.abort(), []);

  const update = <Key extends keyof FormState>(
    key: Key,
    value: FormState[Key],
  ) => {
    setForm((current) => ({ ...current, [key]: value }));
    setError(null);
  };

  const canSubmit =
    !saving &&
    Boolean(form.workspaceType) &&
    (mode !== "create-matter" || Boolean(form.name.trim()));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    const controller = new AbortController();
    requestRef.current?.abort();
    requestRef.current = controller;
    setSaving(true);
    setError(null);
    try {
      const fields = profileFields(form);
      let saved: VeraMatterWire;
      if (mode === "create-matter") {
        const input: VeraMatterCreateWire = {
          name: form.name.trim(),
          description: optionalText(form.description),
          cm_number: optionalText(form.matterNumber),
          practice: optionalText(form.practiceArea),
          ...fields,
        };
        saved = await createVeraMatter(input, controller.signal);
      } else if (mode === "create-profile" && project) {
        saved = await createVeraMatterProfile(
          project.id,
          fields,
          controller.signal,
        );
      } else if (mode === "edit-profile" && project && profile) {
        const input: VeraMatterProfileUpdateWire = fields;
        saved = await updateVeraMatterProfile(
          project.id,
          input,
          controller.signal,
        );
      } else {
        throw new Error("Matter Profile modal state is invalid.");
      }
      if (controller.signal.aborted) return;
      onSaved(saved);
      handleClose();
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorMessage(cause as Error));
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
      if (!controller.signal.aborted) setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={title}
      size="xl"
      cancelAction={{
        label: t("common.actions.cancel"),
        onClick: handleClose,
        disabled: saving,
      }}
      primaryAction={{
        label: saving ? t("common.status.saving") : t("common.actions.save"),
        type: "submit",
        form: formId,
        disabled: !canSubmit,
      }}
      footerStatus={
        error ? (
          <span role="alert" className="text-sm text-red-600">
            {error}
          </span>
        ) : null
      }
    >
      <div ref={contentRef} className="min-h-0 flex-1">
        <form
          id={formId}
          onSubmit={submit}
          className="grid grid-cols-1 gap-x-6 gap-y-5 pb-6 md:grid-cols-2"
        >
          {mode === "create-matter" && (
            <>
              <MatterTextField
                id="matter-name"
                label={t("matters.fields.name")}
                value={form.name}
                onChange={(value) => update("name", value)}
                maxLength={240}
                required
                autoFocus
              />
              <MatterTextField
                id="matter-description"
                label={t("matters.fields.description")}
                value={form.description}
                onChange={(value) => update("description", value)}
                maxLength={2_000}
              />
              <MatterTextField
                id="matter-number"
                label={t("matters.fields.matterNumber")}
                value={form.matterNumber}
                onChange={(value) => update("matterNumber", value)}
                maxLength={160}
              />
              <MatterTextField
                id="matter-practice-area"
                label={t("matters.fields.practiceArea")}
                value={form.practiceArea}
                onChange={(value) => update("practiceArea", value)}
                maxLength={160}
              />
            </>
          )}

          <label className="space-y-1.5 text-xs font-medium text-gray-500">
            <span>{t("matters.fields.workspaceType")}</span>
            <select
              data-project-modal-autofocus={
                mode !== "create-matter" || undefined
              }
              value={form.workspaceType}
              onChange={(event) =>
                update(
                  "workspaceType",
                  event.target.value as VeraWorkspaceType | "",
                )
              }
              required
              className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 outline-none focus:border-gray-400"
            >
              <option value="">{t("matters.form.selectWorkspaceType")}</option>
              {VERA_WORKSPACE_TYPES.map((workspaceType) => (
                <option key={workspaceType} value={workspaceType}>
                  {t(`matters.workspaceTypes.${workspaceType}`)}
                </option>
              ))}
            </select>
          </label>

          <MatterTextField
            id="matter-client-name"
            label={t("matters.fields.clientName")}
            value={form.clientName}
            onChange={(value) => update("clientName", value)}
            maxLength={500}
          />
          <MatterTextField
            id="matter-jurisdiction"
            label={t("matters.fields.jurisdiction")}
            value={form.jurisdiction}
            onChange={(value) => update("jurisdiction", value)}
            maxLength={240}
          />
          <MatterTextField
            id="matter-represented-role"
            label={t("matters.fields.representedRole")}
            value={form.representedRole}
            onChange={(value) => update("representedRole", value)}
            maxLength={240}
          />

          <label className="space-y-1.5 text-xs font-medium text-gray-500 md:col-span-2">
            <span>{t("matters.fields.objective")}</span>
            <textarea
              id="matter-objective"
              value={form.objective}
              onChange={(event) => update("objective", event.target.value)}
              maxLength={16_384}
              rows={5}
              className="w-full resize-y rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 outline-none focus:border-gray-400"
            />
          </label>
        </form>
      </div>
    </Modal>
  );
}

function MatterTextField({
  id,
  label,
  value,
  onChange,
  maxLength,
  required = false,
  autoFocus = false,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  maxLength: number;
  required?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <label htmlFor={id} className="space-y-1.5 text-xs font-medium text-gray-500">
      <span>{label}</span>
      <input
        id={id}
        data-project-modal-autofocus={autoFocus || undefined}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        maxLength={maxLength}
        required={required}
        className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 outline-none focus:border-gray-400"
      />
    </label>
  );
}
