import type {
  WorkspaceDatabaseAdapter,
  WorkspaceDatabaseCapabilities,
  WorkspaceMigration,
} from "./types";

const MATTER_CLASSIFICATION_V16_SQL = `
ALTER TABLE matter_profiles ADD COLUMN workspace_type TEXT
  CHECK (
    workspace_type IS NULL OR (
      typeof(workspace_type) = 'text'
      AND workspace_type IN (
        'general_legal',
        'transaction',
        'dispute',
        'investigation',
        'compliance',
        'research'
      )
    )
  );

ALTER TABLE matter_profiles ADD COLUMN jurisdiction TEXT
  CHECK (
    jurisdiction IS NULL OR (
      typeof(jurisdiction) = 'text'
      AND length(trim(jurisdiction)) BETWEEN 1 AND 240
      AND instr(jurisdiction, char(0)) = 0
    )
  );

CREATE INDEX idx_matter_profiles_workspace_type_updated
  ON matter_profiles(workspace_type, updated_at DESC, project_id)
  WHERE workspace_type IS NOT NULL;

CREATE INDEX idx_matter_profiles_jurisdiction_updated
  ON matter_profiles(jurisdiction, updated_at DESC, project_id)
  WHERE jurisdiction IS NOT NULL;

/*
 * The column remains nullable only for rows created by a pre-v16 binary.
 * Every post-v16 insert must carry the user's explicit classification.
 */
CREATE TRIGGER matter_profiles_v16_insert_requires_workspace_type
BEFORE INSERT ON matter_profiles
WHEN new.workspace_type IS NULL BEGIN
  SELECT RAISE(ABORT, 'Matter workspace classification is required');
END;

/*
 * A legacy row may move from classification_required to a selected value.
 * Once classified, it cannot silently return to the ambiguous legacy state.
 */
CREATE TRIGGER matter_profiles_v16_workspace_type_one_way
BEFORE UPDATE OF workspace_type ON matter_profiles
WHEN old.workspace_type IS NOT NULL AND new.workspace_type IS NULL BEGIN
  SELECT RAISE(ABORT, 'Matter workspace classification cannot be cleared');
END;
`;

function applyMatterClassificationV16(
  database: WorkspaceDatabaseAdapter,
  _capabilities: WorkspaceDatabaseCapabilities,
) {
  database.exec(MATTER_CLASSIFICATION_V16_SQL);
}

export const MATTER_CLASSIFICATION_V16_MIGRATION: WorkspaceMigration = {
  version: 16,
  name: "matter_profile_classification",
  checksumMaterial: [
    "workspace-migration-v16",
    "additive-v15-matter-classification-without-backfill",
    "nullable-legacy-workspace-type-new-inserts-require-explicit-classification",
    "classified-workspace-type-cannot-return-to-null",
    "bounded-optional-jurisdiction-240-nul-safe",
    MATTER_CLASSIFICATION_V16_SQL,
  ].join("\n-- checksum boundary --\n"),
  apply: applyMatterClassificationV16,
};
