"use client";

import type {
  AletheiaAgentRunBudget,
  AletheiaAgentRunRecord,
  AletheiaHumanCheckpointRecord,
  AletheiaMatterDetail,
  AletheiaWorkflowGraph,
} from "@/app/lib/aletheiaApi";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { titleize, traceStatusClass } from "./remoteMatterTransforms";

type TraceCounts = {
  steps: number;
  tools: number;
  checkpoints: number;
};

interface RemoteMatterRunTraceProps {
  detail: AletheiaMatterDetail;
  latestAgentRun: AletheiaAgentRunRecord | null;
  latestTraceCounts: TraceCounts;
  decidingApprovalId: string | null;
  onDecideApproval: (
    checkpoint: AletheiaHumanCheckpointRecord,
    decision: "approved" | "rejected" | "edited" | "responded",
  ) => void;
  onResumeAgentRun: (checkpoint: AletheiaHumanCheckpointRecord) => void;
}

function canDecideCheckpoint(checkpoint: AletheiaHumanCheckpointRecord) {
  return (
    checkpoint.status === "open" &&
    [
      "audit_pack_export",
      "feedback_dataset_export",
      "final_memo_export",
    ].includes(checkpoint.checkpoint_type)
  );
}

function canResumeCheckpoint(checkpoint: AletheiaHumanCheckpointRecord) {
  return (
    checkpoint.status === "resolved" &&
    (checkpoint.decision === "edited" || checkpoint.decision === "responded")
  );
}

