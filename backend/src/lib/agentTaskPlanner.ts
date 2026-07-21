import { z } from "zod";
import { completeText } from "./llm";
import { createServerSupabase } from "./supabase";
import { SYSTEM_WORKFLOWS } from "./systemWorkflows";
import { getUserModelSettings } from "./userSettings";

type Db = ReturnType<typeof createServerSupabase>;

export type AgentTaskStepCapability =
  | "read_sources"
  | "analyze"
  | "create_tabular"
  | "create_draft"
  | "verify";

export type AgentTaskPlanStep = {
  capability: AgentTaskStepCapability;
  title: string;
  expected_output: string;
};

export type AgentTaskDeliverableDefinition = {
  key: string;
  title: string;
  description: string;
  required: true;
  artifact_type: "draft" | "tabular_review";
  purpose: string;
};

export type GoalAwareTaskPlan = {
  steps: AgentTaskPlanStep[];
  deliverables: AgentTaskDeliverableDefinition[];
};

export type AgentTaskPlanningRequest = {
  document_ids: string[];
  workflow_id?: string;
};

export type AgentWorkflowConstraint = {
  id: string;
  title: string;
  description: string;
  type: "assistant" | "tabular";
  instructions: string;
  columns: string[];
};

type GoalProfile =
  | "contract_review"
  | "compare"
  | "extract"
  | "draft"
  | "proofread"
  | "generic";

const stepSchema = z
  .object({
    capability: z.enum([
      "read_sources",
      "analyze",
      "create_tabular",
      "create_draft",
      "verify",
    ]),
    title: z.string().trim().min(3).max(80),
    expected_output: z.string().trim().min(8).max(500),
  })
  .strict();

const deliverableSchema = z
  .object({
    key: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(48),
    title: z.string().trim().min(2).max(80),
    description: z.string().trim().min(4).max(240),
    required: z.literal(true),
    artifact_type: z.enum(["draft", "tabular_review"]),
    purpose: z.string().trim().min(2).max(80),
  })
  .strict();

const planSchema = z
  .object({
    steps: z.array(stepSchema).min(3).max(6),
    deliverables: z.array(deliverableSchema).min(1).max(3),
  })
  .strict();

const PROHIBITED_PLAN_LANGUAGE =
  /guarantee(?:d)? legal (?:result|conclusion)|certif(?:y|ied) legal|verify lawyer licen[cs]e|send (?:an )?email|publish externally|upload to (?:dropbox|google drive|sharepoint)|request new permission|invoke [a-z0-9_-]+ api/i;

function wantsSummary(goal: string) {
  return /summary|memo|report|takeaway|摘要|总结|备忘录|报告/i.test(goal);
}

function wantsTable(goal: string) {
  if (
    /(?:do not|don't|without|no need to|must not|should not).{0,32}(?:table|matrix|excel|spreadsheet)|(?:不要|无需|不需要|不得|仅限).{0,20}(?:表格|矩阵|Excel|电子表格)/i.test(
      goal,
    )
  ) {
    return false;
  }
  return /table|matrix|excel|spreadsheet|表格|矩阵|清单/i.test(goal);
}

export function inferGoalProfile(
  goal: string,
  workflowId?: string,
): GoalProfile {
  if (workflowId === "builtin-proofread") return "proofread";
  if (workflowId === "builtin-compare-documents") return "compare";
  if (workflowId === "builtin-extract-key-terms") return "extract";
  if (workflowId === "builtin-draft-from-template") return "draft";
  if (/proofread|copyedit|校对|纠错|文字润色/i.test(goal)) return "proofread";
  if (/compare|comparison|redline|差异|比较|对比/i.test(goal)) return "compare";
  if (
    /extract.{0,24}(?:term|obligation)|key terms?|obligations?|提取.{0,16}(?:条款|义务)|关键条款/i.test(
      goal,
    )
  ) {
    return "extract";
  }
  if (
    /review.{0,24}(?:contract|agreement)|(?:contract|agreement).{0,24}review|合同.{0,16}审查|审查.{0,16}合同/i.test(
      goal,
    )
  ) {
    return "contract_review";
  }
  if (/draft|template|起草|模板|撰写|备忘录|memo/i.test(goal)) return "draft";
  return "generic";
}

function deliverable(
  key: string,
  title: string,
  description: string,
  artifactType: "draft" | "tabular_review",
  purpose: string,
): AgentTaskDeliverableDefinition {
  return {
    key,
    title,
    description,
    required: true,
    artifact_type: artifactType,
    purpose,
  };
}

