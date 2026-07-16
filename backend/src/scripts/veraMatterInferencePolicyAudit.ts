import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { WorkspaceDatabase } from "../lib/workspace/database";
import { WorkspaceApiError } from "../lib/workspace/errors";
import {
  assertInferenceAllowed,
  ModelProfilePrivacyRepository,
  WorkspaceInferencePolicy,
} from "../lib/workspace/inferencePolicy";

const NOW = "2026-07-16T00:00:00.000Z";
const GENERIC = "10000000-0000-4000-8000-000000000001";
const MATTER = "10000000-0000-4000-8000-000000000002";
const MODEL = "20000000-0000-4000-8000-000000000001";

function seed(database: WorkspaceDatabase) {
  database
    .prepare(
      `INSERT INTO model_profiles
         (id,name,provider,model,base_url,credential_status,enabled,created_at,updated_at)
       VALUES (?,'Explicit privacy model','openai_compatible','audit-model',
               'http://127.0.0.1:11434/v1','configured',1,?,?)`,
    )
    .run(MODEL, NOW, NOW);
  database
    .prepare(
      `INSERT INTO projects (id,name,status,created_at,updated_at)
       VALUES (?,'Generic','active',?,?), (?,'Matter','active',?,?)`,
    )
    .run(GENERIC, NOW, NOW, MATTER, NOW, NOW);
  database
    .prepare(
      `INSERT INTO matter_profiles
         (project_id,matter_type,workspace_type,created_at,updated_at)
       VALUES (?,'general','general_legal',?,?)`,
    )
    .run(MATTER, NOW, NOW);
}

function decisionCount(database: WorkspaceDatabase) {
  return Number(
    database
      .prepare("SELECT count(*) AS count FROM inference_policy_decisions")
      .get()?.count ?? 0,
  );
}

function expectPrecondition(operation: () => unknown, pattern: RegExp) {
  assert.throws(operation, (error: unknown) => {
    assert(error instanceof WorkspaceApiError);
    assert.equal(error.status, 412);
    assert.equal(error.code, "PRECONDITION_FAILED");
    assert.match(error.message, pattern);
    assert.doesNotMatch(
      error.message,
      /SELECT|model_profile_privacy|matter_policies/i,
    );
    return true;
  });
}

