import { z, type ZodError } from "zod";

import {
  UnicodeCodePointStringSchemaV1,
  WorkspaceIdSchema,
} from "../../lib/workspace/workspacePersistencePrimitivesV1";

export const WORKSPACE_TYPES = [
  "general_legal",
  "transaction",
  "dispute",
  "investigation",
  "compliance",
  "research",
] as const;

export const MATTER_PROFILE_STATES = [
  "absent",
  "classification_required",
  "ready",
] as const;

export const WorkspaceTypeSchema = z.enum(WORKSPACE_TYPES);
export const MatterProfileStateSchema = z.enum(MATTER_PROFILE_STATES);

/** v15/v16 profile timestamps are canonical millisecond UTC instants. */
export const MatterUtcTimestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => {
    const parsed = new Date(value);
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
  }, "timestamp must be a canonical millisecond UTC instant");

function persistedMatterText(max: number) {
  return UnicodeCodePointStringSchemaV1({
    min: 1,
    max,
    trimForMin: true,
  });
}

function matterTextInput(max: number) {
  return persistedMatterText(max).transform((value) => value.trim());
}

const PersistedClientNameSchema = persistedMatterText(500);
const PersistedJurisdictionSchema = persistedMatterText(240);
const PersistedRepresentedRoleSchema = persistedMatterText(240);
const PersistedObjectiveSchema = persistedMatterText(16_384);

const ClientNameInputSchema = matterTextInput(500);
const JurisdictionInputSchema = matterTextInput(240);
const RepresentedRoleInputSchema = matterTextInput(240);
const ObjectiveInputSchema = matterTextInput(16_384);

/**
 * Public Matter Profile contract. v15 litigation-specific columns remain
 * private compatibility storage and are deliberately absent here.
 */
export const MatterProfileSchema = z
  .object({
    projectId: WorkspaceIdSchema,
    workspaceType: WorkspaceTypeSchema.nullable(),
    clientName: PersistedClientNameSchema.nullable(),
    jurisdiction: PersistedJurisdictionSchema.nullable(),
    representedRole: PersistedRepresentedRoleSchema.nullable(),
    objective: PersistedObjectiveSchema.nullable(),
    createdAt: MatterUtcTimestampSchema,
    updatedAt: MatterUtcTimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.updatedAt < value.createdAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["updatedAt"],
        message: "updatedAt must not precede createdAt",
      });
    }
  });

const PersistedProjectNameSchema = persistedMatterText(240);
const PersistedProjectDescriptionSchema = UnicodeCodePointStringSchemaV1({
  max: 2_000,
});
const PersistedProjectCmNumberSchema = UnicodeCodePointStringSchemaV1({
  max: 160,
});
const PersistedProjectPracticeSchema = UnicodeCodePointStringSchemaV1({
  max: 160,
});

