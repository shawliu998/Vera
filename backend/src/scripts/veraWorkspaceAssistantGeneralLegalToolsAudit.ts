import assert from "node:assert/strict";

import type { AssistantToolContext } from "../lib/workspace/services/assistantRuntime";
import { reduceTabularStudioHandoff } from "../lib/workspace/tabularStudioHandoff";
import {
  AssistantGeneralLegalToolError,
  WorkspaceAssistantGeneralLegalToolModule,
} from "../lib/workspace/services/assistantGeneralLegalTools";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const JOB = "33333333-3333-4333-8333-333333333333";
const CHAT = "44444444-4444-4444-8444-444444444444";
const MODEL = "55555555-5555-4555-8555-555555555555";
const DOC = "66666666-6666-4666-8666-666666666666";
const VERSION = "77777777-7777-4777-8777-777777777777";
const DOC_2 = "88888888-8888-4888-8888-888888888888";
const VERSION_2 = "99999999-9999-4999-8999-999999999999";

function context(attempt = 1): AssistantToolContext {
  return {
    jobId: JOB,
    attempt,
    leaseOwner: "general-legal-audit",
    chatId: CHAT,
    projectId: PROJECT,
    modelProfileId: MODEL,
    documents: [
      { documentId: DOC, versionId: VERSION, attached: true },
      { documentId: DOC_2, versionId: VERSION_2, attached: true },
    ],
  };
}
class FakeTabular {
  readonly reviews = new Map<string, any>();
  creates = 0;
  get(id: string) {
    const review = this.reviews.get(id);
    if (!review) throw new Error("missing");
    return review;
  }
  createPresetReviewWithId(id: string, value: any) {
    this.creates += 1;
    const columns = value.columns.map((column: any, index: number) => ({
      id: `${id}:${index}`,
      key: column.key,
      title: column.title,
      prompt: column.prompt,
      outputType: column.outputType,
      ordinal: index,
    }));
    const review = {
      review: {
        id,
        projectId: value.projectId,
        workflowId: null,
        modelProfileId: value.modelProfileId,
        title: value.title,
        documentIds: value.documentIds,
        status: "draft",
      },
      columns,
      cells: value.documentIds.flatMap((documentId: string) =>
        columns.map((column: any) => ({
          id: `${documentId}:${column.id}`,
          documentId,
          columnId: column.id,
          status: "empty",
          error: null,
          value: null,
          content: null,
        })),
      ),
    };
    this.reviews.set(id, review);
    return review;
  }
  runReview(id: string) {
    const review = this.get(id);
    review.review.status = "running";
    for (const cell of review.cells) cell.status = "running";
    return { review };
  }
  cancelReview(id: string) {
    const review = this.get(id);
    review.review.status = "cancelled";
    for (const cell of review.cells) cell.status = "cancelled";
    return review;
  }
}
async function call(
  module: WorkspaceAssistantGeneralLegalToolModule,
  ctx: AssistantToolContext,
  name: string,
  input: Record<string, unknown>,
  id = `${name}-1`,
) {
  return module.execute({
    context: ctx,
    call: { id, name, input } as any,
    signal: new AbortController().signal,
  });
}
async function rejects(fn: () => Promise<unknown>) {
  await assert.rejects(fn, AssistantGeneralLegalToolError);
}