function auditSourceBoundaries() {
  const sourceRoot = path.join(process.cwd(), "src", "lib", "workspace");
  const source = (file: string) =>
    readFileSync(path.join(process.cwd(), "src", file), "utf8");
  const workspaceSources = (directory: string): string[] =>
    readdirSync(directory).flatMap((entry) => {
      const target = path.join(directory, entry);
      if (statSync(target).isDirectory()) return workspaceSources(target);
      return entry.endsWith(".ts") ? [target] : [];
    });
  const relativeWorkspaceSources = workspaceSources(sourceRoot).map((file) => ({
    file: path.relative(sourceRoot, file),
    text: readFileSync(file, "utf8"),
  }));
  const filesContaining = (needle: string) =>
    relativeWorkspaceSources
      .filter((entry) => entry.text.includes(needle))
      .map((entry) => entry.file)
      .sort();

  assert.deepEqual(filesContaining("provider.generate("), [
    "modelCallDiagnostics.ts",
    "services/assistantModelAdapter.ts",
    "services/tabularModelAdapter.ts",
  ]);
  assert.deepEqual(filesContaining(".createProvider("), [
    "modelSettingsRuntime.ts",
    "services/assistantModelAdapter.ts",
    "services/tabularModelAdapter.ts",
  ]);
  const assistant = source("lib/workspace/services/assistantModelAdapter.ts");
  const tabular = source("lib/workspace/services/tabularModelAdapter.ts");
  for (const [name, text] of [
    ["Assistant", assistant],
    ["Tabular", tabular],
  ] as const) {
    const enforcement = text.lastIndexOf(
      "assertInferenceAllowed",
      text.indexOf("provider.generate"),
    );
    const provider = text.indexOf("provider.generate");
    assert(
      enforcement >= 0 && enforcement < provider,
      `${name} final provider boundary must enforce policy first`,
    );
  }
  assert.match(
    source("lib/workspace/services/assistantRuntime.ts"),
    /operation:\s*"assistant"/,
  );
  assert.match(
    source("lib/workspace/services/workflowExecutor.ts"),
    /operation:\s*"workflow_prompt"/,
  );
  assert.match(
    source("lib/workspace/services/tabular.ts"),
    /operation:\s*"tabular_generation"/,
  );
  const compatibility = source("matter/inferencePolicy.ts");
  assert.doesNotMatch(
    compatibility,
    /class\s+MatterInferencePolicyGate|class\s+MatterPolicy/,
    "Matter compatibility surface must not contain a second evaluator",
  );
  assert.doesNotMatch(
    source("lib/workspace/runtime.ts"),
    /from\s+["']\.\.\/\.\.\/matter\/inferencePolicy["']/,
    "production composition must use only the Workspace policy",
  );
  const registry = source("lib/workspace/modelProviderRegistry.ts");
  assert.doesNotMatch(
    registry,
    /handleRequest|provider\.generate|operation:\s*"generate"/,
  );
  assert.doesNotMatch(
    source("lib/workspace/modelCompatibility.ts"),
    /handleRequest/,
  );
  const modelSettings = source("lib/workspace/modelSettingsRuntime.ts");
  const validationStart = modelSettings.indexOf(
    "private async validationResult",
  );
  const validationEnd = modelSettings.indexOf(
    "private storeFailure",
    validationStart,
  );
  const validationSource = modelSettings.slice(validationStart, validationEnd);
  assert.match(validationSource, /provider\.validateConfiguration\(/);
  assert.doesNotMatch(
    validationSource,
    /\.generate\(|projectId|sourceSnapshot|documentId|messages|prompt/,
    "connection validation must remain a fixed configuration-only non-inference probe",
  );
  assert.deepEqual(filesContaining("instrumentModelProvider("), [
    "modelCallDiagnostics.ts",
    "modelProviderRegistry.ts",
  ]);
  const diagnostics = source("lib/workspace/modelCallDiagnostics.ts");
  assert.match(diagnostics, /input\.provider\.generate\(request, signal\)/);
  assert.doesNotMatch(
    diagnostics,
    /createModelProvider|WorkspaceModelProviderRegistry|ModelProfilesRepository/,
    "diagnostics must remain a passive decorator that cannot originate a provider call",
  );
  assert.doesNotMatch(
    source("lib/workspace/runtime.ts"),
    /localModelScheduler|durableLocalModelStepExecutor|lib\/aletheia/,
    "Legacy Aletheia schedulers must remain outside the default Workspace runtime",
  );
}

function main() {
  const previousEncryption = process.env.ALETHEIA_DATABASE_ENCRYPTION;
  process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";
  const root = mkdtempSync(
    path.join(os.tmpdir(), "vera-inference-policy-v17-"),
  );
  const database = new WorkspaceDatabase(path.join(root, "workspace.db"));
  try {
    auditSourceBoundaries();
    assert.equal(database.migration?.currentVersion, 17);
    assert.equal(
      Number(
        database
          .prepare("SELECT count(*) AS count FROM model_profile_privacy")
          .get()?.count,
      ),
      0,
      "v17 must not backfill historical model privacy declarations",
    );
    seed(database);
    const privacy = new ModelProfilePrivacyRepository(database);
    const policy = new WorkspaceInferencePolicy(database);
    const genericScope = policy.resolveScope(GENERIC);
    const matterScope = policy.resolveScope(MATTER);
    assert.equal(genericScope.scope, "project");
    assert.equal(matterScope.scope, "matter");

    const missing = policy.evaluate({
      scope: genericScope,
      modelProfileId: MODEL,
      operation: "assistant",
    });
    assert.deepEqual(missing, {
      decision: "deny",
      reasonCode: "model_privacy_missing",
    });
    assert.equal(
      privacy.get(MODEL),
      null,
      "a localhost endpoint must never synthesize a local declaration",
    );
    assert.equal(
      decisionCount(database),
      0,
      "capability preview is side-effect free",
    );

    privacy.declare(
      MODEL,
      {
        executionLocation: "local",
        retention: "unknown",
        trainingUse: "prohibited",
        sensitiveDataAllowed: true,
      },
      NOW,
    );
    assert.equal(
      policy.evaluate({
        scope: genericScope,
        modelProfileId: MODEL,
        operation: "assistant",
      }).decision,
      "deny",
      "unknown privacy values are not affirmative safe declarations",
    );

    privacy.declare(
      MODEL,
      {
        executionLocation: "local",
        retention: "zero",
        trainingUse: "prohibited",
        sensitiveDataAllowed: true,
      },
      "2026-07-16T00:00:01.000Z",
    );
    assert.equal(
      policy.evaluate({
        scope: genericScope,
        modelProfileId: MODEL,
        operation: "assistant",
      }).decision,
      "allow",
    );
    assert.deepEqual(
      policy.evaluate({
        scope: matterScope,
        modelProfileId: MODEL,
        operation: "workflow_prompt",
      }),
      { decision: "deny", reasonCode: "matter_policy_missing" },
    );

    database
      .prepare(
        `INSERT INTO matter_policies
           (project_id,external_egress_mode,created_at,updated_at)
         VALUES (?,'disabled',?,?)`,
      )
      .run(MATTER, NOW, NOW);
    database
      .prepare(
        `INSERT INTO matter_policy_execution_locations
           (project_id,execution_location,created_at)
         VALUES (?,'local',?)`,
      )
      .run(MATTER, NOW);
    assert.equal(
      policy.evaluate({
        scope: matterScope,
        modelProfileId: MODEL,
        operation: "workflow_prompt",
      }).decision,
      "allow",
      "local inference remains compatible with disabled external egress",
    );

    privacy.declare(
      MODEL,
      {
        executionLocation: "confidential_remote",
        retention: "zero",
        trainingUse: "prohibited",
        sensitiveDataAllowed: true,
      },
      "2026-07-16T00:00:02.000Z",
    );
    database
      .prepare(
        `INSERT INTO matter_policy_execution_locations
           (project_id,execution_location,created_at)
         VALUES (?,'confidential_remote',?)`,
      )
      .run(MATTER, NOW);
    assert.deepEqual(
      policy.evaluate({
        scope: matterScope,
        modelProfileId: MODEL,
        operation: "tabular_generation",
      }),
      { decision: "deny", reasonCode: "matter_external_egress_disabled" },
    );

    database
      .prepare(
        "UPDATE matter_policies SET external_egress_mode='approval',updated_at=? WHERE project_id=?",
      )
      .run("2026-07-16T00:00:03.000Z", MATTER);
    assert.equal(
      policy.evaluate({
        scope: matterScope,
        modelProfileId: MODEL,
        operation: "tabular_generation",
      }).decision,
      "require_approval",
    );
    expectPrecondition(
      () =>
        assertInferenceAllowed(policy, {
          projectId: MATTER,
          modelProfileId: MODEL,
          operation: "tabular_generation",
        }),
      /requires approval/i,
    );
    assert.equal(
      decisionCount(database),
      1,
      "enforcement records approval denial",
    );

    database
      .prepare(
        "UPDATE matter_policies SET external_egress_mode='allowed_by_policy',updated_at=? WHERE project_id=?",
      )
      .run("2026-07-16T00:00:04.000Z", MATTER);
    assert.equal(
      assertInferenceAllowed(policy, {
        projectId: MATTER,
        modelProfileId: MODEL,
        operation: "tabular_generation",
        sourceSnapshotIds: [randomUUID()],
      }).decision,
      "allow",
    );
    assert.equal(decisionCount(database), 2);

    assert.throws(
      () =>
        privacy.declare(
          MODEL,
          {
            executionLocation: "local",
            retention: "zero",
            trainingUse: "prohibited",
            sensitiveDataAllowed: true,
          },
          NOW,
        ),
      (error: unknown) =>
        error instanceof WorkspaceApiError && error.status === 409,
      "an older declaration timestamp must not overwrite current metadata",
    );

    privacy.delete(MODEL);
    expectPrecondition(
      () =>
        assertInferenceAllowed(policy, {
          projectId: GENERIC,
          modelProfileId: MODEL,
          operation: "assistant",
        }),
      /unavailable under/i,
    );
    assert.equal(decisionCount(database), 3);

    assert.throws(
      () =>
        database
          .prepare(
            "DELETE FROM inference_policy_decisions WHERE decision = 'allow'",
          )
          .run(),
      /cannot be deleted/i,
      "the immutable decision ledger must reject direct row deletion",
    );
    assert.equal(decisionCount(database), 3);

    assert.throws(() =>
      database
        .prepare(
          `INSERT INTO inference_policy_decisions
             (id,scope,project_id,model_profile_id,operation,decision,reason_code)
           VALUES (?,'project',?,?,'assistant','deny','Bad-Code')`,
        )
        .run(randomUUID(), GENERIC, MODEL),
    );

    database
      .prepare(
        "UPDATE projects SET status='archived',archived_at=?,updated_at=? WHERE id=?",
      )
      .run(NOW, "2026-07-16T00:00:05.000Z", GENERIC);
    assert.throws(
      () => policy.resolveScope(GENERIC),
      (error: unknown) =>
        error instanceof WorkspaceApiError && error.status === 409,
    );

    database.prepare("DELETE FROM projects WHERE id=?").run(MATTER);
    database.prepare("DELETE FROM model_profiles WHERE id=?").run(MODEL);
    const redacted = database
      .prepare(
        `SELECT project_id, model_profile_id
           FROM inference_policy_decisions
          WHERE decision='allow'
          LIMIT 1`,
      )
      .get();
    assert.equal(redacted?.project_id, null);
    assert.equal(redacted?.model_profile_id, null);

    console.log(
      JSON.stringify(
        {
          ok: true,
          suite: "vera-unified-inference-policy-v17",
          checks: [
            "additive v17 without historical privacy backfill",
            "side-effect-free capability preview and enforced decision ledger",
            "global/project/matter unified scope resolution",
            "unknown privacy metadata fails closed without URL inference",
            "strictly monotonic privacy declaration updates",
            "local, disabled, approval, and allowed-by-policy matrix",
            "archived Project denial",
            "strict reason-code character constraint",
            "immutable decision rows reject direct deletion",
            "Project/model deletion de-identifies retained decision evidence",
            "source audit rejects legacy Matter gates and unchecked final provider boundaries",
            "registry compatibility surface has no generate executor",
            "connection validation is a fixed no-user-data non-inference exception",
            "model-call diagnostics is a passive decorator, not an originator",
            "Legacy Aletheia scheduler remains outside default Workspace composition",
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
    if (previousEncryption === undefined) {
      delete process.env.ALETHEIA_DATABASE_ENCRYPTION;
    } else {
      process.env.ALETHEIA_DATABASE_ENCRYPTION = previousEncryption;
    }
  }
}

main();