function metricNumber(metrics: Record<string, unknown>, key: string) {
  const value = metrics[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function budgetValue(
  budget: AletheiaAgentRunBudget | undefined,
  key: keyof AletheiaAgentRunBudget,
) {
  const value = budget?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatWallTime(ms: number | null) {
  if (ms === null) return "unset";
  if (ms >= 60000) return `${Math.round(ms / 60000)}m`;
  return `${Math.round(ms / 1000)}s`;
}

function workflowGraphFromRun(
  run: AletheiaAgentRunRecord,
): AletheiaWorkflowGraph | null {
  const graph = run.metadata.workflowGraph;
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    return null;
  }
  return graph;
}

export function RemoteMatterRunTrace({
  detail,
  latestAgentRun,
  latestTraceCounts,
  decidingApprovalId,
  onDecideApproval,
  onResumeAgentRun,
}: RemoteMatterRunTraceProps) {
  const workflowGraph = latestAgentRun
    ? workflowGraphFromRun(latestAgentRun)
    : null;

  return (
    <section
      data-testid="aletheia-run-trace"
      className="rounded-lg border border-[#e5e7eb] bg-white p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase text-[#9ca3af]">
            Agent Runtime
          </p>
          <h2 className="mt-1 text-lg font-semibold">Run Trace</h2>
        </div>
        {latestAgentRun && (
          <Badge
            variant="outline"
            className={`rounded-md ${traceStatusClass(latestAgentRun.status)}`}
          >
            {titleize(latestAgentRun.status)}
          </Badge>
        )}
      </div>

      {!latestAgentRun ? (
        <p className="mt-4 rounded-md border border-dashed border-[#d1d5db] p-4 text-sm text-[#6b7280]">
          No agent run trace yet. Queue an agent run to create a reviewable
          runtime record.
        </p>
      ) : (
        <div className="mt-4 space-y-4">
          <div className="grid gap-3 md:grid-cols-3">
            {[
              { label: "Steps", value: latestTraceCounts.steps },
              { label: "Tool calls", value: latestTraceCounts.tools },
              {
                label: "Human checkpoints",
                value: latestTraceCounts.checkpoints,
              },
            ].map((item) => (
              <div
                key={item.label}
                className="rounded-md border border-[#e5e7eb] p-3"
              >
                <p className="text-2xl font-semibold">{item.value}</p>
                <p className="mt-1 text-sm text-[#6b7280]">{item.label}</p>
              </div>
            ))}
          </div>

          <div className="grid gap-3 md:grid-cols-4">
            {[
              {
                label: "Max steps",
                value: budgetValue(latestAgentRun.budget, "maxSteps"),
              },
              {
                label: "Max tool calls",
                value: budgetValue(latestAgentRun.budget, "maxToolCalls"),
              },
              {
                label: "Max tokens",
                value:
                  budgetValue(latestAgentRun.budget, "maxTokens") ?? "unset",
              },
              {
                label: "Wall time",
                value: formatWallTime(
                  budgetValue(latestAgentRun.budget, "maxWallTimeMs"),
                ),
              },
            ].map((item) => (
              <div
                key={item.label}
                className="rounded-md border border-[#e5e7eb] bg-[#f9fafb] p-3"
              >
                <p className="text-sm font-semibold">{item.value}</p>
                <p className="mt-1 text-xs text-[#6b7280]">{item.label}</p>
              </div>
            ))}
          </div>

          {workflowGraph && (
            <div className="rounded-md border border-[#dbe7e2] bg-[#f7fbf9] p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-xs font-semibold uppercase text-[#6b8a7d]">
                    Workflow Graph
                  </p>
                  <h3 className="mt-1 text-sm font-semibold text-[#1f2937]">
                    Directed runtime topology
                  </h3>
                </div>
                <Badge
                  variant="outline"
                  className="rounded-md border-[#b7c9c2] text-[#315a51]"
                >
                  {workflowGraph.nodes.length} nodes ·{" "}
                  {workflowGraph.edges.length} edges
                </Badge>
              </div>
              <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                {workflowGraph.nodes.map((node) => {
                  const outgoingEdges = workflowGraph.edges.filter(
                    (edge) => edge.from === node.key,
                  );
                  return (
                    <div
                      key={`${node.key}-${node.sequence}`}
                      className="rounded-md border border-[#dbe7e2] bg-white p-3"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="text-xs text-[#6b7280]">
                            Node {node.sequence} · {node.key}
                          </p>
                          <p className="mt-1 text-sm font-semibold text-[#1f2937]">
                            {node.title}
                          </p>
                        </div>
                        <Badge
                          variant="outline"
                          className={`rounded-md ${traceStatusClass(node.status)}`}
                        >
                          {titleize(node.type)}
                        </Badge>
                      </div>
                      {node.specialistRole && (
                        <p className="mt-2 text-xs text-[#315a51]">
                          {node.specialistRole}
                        </p>
                      )}
                      {node.allowedTools && node.allowedTools.length > 0 && (
                        <p className="mt-1 text-xs text-[#6b7280]">
                          tools: {node.allowedTools.join(", ")}
                        </p>
                      )}
                      {outgoingEdges.length > 0 && (
                        <div className="mt-2 space-y-1">
                          {outgoingEdges.map((edge) => (
                            <p
                              key={`${edge.from}-${edge.to}-${edge.condition}`}
                              className="text-xs text-[#6b7280]"
                            >
                              {"->"} {edge.to} · {titleize(edge.condition)}
                            </p>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="space-y-3">
            {(latestAgentRun.steps ?? []).map((step) => {
              const toolCalls = (latestAgentRun.tool_calls ?? []).filter(
                (call) => call.step_id === step.id,
              );
              const checkpoints = (
                latestAgentRun.human_checkpoints ?? []
              ).filter((checkpoint) => checkpoint.step_id === step.id);
              const workProductKind =
                typeof step.output.workProductKind === "string"
                  ? step.output.workProductKind
                  : null;
              const specialistRole =
                typeof step.output.specialistRole === "string"
                  ? step.output.specialistRole
                  : null;
              const allowedTools = Array.isArray(step.output.allowedTools)
                ? step.output.allowedTools.filter(
                    (tool): tool is string => typeof tool === "string",
                  )
                : [];
              const auditEventName =
                typeof step.output.auditEvent === "string"
                  ? step.output.auditEvent
                  : (toolCalls
                      .map((call) => call.output.auditEvent)
                      .find(
                        (value): value is string => typeof value === "string",
                      ) ?? null);
              const linkedWorkProducts = workProductKind
                ? detail.workProducts.filter(
                    (item) => item.kind === workProductKind,
                  )
                : [];
              const linkedAuditEvents = auditEventName
                ? detail.auditEvents.filter(
                    (event) => event.action === auditEventName,
                  )
                : [];

              return (
                <div
                  key={step.id}
                  className="rounded-md border border-[#e5e7eb] p-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-xs text-[#9ca3af]">
                        Step {step.sequence} · {step.step_key}
                      </p>
                      <h3 className="mt-1 text-sm font-semibold">
                        {step.title}
                      </h3>
                    </div>
                    <Badge
                      variant="outline"
                      className={`rounded-md ${traceStatusClass(step.status)}`}
                    >
                      {titleize(step.status)}
                    </Badge>
                  </div>

                  {typeof step.output.result === "string" && (
                    <p className="mt-2 text-sm leading-5 text-[#6b7280]">
                      {step.output.result}
                    </p>
                  )}
                  {specialistRole && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Badge
                        variant="outline"
                        className="rounded-md border-[#b7c9c2] text-[#315a51]"
                      >
                        {specialistRole}
                      </Badge>
                      {allowedTools.length > 0 && (
                        <span className="text-xs text-[#6b7280]">
                          allowed tools: {allowedTools.join(", ")}
                        </span>
                      )}
                    </div>
                  )}
                  {metricNumber(step.metrics, "durationMs") !== null && (
                    <p className="mt-2 text-xs text-[#9ca3af]">
                      step duration {metricNumber(step.metrics, "durationMs")}{" "}
                      ms
                    </p>
                  )}

                  {toolCalls.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {toolCalls.map((call) => (
                        <span
                          key={call.id}
                          className={`inline-flex items-center rounded-md border px-2 py-1 text-xs ${traceStatusClass(call.status)}`}
                        >
                          {call.tool_name} · {call.risk_level}
                          {metricNumber(call.metrics, "durationMs") !== null
                            ? ` · ${metricNumber(call.metrics, "durationMs")} ms`
                            : ""}
                        </span>
                      ))}
                    </div>
                  )}

                  {(linkedWorkProducts.length > 0 ||
                    linkedAuditEvents.length > 0) && (
                    <div className="mt-3 rounded-md border border-[#e5e7eb] bg-[#f9fafb] p-3">
                      <p className="text-xs font-semibold uppercase text-[#9ca3af]">
                        Linked Artifacts
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {linkedWorkProducts.map((product) => (
                          <span
                            key={product.id}
                            className="inline-flex items-center rounded-md border border-[#d1d5db] bg-white px-2 py-1 text-xs text-[#374151]"
                          >
                            {titleize(product.kind)} ·{" "}
                            {titleize(product.status)}
                          </span>
                        ))}
                        {linkedAuditEvents.map((event) => (
                          <span
                            key={event.id}
                            className="inline-flex items-center rounded-md border border-[#d1d5db] bg-white px-2 py-1 text-xs text-[#374151]"
                          >
                            audit · {titleize(event.action)}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {checkpoints.map((checkpoint) => (
                    <div
                      key={checkpoint.id}
                      data-testid={`checkpoint-${checkpoint.checkpoint_type}`}
                      className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-semibold text-amber-900">
                          {titleize(checkpoint.checkpoint_type)}
                        </p>
                        <Badge
                          variant="outline"
                          className={`rounded-md ${traceStatusClass(checkpoint.status)}`}
                        >
                          {titleize(checkpoint.status)}
                        </Badge>
                      </div>
                      <p className="mt-2 text-sm leading-5 text-amber-900">
                        {checkpoint.prompt}
                      </p>
                      {canDecideCheckpoint(checkpoint) && (
                        <div className="mt-3 flex flex-wrap gap-2">
                          <Button
                            data-testid={`approve-${checkpoint.checkpoint_type}`}
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={decidingApprovalId === checkpoint.id}
                            onClick={() =>
                              onDecideApproval(checkpoint, "approved")
                            }
                            className="border-emerald-200 text-emerald-800 hover:bg-emerald-50"
                          >
                            Approve
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={decidingApprovalId === checkpoint.id}
                            onClick={() =>
                              onDecideApproval(checkpoint, "rejected")
                            }
                            className="border-red-200 text-red-700 hover:bg-red-50"
                          >
                            Reject
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={decidingApprovalId === checkpoint.id}
                            onClick={() =>
                              onDecideApproval(checkpoint, "edited")
                            }
                            className="border-sky-200 text-sky-800 hover:bg-sky-50"
                          >
                            Edit
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={decidingApprovalId === checkpoint.id}
                            onClick={() =>
                              onDecideApproval(checkpoint, "responded")
                            }
                            className="border-[#d1d5db] text-[#374151] hover:bg-white"
                          >
                            Respond
                          </Button>
                        </div>
                      )}
                      {canResumeCheckpoint(checkpoint) && (
                        <div className="mt-3">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={decidingApprovalId === checkpoint.id}
                            onClick={() => onResumeAgentRun(checkpoint)}
                            className="border-[#b7c9c2] text-[#315a51] hover:bg-[#eef6f2]"
                          >
                            Resume Run
                          </Button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