function step(
  capability: AgentTaskStepCapability,
  title: string,
  expectedOutput: string,
): AgentTaskPlanStep {
  return { capability, title, expected_output: expectedOutput };
}

export function buildGoalAwareFallbackPlan(input: {
  goal: string;
  hasSources: boolean;
  workflowId?: string;
  workflowType?: "assistant" | "tabular";
}): GoalAwareTaskPlan {
  const profile = inferGoalProfile(input.goal, input.workflowId);
  const read = (title = "Read source documents") =>
    step(
      "read_sources",
      title,
      "Read every selected source and preserve stable source references.",
    );
  const verify = step(
    "verify",
    "Verify deliverables",
    "Check goal coverage, required files, source support, citations, and incomplete steps.",
  );

  if (profile === "contract_review") {
    return {
      steps: [
        read("Read contract sources"),
        step(
          "analyze",
          "Analyze contract positions",
          "Separate verified terms, risks, recommendations, and open questions.",
        ),
        step(
          "create_tabular",
          "Create risk matrix",
          "Create the required Risk matrix as an Excel workbook with source locations.",
        ),
        step(
          "create_draft",
          "Draft review memo",
          "Create the required Review memo as a source-linked Word document.",
        ),
        verify,
      ],
      deliverables: [
        deliverable(
          "risk-matrix",
          "Risk matrix",
          "Clause findings, risk, recommendation, and source.",
          "tabular_review",
          "Risk matrix",
        ),
        deliverable(
          "review-memo",
          "Review memo",
          "Facts, analysis, recommendations, and open questions.",
          "draft",
          "Review memo draft",
        ),
      ],
    };
  }

  if (profile === "compare") {
    return {
      steps: [
        read("Read documents to compare"),
        step(
          "analyze",
          "Compare material positions",
          "Identify aligned and divergent terms with a source location in each document.",
        ),
        step(
          "create_tabular",
          "Create comparison matrix",
          "Create the required Comparison matrix as an Excel workbook.",
        ),
        step(
          "create_draft",
          "Draft comparison summary",
          "Create the required Comparison summary memo as a concise Word document.",
        ),
        verify,
      ],
      deliverables: [
        deliverable(
          "comparison-matrix",
          "Comparison matrix",
          "Side-by-side terms, differences, significance, and sources.",
          "tabular_review",
          "Comparison matrix",
        ),
        deliverable(
          "comparison-summary",
          "Comparison summary",
          "Key differences and follow-up points.",
          "draft",
          "Comparison summary memo",
        ),
      ],
    };
  }

  if (profile === "extract") {
    const summaryRequested = wantsSummary(input.goal);
    return {
      steps: [
        read("Read sources for extraction"),
        step(
          "create_tabular",
          "Create key terms table",
          "Create the required Key terms table as an Excel workbook with source locations.",
        ),
        ...(summaryRequested
          ? [
              step(
                "create_draft" as const,
                "Draft key terms summary",
                "Create the required Key terms summary as a concise Word document.",
              ),
            ]
          : []),
        verify,
      ],
      deliverables: [
        deliverable(
          "key-terms-table",
          "Key terms table",
          "Structured terms or obligations with values and sources.",
          "tabular_review",
          "Key terms table",
        ),
        ...(summaryRequested
          ? [
              deliverable(
                "key-terms-summary",
                "Key terms summary",
                "Concise summary of material extracted terms.",
                "draft",
                "Key terms summary",
              ),
            ]
          : []),
      ],
    };
  }

  if (profile === "proofread") {
    return {
      steps: [
        read("Read document to proofread"),
        step(
          "analyze",
          "Identify drafting corrections",
          "Identify mechanical, consistency, cross-reference, numbering, and formatting corrections.",
        ),
        step(
          "create_draft",
          "Create revised document",
          "Create the required Revised document as a Word file and summarize material changes.",
        ),
        verify,
      ],
      deliverables: [
        deliverable(
          "revised-document",
          "Revised document",
          "Proofread Word draft with the requested corrections.",
          "draft",
          "Revised document",
        ),
      ],
    };
  }

  if (profile === "draft") {
    const includeTable = wantsTable(input.goal);
    return {
      steps: [
        input.hasSources
          ? read("Read drafting sources")
          : step(
              "analyze",
              "Review drafting instructions",
              "Identify the requested document, audience, supplied facts, and unresolved placeholders.",
            ),
        step(
          "create_draft",
          "Draft requested document",
          "Create the required Requested draft as a Word document without inventing missing facts.",
        ),
        ...(includeTable
          ? [
              step(
                "create_tabular" as const,
                "Create requested table",
                "Create the required Supporting table as an Excel workbook.",
              ),
            ]
          : [
              step(
                "analyze" as const,
                "Check draft completeness",
                "Check the draft against the goal, source material, and unresolved placeholders.",
              ),
            ]),
        verify,
      ],
      deliverables: [
        deliverable(
          "requested-draft",
          "Requested draft",
          "Word draft requested by the user.",
          "draft",
          "Requested draft",
        ),
        ...(includeTable
          ? [
              deliverable(
                "supporting-table",
                "Supporting table",
                "Table expressly requested with the draft.",
                "tabular_review",
                "Supporting table",
              ),
            ]
          : []),
      ],
    };
  }

  const tabularWorkflow = input.workflowType === "tabular";
  return {
    steps: [
      input.hasSources
        ? read()
        : step(
            "analyze",
            "Review work objective",
            "Identify the requested outcome, supplied facts, and unresolved inputs.",
          ),
      step(
        tabularWorkflow ? "create_tabular" : "create_draft",
        tabularWorkflow
          ? "Create structured work product"
          : "Draft work product",
        tabularWorkflow
          ? "Create the required Work product table as an Excel workbook."
          : "Create the required Work product as a concise Word document.",
      ),
      verify,
    ],
    deliverables: [
      tabularWorkflow
        ? deliverable(
            "work-product-table",
            "Work product table",
            "Structured output aligned to the selected workflow.",
            "tabular_review",
            "Work product table",
          )
        : deliverable(
            "work-product",
            "Work product",
            "Document aligned to the stated objective.",
            "draft",
            "Work product draft",
          ),
    ],
  };
}

