"use client";

import { useEffect, useState } from "react";
import type { Document, Workflow } from "../shared/types";
import { createTabularReview } from "@/app/lib/mikeApi";
import { useRouter } from "next/navigation";
import { useDirectoryData } from "../shared/useDirectoryData";
import { FileDirectory } from "../shared/FileDirectory";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { Modal } from "../modals/Modal";
import { ModalFieldLabel } from "../modals/ModalFieldLabel";
import { ModalSegmentedToggle } from "../modals/ModalSegmentedToggle";
import { ModalSelect } from "../modals/ModalSelect";
import { ModalTextarea } from "../modals/ModalTextarea";
import { ModalTextInput } from "../modals/ModalTextInput";
import { WorkflowPickerContent } from "./WorkflowPickerContent";
import { workflowDetailPath } from "./workflowRoutes";
import { useSelectedModel } from "@/app/hooks/useSelectedModel";
import {
  buildWorkflowChatStartMessage,
  buildWorkflowTaskGoal,
} from "@/app/lib/workflowChatStart";
import { createAgentTask } from "@/app/lib/agentClient";

interface Props {
  workflows: Workflow[];
  workflow: Workflow | null;
  onClose: () => void;
  skipSelect?: boolean;
}

const PATENT_PRIOR_ART_ACQUISITION_WORKFLOW_ID =
  "builtin-patent-prior-art-acquisition";
const EPO_PUBLICATION_JURISDICTIONS = [
  "AU",
  "BR",
  "CA",
  "CN",
  "DE",
  "EP",
  "ES",
  "FR",
  "GB",
  "IN",
  "IT",
  "JP",
  "KR",
  "MX",
  "NL",
  "RU",
  "SG",
  "TW",
  "US",
  "WO",
] as const;

function currentIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function SelectedWorkflowSummary({ workflow }: { workflow: Workflow }) {
  return (
    <div className="mb-3 flex shrink-0 items-center justify-between gap-3">
      <span className="shrink-0 text-xs font-medium text-gray-700">
        Selected workflow
      </span>
      <span className="min-w-0 flex-1 truncate text-right text-xs text-gray-500">
        {workflow.metadata.title}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// UseWorkflowModal
// ---------------------------------------------------------------------------
export function UseWorkflowModal({
  workflows,
  workflow,
  onClose,
  skipSelect = false,
}: Props) {
  const [screen, setScreen] = useState<"select" | "details" | "documents">(
    "select",
  );
  const [selected, setSelected] = useState<Workflow | null>(workflow);
  const [listSearch, setListSearch] = useState("");

  // Configure screen state
  const [inProject, setInProject] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  );
  const [selectedDocuments, setSelectedDocuments] = useState<Document[]>([]);
  const [assistantPrompt, setAssistantPrompt] = useState("");
  const [sourceQuery, setSourceQuery] = useState("");
  const [sourceJurisdiction, setSourceJurisdiction] = useState("");
  const [sourceAsOfDate, setSourceAsOfDate] = useState(currentIsoDate);
  const [saving, setSaving] = useState(false);

  const router = useRouter();
  const [model] = useSelectedModel();
  const { saveChat, setNewChatMessages } = useChatHistoryContext();
  const { loading: dirLoading, projects } = useDirectoryData(
    screen === "details",
    "projects",
  );

  useEffect(() => {
    if (workflow) {
      setSelected(workflow);
      setScreen(skipSelect ? "details" : "select");
      setListSearch("");
    } else {
      setSelected(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflow?.id]);

  // Reset configure state on back
  useEffect(() => {
    if (screen === "select") {
      resetConfigureState();
    }
  }, [screen]);

  function resetConfigureState() {
    setInProject(false);
    setSelectedProjectId(null);
    setSelectedDocuments([]);
    setAssistantPrompt("");
    setSourceQuery("");
    setSourceJurisdiction("");
    setSourceAsOfDate(currentIsoDate());
  }

  function handleClose() {
    setSelected(null);
    setScreen("select");
    resetConfigureState();
    onClose();
  }

  if (!workflow) return null;
  const wf = selected ?? workflow;
  const usesWorkTask = wf.execution_mode === "work_task";
  const usesSourceAcquisition =
    wf.id === PATENT_PRIOR_ART_ACQUISITION_WORKFLOW_ID;
  const usesMatter = usesWorkTask || inProject;

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------
  async function handleStartChat() {
    setSaving(true);
    try {
      const projectId = usesMatter ? selectedProjectId! : undefined;
      const chatId = await saveChat(projectId);
      if (!chatId) return;
      setNewChatMessages([
        buildWorkflowChatStartMessage({
          workflow: wf,
          documents: selectedDocuments,
          assistantPrompt,
          model,
        }),
      ]);
      handleClose();
      router.push(
        projectId
          ? `/projects/${projectId}/assistant/chat/${chatId}`
          : `/assistant/chat/${chatId}`,
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleStartWorkTask() {
    if (!selectedProjectId) return;
    setSaving(true);
    try {
      const snapshot = await createAgentTask({
        goal: buildWorkflowTaskGoal({
          workflowTitle: wf.metadata.title,
          assistantPrompt,
        }),
        matterId: selectedProjectId,
        model,
        documentIds: selectedDocuments.map((document) => document.id),
        workflowId: wf.id,
        sourceAcquisition: usesSourceAcquisition
          ? {
              query: sourceQuery.trim(),
              jurisdiction: sourceJurisdiction,
              asOfDate: sourceAsOfDate,
            }
          : undefined,
      });
      handleClose();
      router.push(`/agent-tasks/${snapshot.task.id}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleCreateReview() {
    const docIds = selectedDocuments.map((document) => document.id);
    const projectId = usesMatter ? selectedProjectId! : undefined;

    setSaving(true);
    try {
      const review = await createTabularReview({
        title: wf.metadata.title,
        document_ids: docIds,
        columns_config: wf.columns_config || [],
        workflow_id: wf.is_system ? undefined : wf.id,
        project_id: projectId,
      });
      handleClose();
      router.push(
        projectId
          ? `/projects/${projectId}/tabular-reviews/${review.id}`
          : `/tabular-reviews/${review.id}`,
      );
    } finally {
      setSaving(false);
    }
  }

  const selectedProject = projects.find((p) => p.id === selectedProjectId);
  const projectDocs = selectedProject?.documents ?? [];
  const projectOptions = projects.map((project) => ({
    value: project.id,
    label: project.name + (project.cm_number ? ` (#${project.cm_number})` : ""),
  }));
  const location = usesMatter ? "project" : "workspace";
  const locationOptions = usesWorkTask
    ? [{ value: "project" as const, label: "Matter work task" }]
    : wf.metadata.type === "assistant"
      ? [
          { value: "workspace" as const, label: "Assistant" },
          { value: "project" as const, label: "Project assistant" },
        ]
      : [
          { value: "workspace" as const, label: "Tabular reviews" },
          {
            value: "project" as const,
            label: "Project tabular reviews",
          },
        ];

  const breadcrumbs =
    screen === "select"
      ? ["Workflows", "Select workflow"]
      : [
          <button
            key="workflows"
            type="button"
            onClick={() => setScreen("select")}
            className="transition-colors hover:text-gray-700"
          >
            Workflows
          </button>,
          wf.metadata.title,
          usesWorkTask
            ? "New Work Task"
            : wf.metadata.type === "assistant"
              ? "New Chat"
              : "New Review",
          screen === "details" ? "Details" : "Attach Documents",
        ];

  const selectPageAction = () => {
    router.push(workflowDetailPath(wf));
    handleClose();
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <Modal
      open={!!workflow}
      onClose={handleClose}
      size={screen === "select" ? "xl" : "lg"}
      breadcrumbs={breadcrumbs}
      secondaryAction={
        screen === "select"
          ? {
              label: "View Page",
              onClick: selectPageAction,
            }
          : screen === "details"
            ? {
                label: "Back",
                onClick: () => setScreen("select"),
                disabled: saving,
              }
            : {
                label: "Back",
                onClick: () => setScreen("details"),
                disabled: saving,
              }
      }
      primaryAction={
        screen === "select"
          ? {
              label: "Use",
              onClick: () => setScreen("details"),
            }
          : screen === "details"
            ? {
                label: "Next",
                onClick: () => setScreen("documents"),
                disabled:
                  saving ||
                  (usesMatter && !selectedProjectId) ||
                  (usesSourceAcquisition &&
                    (!sourceQuery.trim() ||
                      !sourceJurisdiction ||
                      !sourceAsOfDate)),
              }
            : wf.metadata.type === "assistant"
              ? {
                  label: saving
                    ? "Starting…"
                    : usesWorkTask
                      ? "Start Work Task"
                      : "Start Chat",
                  onClick: usesWorkTask ? handleStartWorkTask : handleStartChat,
                  disabled:
                    saving ||
                    (usesMatter && !selectedProjectId) ||
                    (usesSourceAcquisition && selectedDocuments.length === 0),
                }
              : {
                  label: saving ? "Creating…" : "Create Review",
                  onClick: handleCreateReview,
                  disabled:
                    saving ||
                    selectedDocuments.length === 0 ||
                    (usesMatter && !selectedProjectId),
                }
      }
      cancelAction={false}
    >
      {/* ── SELECT SCREEN ── */}
      {screen === "select" && (
        <WorkflowPickerContent
          workflows={workflows}
          selected={wf}
          onSelect={(next) => {
            if (next) setSelected(next);
          }}
          search={listSearch}
          onSearchChange={setListSearch}
          workflowType="all"
          previewMode="auto"
          showTypeIcon
          allowClearPreview={false}
        />
      )}

      {/* ── DETAILS SCREEN ── */}
      {screen === "details" && (
        <div className="flex min-h-0 flex-1 flex-col">
          <SelectedWorkflowSummary workflow={wf} />

          <div className="min-h-0 flex-1 space-y-6 overflow-y-auto pb-3 pr-1">
            <div>
              <ModalFieldLabel as="p">Use in</ModalFieldLabel>
              <ModalSegmentedToggle
                value={location}
                onChange={(value) => {
                  setInProject(value === "project");
                  setSelectedProjectId(null);
                  setSelectedDocuments([]);
                }}
                options={locationOptions}
              />
            </div>

            {usesMatter && (
              <div>
                <ModalFieldLabel htmlFor="workflow-project">
                  Project
                </ModalFieldLabel>
                <ModalSelect
                  id="workflow-project"
                  value={selectedProjectId ?? ""}
                  options={projectOptions}
                  onChange={(value) => {
                    setSelectedProjectId(value || null);
                    setSelectedDocuments([]);
                  }}
                  placeholder={
                    dirLoading
                      ? "Loading projects..."
                      : projects.length
                        ? "Select project..."
                        : "No projects found"
                  }
                  disabled={dirLoading || projects.length === 0}
                />
              </div>
            )}

            {wf.metadata.type === "assistant" && (
              <div>
                <ModalFieldLabel htmlFor="workflow-additional-message">
                  Additional message
                </ModalFieldLabel>
                <ModalTextarea
                  id="workflow-additional-message"
                  value={assistantPrompt}
                  onChange={(e) => setAssistantPrompt(e.target.value)}
                  placeholder="Add any additional instructions..."
                  rows={4}
                />
              </div>
            )}

            {usesSourceAcquisition && (
              <div className="space-y-4 border-t border-gray-900/[0.07] pt-5">
                <div>
                  <ModalFieldLabel htmlFor="workflow-source-query">
                    Exact patent search expression
                  </ModalFieldLabel>
                  <ModalTextarea
                    id="workflow-source-query"
                    value={sourceQuery}
                    onChange={(event) => setSourceQuery(event.target.value)}
                    placeholder="For example: ti=(optical sensor)"
                    maxLength={1800}
                    rows={3}
                  />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <ModalFieldLabel htmlFor="workflow-source-jurisdiction">
                      Publication jurisdiction
                    </ModalFieldLabel>
                    <ModalSelect
                      id="workflow-source-jurisdiction"
                      value={sourceJurisdiction}
                      options={EPO_PUBLICATION_JURISDICTIONS}
                      onChange={setSourceJurisdiction}
                      placeholder="Select jurisdiction…"
                    />
                  </div>
                  <div>
                    <ModalFieldLabel htmlFor="workflow-source-as-of-date">
                      Search through date
                    </ModalFieldLabel>
                    <ModalTextInput
                      id="workflow-source-as-of-date"
                      type="date"
                      value={sourceAsOfDate}
                      max={currentIsoDate()}
                      onChange={(event) =>
                        setSourceAsOfDate(event.target.value)
                      }
                    />
                  </div>
                </div>
                <p className="text-xs leading-5 text-gray-500">
                  After the Work Task starts, Vera sends only this expression,
                  jurisdiction, date and bounded pagination fields to EPO OPS.
                  You will choose exact publications before any Matter import.
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── DOCUMENTS SCREEN ── */}
      {screen === "documents" && (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex min-h-0 flex-1 flex-col">
            <FileDirectory
              documents={usesMatter ? projectDocs : undefined}
              selectedDocuments={selectedDocuments}
              onChange={setSelectedDocuments}
              showTabs={!usesMatter}
            />
          </div>
        </div>
      )}
    </Modal>
  );
}