/** Existing Projects legitimately permit empty nullable metadata strings. */
export const MatterProjectProjectionSchema = z
  .object({
    id: WorkspaceIdSchema,
    name: PersistedProjectNameSchema,
    description: PersistedProjectDescriptionSchema.nullable(),
    cmNumber: PersistedProjectCmNumberSchema.nullable(),
    practice: PersistedProjectPracticeSchema.nullable(),
    status: z.enum(["active", "archived", "deleted"]),
    defaultModelProfileId: WorkspaceIdSchema.nullable(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    archivedAt: z.string().datetime({ offset: true }).nullable(),
    documentCount: z.number().int().nonnegative(),
    chatCount: z.number().int().nonnegative(),
    tabularReviewCount: z.number().int().nonnegative(),
    workflowCount: z.number().int().nonnegative(),
  })
  .strict();

export const MatterCapabilitiesSchema = z
  .object({
    matterProfile: z.enum(["create", "classify", "edit", "unavailable"]),
    inference: z.enum([
      "workspace_compatibility",
      "policy_gate_closed",
      "unavailable",
    ]),
    review: z.literal("unavailable"),
    drafts: z.literal("document_scoped"),
  })
  .strict();

export type WorkspaceType = z.infer<typeof WorkspaceTypeSchema>;
export type MatterProfileState = z.infer<typeof MatterProfileStateSchema>;
export type MatterProfile = z.infer<typeof MatterProfileSchema>;
export type MatterCapabilities = z.infer<typeof MatterCapabilitiesSchema>;

export function matterProfilePresentation(
  projectStatus: "active" | "archived" | "deleted",
  profile: MatterProfile | null,
): {
  profileState: MatterProfileState;
  capabilities: MatterCapabilities;
} {
  const profileState: MatterProfileState =
    profile === null
      ? "absent"
      : profile.workspaceType === null
        ? "classification_required"
        : "ready";
  if (projectStatus !== "active") {
    return {
      profileState,
      capabilities: {
        matterProfile: "unavailable",
        inference: "unavailable",
        review: "unavailable",
        drafts: "document_scoped",
      },
    };
  }
  if (profile === null) {
    return {
      profileState,
      capabilities: {
        matterProfile: "create",
        inference: "workspace_compatibility",
        review: "unavailable",
        drafts: "document_scoped",
      },
    };
  }
  return {
    profileState,
    capabilities: {
      matterProfile: profile.workspaceType === null ? "classify" : "edit",
      inference: "policy_gate_closed",
      review: "unavailable",
      drafts: "document_scoped",
    },
  };
}

export const MatterViewSchema = z
  .object({
    project: MatterProjectProjectionSchema,
    profile: MatterProfileSchema.nullable(),
    profileState: MatterProfileStateSchema,
    capabilities: MatterCapabilitiesSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.profile !== null &&
      value.profile.projectId !== value.project.id
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["profile", "projectId"],
        message: "Matter Profile must belong to the projected Project",
      });
    }
    const expected = matterProfilePresentation(
      value.project.status,
      value.profile,
    );
    if (value.profileState !== expected.profileState) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["profileState"],
        message: "Matter Profile state is inconsistent",
      });
    }
    if (
      JSON.stringify(value.capabilities) !==
      JSON.stringify(expected.capabilities)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capabilities"],
        message: "Matter capabilities are inconsistent",
      });
    }
  });

const CreateProfileShape = {
  workspaceType: WorkspaceTypeSchema,
  clientName: ClientNameInputSchema.nullable().optional(),
  jurisdiction: JurisdictionInputSchema.nullable().optional(),
  representedRole: RepresentedRoleInputSchema.nullable().optional(),
  objective: ObjectiveInputSchema.nullable().optional(),
} satisfies z.ZodRawShape;

export const CreateMatterProfileRequestSchema = z
  .object(CreateProfileShape)
  .strict();

export const CreateMatterRequestSchema = z
  .object({
    name: matterTextInput(240),
    description: matterTextInput(2_000).nullable().optional(),
    cmNumber: matterTextInput(160).nullable().optional(),
    practice: matterTextInput(160).nullable().optional(),
    ...CreateProfileShape,
  })
  .strict();

export const UpdateMatterProfileRequestSchema = z
  .object({
    workspaceType: WorkspaceTypeSchema.optional(),
    clientName: ClientNameInputSchema.nullable().optional(),
    jurisdiction: JurisdictionInputSchema.nullable().optional(),
    representedRole: RepresentedRoleInputSchema.nullable().optional(),
    objective: ObjectiveInputSchema.nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "at least one Matter Profile update is required",
  });