function planJson(raw: string) {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const source =
    fenced ?? raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  if (!source.trim()) throw new Error("Planner returned no JSON object");
  return JSON.parse(source) as unknown;
}

function assertGoalPolicy(
  plan: GoalAwareTaskPlan,
  input: { goal: string; workflowId?: string },
) {
  const profile = inferGoalProfile(input.goal, input.workflowId);
  const types = plan.deliverables.map((item) => item.artifact_type);
  const draftCount = types.filter((type) => type === "draft").length;
  const tableCount = types.filter((type) => type === "tabular_review").length;
  const deliverableText = plan.deliverables
    .map(
      (item) => `${item.key} ${item.title} ${item.description} ${item.purpose}`,
    )
    .join(" ");
  if (["contract_review", "compare"].includes(profile)) {
    if (draftCount !== 1 || tableCount !== 1) {
      throw new Error("This goal requires one Word and one Excel deliverable");
    }
    if (
      profile === "contract_review" &&
      (!/risk|风险/i.test(
        plan.deliverables
          .filter((item) => item.artifact_type === "tabular_review")
          .map((item) => `${item.title} ${item.purpose}`)
          .join(" "),
      ) ||
        !/review|memo|审查|备忘录/i.test(
          plan.deliverables
            .filter((item) => item.artifact_type === "draft")
            .map((item) => `${item.title} ${item.purpose}`)
            .join(" "),
        ))
    ) {
      throw new Error(
        "Contract review outputs must be a risk table and review memo",
      );
    }
    if (
      profile === "compare" &&
      !/compar|difference|对比|比较|差异/i.test(deliverableText)
    ) {
      throw new Error(
        "Comparison outputs must describe the requested comparison",
      );
    }
  } else if (profile === "extract") {
    if (tableCount !== 1 || draftCount !== (wantsSummary(input.goal) ? 1 : 0)) {
      throw new Error(
        "Extraction deliverables do not match the requested scope",
      );
    }
    if (!/term|obligation|条款|义务/i.test(deliverableText)) {
      throw new Error("Extraction outputs must describe terms or obligations");
    }
  } else if (["draft", "proofread"].includes(profile)) {
    if (draftCount !== 1 || (!wantsTable(input.goal) && tableCount > 0)) {
      throw new Error("Drafting deliverables do not match the requested scope");
    }
    if (
      profile === "proofread" &&
      !/revis|proofread|correct|校对|修订|更正/i.test(deliverableText)
    ) {
      throw new Error("Proofreading must produce a revised document");
    }
  }
}