async function main() {
  const tabular = new FakeTabular();
  const writes: any[] = [];
  const tabularWrites: any[] = [];
  const module = new WorkspaceAssistantGeneralLegalToolModule(
    () => tabular as any,
    {
      maxWaitMs: 0,
      initialPollMs: 1,
      maxPollMs: 1,
      delay: async () => {},
      assertCurrentDocuments(projectId, docs) {
        assert.equal(projectId, PROJECT);
        assert.deepEqual(docs, [
          { documentId: DOC, versionId: VERSION },
          { documentId: DOC_2, versionId: VERSION_2 },
        ]);
      },
      async createDraft(_context, input) {
        writes.push(input);
        return {
          documentId: input.documentId,
          versionId: input.versionId,
          title: input.title,
        };
      },
      async createDraftFromTabularReview(_context, input) {
        tabularWrites.push(input);
        return {
          documentId: input.documentId,
          versionId: input.versionId,
          title: input.title,
        };
      },
    },
  );
  const tools = await module.registeredTools(context());
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [
      "run_custom_extraction",
      "create_legal_memo",
      "create_memo_from_tabular_review",
    ],
  );
  const extractionSchema = tools[0]?.inputSchema as any;
  assert.equal(extractionSchema.type, "object");
  assert.equal(extractionSchema.oneOf.length, 2);
  assert.deepEqual(
    extractionSchema.oneOf.map((branch: any) => branch.properties.mode.enum),
    [["custom"], ["timeline"]],
  );
  assert.deepEqual(extractionSchema.oneOf[0].required, [
    "mode",
    "title",
    "columns",
  ]);
  assert.deepEqual(extractionSchema.oneOf[1].required, ["mode"]);
  assert.equal(extractionSchema.oneOf[0].additionalProperties, false);
  assert.equal(extractionSchema.oneOf[1].additionalProperties, false);
  assert.equal(JSON.stringify(extractionSchema).includes('"preset"'), false);
  const custom = await call(module, context(), "run_custom_extraction", {
    mode: "custom",
    title: "Fact extraction",
    columns: [{ name: "Party", instruction: "Extract parties." }],
  });
  const customResult = JSON.parse(custom.content);
  assert.equal(customResult.review.status, "running");
  assert.equal(tabular.creates, 1);
  assert.equal(custom.events?.[0]?.type, "tabular_review_created");
  const replay = await call(module, context(), "run_custom_extraction", {
    title: "Fact extraction",
    columns: [{ name: "Party", instruction: "Extract parties." }],
  });
  assert.equal(
    JSON.parse(replay.content).review.review_id,
    customResult.review.review_id,
  );
  assert.equal(tabular.creates, 1);
  await rejects(() =>
    call(module, context(), "run_custom_extraction", {
      mode: "custom",
      title: "bad",
      columns: [
        { name: "Duplicate", instruction: "x" },
        { name: "duplicate", instruction: "y" },
      ],
    }),
  );
  const timeline = await call(
    module,
    context(),
    "run_custom_extraction",
    { mode: "timeline" },
    "timeline-call",
  );
  const timelineId = JSON.parse(timeline.content).review.review_id;
  assert.equal(tabular.get(timelineId).columns.length, 7);
  const legacyTimeline = await call(
    module,
    context(),
    "run_custom_extraction",
    { preset: "timeline" },
    "legacy-timeline-call",
  );
  assert.equal(JSON.parse(legacyTimeline.content).review.review_id, timelineId);
  assert.equal(tabular.creates, 2);
  await rejects(() => call(module, context(), "run_custom_extraction", {}));
  await rejects(() =>
    call(module, context(), "run_custom_extraction", {
      mode: "custom",
      title: "Missing columns",
    }),
  );
  await rejects(() =>
    call(module, context(), "run_custom_extraction", {
      mode: "timeline",
      columns: [{ name: "Unexpected", instruction: "Reject this." }],
    }),
  );
  await rejects(() =>
    call(module, context(), "run_custom_extraction", {
      mode: "other",
    }),
  );
  await rejects(() =>
    call(module, context(), "run_custom_extraction", {
      mode: "timeline",
      preset: "timeline",
    }),
  );
  await rejects(() =>
    call(module, context(), "create_memo_from_tabular_review", {
      review_id: customResult.review.review_id,
    }),
  );
  const completed = tabular.get(customResult.review.review_id);
  completed.review.status = "complete";
  for (const cell of completed.cells) {
    cell.status = "complete";
    cell.content = { summary: "Acme Ltd." };
  }
  const customReduced = reduceTabularStudioHandoff(
    {
      kind: "custom_extraction_summary",
      detail: completed,
      source: {
        orderedUniqueSources: [
          {
            documentId: DOC,
            versionId: VERSION,
            chunkId: "chunk-1",
            quote: "Acme Ltd.",
            startOffset: 0,
            endOffset: 9,
          },
        ],
      },
    } as any,
    { projectId: PROJECT, title: "Extraction summary" },
  );
  assert.equal(customReduced.documentType, "general_legal_document");
  assert.match(customReduced.content, /\| Source document \| Party \|/);
  assert.match(customReduced.content, /Acme Ltd\./);
  assert.match(customReduced.content, /\[1\]/);
  const lifecycle = await module.settleLifecycle?.({
    phase: "after_execution",
    context: context(),
    call: {
      id: "run_custom_extraction-1",
      name: "run_custom_extraction",
      input: {},
    } as any,
    result: custom,
    signal: new AbortController().signal,
  });
  assert.equal(
    JSON.parse(lifecycle?.replacementContent ?? "{}").review.status,
    "complete",
  );
  const memo = await call(
    module,
    context(),
    "create_memo_from_tabular_review",
    { review_id: customResult.review.review_id },
  );
  assert.equal(
    JSON.parse(memo.content).memo.draft_id,
    tabularWrites[0].documentId,
  );
  assert.equal(tabularWrites[0].reviewId, customResult.review.review_id);
  assert.equal(tabularWrites[0].kind, "custom_extraction_summary");
  const completedTimeline = tabular.get(timelineId);
  completedTimeline.review.status = "complete";
  const timelineValues: Record<string, string> = {
    Date: "2026-01-12",
    Event: "The claimant sent a payment demand.",
    Participants: "Claimant; Respondent",
    "Source file": "demand-letter.pdf",
    "Original evidence": "Payment is due within seven days.",
    "Potential significance": "May establish notice before filing.",
    "Open questions": "Confirm the delivery receipt.",
  };
  for (const cell of completedTimeline.cells) {
    const column = completedTimeline.columns.find(
      (candidate: any) => candidate.id === cell.columnId,
    );
    cell.status = "complete";
    cell.content = { summary: timelineValues[column.title] };
  }
  const timelineReduced = reduceTabularStudioHandoff(
    {
      kind: "case_fact_summary",
      detail: completedTimeline,
      source: {
        orderedUniqueSources: [
          {
            documentId: DOC,
            versionId: VERSION,
            chunkId: "chunk-2",
            quote: "Payment is due within seven days.",
            startOffset: 0,
            endOffset: 34,
          },
        ],
      },
    } as any,
    { projectId: PROJECT, title: "Matter facts" },
  );
  assert.equal(timelineReduced.documentType, "general_legal_document");
  assert.match(timelineReduced.content, /## 核心时间线/);
  assert.match(timelineReduced.content, /Payment is due within seven days\./);
  assert.match(timelineReduced.content, /## 证据引用/);
  const factSummary = await call(
    module,
    context(),
    "create_memo_from_tabular_review",
    { review_id: timelineId },
    "timeline-memo",
  );
  assert.equal(
    JSON.parse(factSummary.content).memo.draft_id,
    tabularWrites[1].documentId,
  );
  assert.equal(tabularWrites[1].reviewId, timelineId);
  assert.equal(tabularWrites[1].kind, "case_fact_summary");
  assert.match(tabularWrites[1].title, /案件事实摘要/);
  const direct = await call(module, context(), "create_legal_memo", {
    title: "Legal note",
    documentType: "general_legal_document",
    contentMarkdown: "# Note",
  });
  assert.equal(JSON.parse(direct.content).memo.title, "Legal note");
  assert.equal(writes.length, 1);
  assert.equal(tabularWrites.length, 2);
  await module.registeredTools(context(2));
  await rejects(() => module.registeredTools(context(1)));
  const foreign = new WorkspaceAssistantGeneralLegalToolModule(
    () => tabular as any,
    {
      assertCurrentDocuments(projectId) {
        if (projectId === OTHER) throw new Error("foreign");
      },
      async createDraft() {
        throw new Error("not reached");
      },
      async createDraftFromTabularReview() {
        throw new Error("not reached");
      },
    },
  );
  await foreign.registeredTools({ ...context(), projectId: OTHER });
  await rejects(() =>
    call(
      foreign,
      { ...context(), projectId: OTHER },
      "create_memo_from_tabular_review",
      { review_id: customResult.review.review_id },
    ),
  );
  console.log(
    "veraWorkspaceAssistantGeneralLegalToolsAudit passed: custom and timeline extraction, deterministic replay, lifecycle settlement, deterministic case fact summary, generation fencing, completed-review memo origin, direct memo, and input rejection.",
  );
}
void main();