export const MatterListRequestSchema = z
  .object({
    status: z.enum(["active", "archived"]).optional(),
    cursor: z.string().min(1).max(512).nullable().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

export const MatterViewPageSchema = z
  .object({
    items: z.array(MatterViewSchema).max(100),
    nextCursor: z.string().min(1).max(512).nullable(),
  })
  .strict();

export const MatterProfileWireSchema = z
  .object({
    project_id: WorkspaceIdSchema,
    workspace_type: WorkspaceTypeSchema.nullable(),
    client_name: PersistedClientNameSchema.nullable(),
    jurisdiction: PersistedJurisdictionSchema.nullable(),
    represented_role: PersistedRepresentedRoleSchema.nullable(),
    objective: PersistedObjectiveSchema.nullable(),
    created_at: MatterUtcTimestampSchema,
    updated_at: MatterUtcTimestampSchema,
  })
  .strict();

export const MatterProjectWireSchema = z
  .object({
    id: WorkspaceIdSchema,
    name: PersistedProjectNameSchema,
    description: PersistedProjectDescriptionSchema.nullable(),
    cm_number: PersistedProjectCmNumberSchema.nullable(),
    practice: PersistedProjectPracticeSchema.nullable(),
    status: z.enum(["active", "archived", "deleted"]),
    default_model_profile_id: WorkspaceIdSchema.nullable(),
    created_at: z.string().datetime({ offset: true }),
    updated_at: z.string().datetime({ offset: true }),
    archived_at: z.string().datetime({ offset: true }).nullable(),
    document_count: z.number().int().nonnegative(),
    chat_count: z.number().int().nonnegative(),
    tabular_review_count: z.number().int().nonnegative(),
    workflow_count: z.number().int().nonnegative(),
  })
  .strict();

export const MatterCapabilitiesWireSchema = z
  .object({
    matter_profile: z.enum(["create", "classify", "edit", "unavailable"]),
    inference: z.enum([
      "workspace_compatibility",
      "policy_gate_closed",
      "unavailable",
    ]),
    review: z.literal("unavailable"),
    drafts: z.literal("document_scoped"),
  })
  .strict();

export const MatterViewWireSchema = z
  .object({
    project: MatterProjectWireSchema,
    matter_profile: MatterProfileWireSchema.nullable(),
    profile_state: MatterProfileStateSchema,
    capabilities: MatterCapabilitiesWireSchema,
  })
  .strict();

export const MatterViewPageWireSchema = z
  .object({
    items: z.array(MatterViewWireSchema).max(100),
    next_cursor: z.string().min(1).max(512).nullable(),
  })
  .strict();

export const MatterListWireQuerySchema = z
  .object({
    status: z.enum(["active", "archived"]).optional(),
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

const CreateProfileWireShape = {
  workspace_type: WorkspaceTypeSchema,
  client_name: ClientNameInputSchema.nullable().optional(),
  jurisdiction: JurisdictionInputSchema.nullable().optional(),
  represented_role: RepresentedRoleInputSchema.nullable().optional(),
  objective: ObjectiveInputSchema.nullable().optional(),
} satisfies z.ZodRawShape;

export const CreateMatterProfileWireRequestSchema = z
  .object(CreateProfileWireShape)
  .strict();

export const CreateMatterWireRequestSchema = z
  .object({
    name: matterTextInput(240),
    description: matterTextInput(2_000).nullable().optional(),
    cm_number: matterTextInput(160).nullable().optional(),
    practice: matterTextInput(160).nullable().optional(),
    ...CreateProfileWireShape,
  })
  .strict();

export const UpdateMatterProfileWireRequestSchema = z
  .object({
    workspace_type: WorkspaceTypeSchema.optional(),
    client_name: ClientNameInputSchema.nullable().optional(),
    jurisdiction: JurisdictionInputSchema.nullable().optional(),
    represented_role: RepresentedRoleInputSchema.nullable().optional(),
    objective: ObjectiveInputSchema.nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "at least one Matter Profile update is required",
  });

export type MatterView = z.infer<typeof MatterViewSchema>;
export type MatterViewPage = z.infer<typeof MatterViewPageSchema>;
export type CreateMatterRequest = z.infer<typeof CreateMatterRequestSchema>;
export type CreateMatterProfileRequest = z.infer<
  typeof CreateMatterProfileRequestSchema
>;
export type UpdateMatterProfileRequest = z.infer<
  typeof UpdateMatterProfileRequestSchema
>;
export type MatterListRequest = z.infer<typeof MatterListRequestSchema>;

const PUBLIC_VALIDATION_PATHS = new Set([
  "request",
  "projectId",
  "name",
  "description",
  "cmNumber",
  "practice",
  "workspaceType",
  "clientName",
  "jurisdiction",
  "representedRole",
  "objective",
  "status",
  "cursor",
  "limit",
  "project_id",
  "cm_number",
  "workspace_type",
  "client_name",
  "represented_role",
]);

/** Zod enum messages can echo rejected source values; public details never do. */
export function safeMatterValidationDetails(error: ZodError) {
  return error.issues.slice(0, 100).map((issue) => {
    const path = issue.path
      .map((part) => String(part))
      .filter((part) => PUBLIC_VALIDATION_PATHS.has(part))
      .join(".");
    return {
      path: path || "request",
      message: "Invalid value.",
    };
  });
}

export function parseCreateMatterWire(value: unknown): CreateMatterRequest {
  const input = CreateMatterWireRequestSchema.parse(value);
  return CreateMatterRequestSchema.parse({
    name: input.name,
    description: input.description,
    cmNumber: input.cm_number,
    practice: input.practice,
    workspaceType: input.workspace_type,
    clientName: input.client_name,
    jurisdiction: input.jurisdiction,
    representedRole: input.represented_role,
    objective: input.objective,
  });
}

export function parseCreateMatterProfileWire(
  value: unknown,
): CreateMatterProfileRequest {
  const input = CreateMatterProfileWireRequestSchema.parse(value);
  return CreateMatterProfileRequestSchema.parse({
    workspaceType: input.workspace_type,
    clientName: input.client_name,
    jurisdiction: input.jurisdiction,
    representedRole: input.represented_role,
    objective: input.objective,
  });
}

export function parseUpdateMatterProfileWire(
  value: unknown,
): UpdateMatterProfileRequest {
  const input = UpdateMatterProfileWireRequestSchema.parse(value);
  return UpdateMatterProfileRequestSchema.parse({
    ...(input.workspace_type === undefined
      ? {}
      : { workspaceType: input.workspace_type }),
    ...(input.client_name === undefined
      ? {}
      : { clientName: input.client_name }),
    ...(input.jurisdiction === undefined
      ? {}
      : { jurisdiction: input.jurisdiction }),
    ...(input.represented_role === undefined
      ? {}
      : { representedRole: input.represented_role }),
    ...(input.objective === undefined ? {} : { objective: input.objective }),
  });
}

export function toMatterProfileWire(profile: MatterProfile) {
  return MatterProfileWireSchema.parse({
    project_id: profile.projectId,
    workspace_type: profile.workspaceType,
    client_name: profile.clientName,
    jurisdiction: profile.jurisdiction,
    represented_role: profile.representedRole,
    objective: profile.objective,
    created_at: profile.createdAt,
    updated_at: profile.updatedAt,
  });
}

export function toMatterViewWire(value: MatterView) {
  const view = MatterViewSchema.parse(value);
  return MatterViewWireSchema.parse({
    project: {
      id: view.project.id,
      name: view.project.name,
      description: view.project.description,
      cm_number: view.project.cmNumber,
      practice: view.project.practice,
      status: view.project.status,
      default_model_profile_id: view.project.defaultModelProfileId,
      created_at: view.project.createdAt,
      updated_at: view.project.updatedAt,
      archived_at: view.project.archivedAt,
      document_count: view.project.documentCount,
      chat_count: view.project.chatCount,
      tabular_review_count: view.project.tabularReviewCount,
      workflow_count: view.project.workflowCount,
    },
    matter_profile:
      view.profile === null ? null : toMatterProfileWire(view.profile),
    profile_state: view.profileState,
    capabilities: {
      matter_profile: view.capabilities.matterProfile,
      inference: view.capabilities.inference,
      review: view.capabilities.review,
      drafts: view.capabilities.drafts,
    },
  });
}

export function toMatterViewPageWire(value: MatterViewPage) {
  const page = MatterViewPageSchema.parse(value);
  return MatterViewPageWireSchema.parse({
    items: page.items.map(toMatterViewWire),
    next_cursor: page.nextCursor,
  });
}