export function validateGoalAwarePlan(
  value: unknown,
  input: { goal: string; hasSources: boolean; workflowId?: string },
): GoalAwareTaskPlan {
  const plan = planSchema.parse(value) as GoalAwareTaskPlan;
  if (plan.steps.at(-1)?.capability !== "verify") {
    throw new Error("The final step must verify deliverables");
  }
  if (plan.steps.at(-1)?.title !== "Verify deliverables") {
    throw new Error('The final step title must be "Verify deliverables"');
  }
  if (plan.steps.slice(0, -1).some((item) => item.capability === "verify")) {
    throw new Error("Verify deliverables may appear only as the final step");
  }
  if (input.hasSources && plan.steps[0]?.capability !== "read_sources") {
    throw new Error("Selected sources must be read first");
  }
  const keys = new Set(plan.deliverables.map((item) => item.key));
  const purposes = new Set(plan.deliverables.map((item) => item.purpose));
  if (
    keys.size !== plan.deliverables.length ||
    purposes.size !== plan.deliverables.length
  ) {
    throw new Error("Deliverable keys and purposes must be unique");
  }
  for (const item of plan.deliverables) {
    const capability =
      item.artifact_type === "draft" ? "create_draft" : "create_tabular";
    if (!plan.steps.some((candidate) => candidate.capability === capability)) {
      throw new Error(`No executable step creates ${item.title}`);
    }
  }
  if (PROHIBITED_PLAN_LANGUAGE.test(JSON.stringify(plan))) {
    throw new Error(
      "Planner proposed an unsupported external or guaranteed action",
    );
  }
  assertGoalPolicy(plan, input);
  return plan;
}

export function parseGoalAwarePlan(
  raw: string,
  input: { goal: string; hasSources: boolean; workflowId?: string },
) {
  return validateGoalAwarePlan(planJson(raw), input);
}

export function planAgentTaskFromOutput(
  raw: string,
  input: {
    goal: string;
    hasSources: boolean;
    workflowId?: string;
    workflowType?: "assistant" | "tabular";
  },
) {
  try {
    return {
      plan: parseGoalAwarePlan(raw, input),
      source: "model" as const,
    };
  } catch {
    return {
      plan: buildGoalAwareFallbackPlan(input),
      source: "fallback" as const,
    };
  }
}

export function readAgentTaskPlanningRequest(task: {
  latest_checkpoint?: unknown;
}): AgentTaskPlanningRequest | null {
  const checkpoint = task.latest_checkpoint;
  if (!checkpoint || typeof checkpoint !== "object") return null;
  const request = (checkpoint as { planner_request?: unknown }).planner_request;
  if (!request || typeof request !== "object") return null;
  const row = request as Record<string, unknown>;
  const documentIds = Array.isArray(row.document_ids)
    ? row.document_ids.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  return {
    document_ids: documentIds,
    ...(typeof row.workflow_id === "string" && row.workflow_id
      ? { workflow_id: row.workflow_id }
      : {}),
  };
}

export async function resolveAgentWorkflowConstraint(input: {
  db: Db;
  workflowId?: string;
  userId: string;
  userEmail?: string;
}): Promise<AgentWorkflowConstraint | null> {
  if (!input.workflowId) return null;
  const system = SYSTEM_WORKFLOWS.find((item) => item.id === input.workflowId);
  if (system) {
    return {
      id: system.id,
      title: system.metadata.title,
      description: system.metadata.description ?? "",
      type: system.metadata.type,
      instructions: system.skill_md ?? "",
      columns: (system.columns_config ?? []).map((column) => column.name),
    };
  }

  const { data: workflow, error } = await input.db
    .from("workflows")
    .select("id,user_id,title,type,prompt_md,columns_config")
    .eq("id", input.workflowId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!workflow) return null;
  let allowed = workflow.user_id === input.userId;
  const email = (input.userEmail ?? "").trim().toLowerCase();
  if (!allowed && email) {
    const { data: share, error: shareError } = await input.db
      .from("workflow_shares")
      .select("workflow_id")
      .eq("workflow_id", input.workflowId)
      .eq("shared_with_email", email)
      .maybeSingle();
    if (shareError) throw new Error(shareError.message);
    allowed = Boolean(share);
  }
  if (!allowed) return null;
  const columns = Array.isArray(workflow.columns_config)
    ? workflow.columns_config.flatMap((column) => {
        if (!column || typeof column !== "object") return [];
        const name = (column as { name?: unknown }).name;
        return typeof name === "string" ? [name] : [];
      })
    : [];
  return {
    id: workflow.id as string,
    title: String(workflow.title ?? "Workflow"),
    description: "",
    type: workflow.type === "tabular" ? "tabular" : "assistant",
    instructions: String(workflow.prompt_md ?? ""),
    columns,
  };
}

function plannerPrompt(input: {
  goal: string;
  documents: string[];
  workflow: AgentWorkflowConstraint | null;
}) {
  const workflow = input.workflow
    ? [
        `Title: ${input.workflow.title}`,
        `Description: ${input.workflow.description || "None"}`,
        `Type: ${input.workflow.type}`,
        input.workflow.columns.length
          ? `Columns: ${input.workflow.columns.join(", ")}`
          : "",
        input.workflow.instructions
          ? `Instructions:\n${input.workflow.instructions.slice(0, 8_000)}`
          : "",
      ]
        .filter(Boolean)
        .join("\n")
    : "None";
  return [
    `USER GOAL\n${input.goal}`,
    `SELECTED SOURCES\n${input.documents.length ? input.documents.map((name) => `- ${name}`).join("\n") : "None"}`,
    `SELECTED MIKE WORKFLOW\n${workflow}`,
    "Return one JSON object only. Use 3-6 short steps. Each step must have capability, title, expected_output. Allowed capabilities: read_sources, analyze, create_tabular, create_draft, verify. If sources are selected, read_sources must be first. The last step must be capability verify with the exact title Verify deliverables. Deliverables must use only artifact_type draft or tabular_review, must be required, and must correspond to a create step. Use existing Word/Excel capabilities only. Do not invent tools, permissions, external systems, professional credentials, or guaranteed legal conclusions.",
    'JSON shape: {"steps":[{"capability":"read_sources","title":"...","expected_output":"..."}],"deliverables":[{"key":"slug","title":"...","description":"...","required":true,"artifact_type":"draft","purpose":"..."}]}.',
  ].join("\n\n");
}

export async function planAgentTask(input: {
  db: Db;
  userId: string;
  userEmail?: string;
  matterId: string;
  goal: string;
  model: string;
  request: AgentTaskPlanningRequest;
  complete?: typeof completeText;
}) {
  const workflow = await resolveAgentWorkflowConstraint({
    db: input.db,
    workflowId: input.request.workflow_id,
    userId: input.userId,
    userEmail: input.userEmail,
  });
  if (input.request.workflow_id && !workflow) {
    throw new Error("Selected Workflow is not available");
  }
  const { data: documents, error: documentsError } = input.request.document_ids
    .length
    ? await input.db
        .from("documents")
        .select("id,current_version_id")
        .eq("project_id", input.matterId)
        .in("id", input.request.document_ids)
    : { data: [], error: null };
  if (documentsError) throw new Error(documentsError.message);
  const versionIds = (documents ?? []).flatMap((document) =>
    typeof document.current_version_id === "string"
      ? [document.current_version_id]
      : [],
  );
  const { data: versions, error: versionsError } = versionIds.length
    ? await input.db
        .from("document_versions")
        .select("id,filename")
        .in("id", versionIds)
    : { data: [], error: null };
  if (versionsError) throw new Error(versionsError.message);
  const filenames = new Map(
    (versions ?? []).map((version) => [
      String(version.id),
      String(version.filename ?? "Matter document"),
    ]),
  );
  const { api_keys: apiKeys } = await getUserModelSettings(
    input.userId,
    input.db,
  );
  const raw = await (input.complete ?? completeText)({
    model: input.model,
    systemPrompt:
      "You plan bounded legal work using only Vera's existing document-reading, Word, Excel, citation, and verification capabilities. Return strict JSON without commentary.",
    user: plannerPrompt({
      goal: input.goal,
      documents: (documents ?? []).map(
        (document) =>
          filenames.get(String(document.current_version_id)) ??
          `Matter document ${String(document.id)}`,
      ),
      workflow,
    }),
    maxTokens: 1_800,
    apiKeys,
  });
  const planned = planAgentTaskFromOutput(raw, {
    goal: input.goal,
    hasSources: input.request.document_ids.length > 0,
    workflowId: input.request.workflow_id,
    workflowType: workflow?.type,
  });
  return { ...planned, workflow };
}
