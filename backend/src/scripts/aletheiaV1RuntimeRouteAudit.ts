import "dotenv/config";
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const timestamp = "2026-07-09T12:00:00.000Z";

function blockedRuntimePayload() {
  return {
    workflow: "legal_matter_review",
    goal: "Persist blocked V1 runtime result through the public local route.",
    now: timestamp,
    providerDecision: {
      allowed: false,
      reason:
        "external model calls for private or sensitive data require explicit approval",
      externalCall: true,
      provider: "openai",
      model: "gpt-configured",
      privacyMode: "private",
    },
    run: {
      id: "run-v1-runtime-route-blocked",
      matter_id: "ignored-by-route",
      agent_id: "agent-v1-llm-runtime",
      started_at: timestamp,
      ended_at: timestamp,
      status: "blocked",
      model: "openai:gpt-configured",
      errors: [
        "external model calls for private or sensitive data require explicit approval",
      ],
      trace_events: [
        {
          id: "trace-v1-route-gate",
          timestamp,
          level: "error",
          message: "Provider policy blocked the model call.",
          metadata: { phase: "gate" },
        },
      ],
      tool_calls: [
        {
          id: "tool-v1-route-provider-policy",
          name: "v1_provider_policy",
          started_at: timestamp,
          ended_at: timestamp,
          status: "failed",
          input: { provider: "openai", privacyMode: "private" },
          output: { allowed: false },
          error:
            "external model calls for private or sensitive data require explicit approval",
        },
      ],
    },
    auditEvents: [
      {
        id: "audit-v1-route-blocked",
        matter_id: "ignored-by-route",
        actor_type: "system",
        actor_id: "v1-llm-runtime",
        action: "v1_external_model_call_blocked",
        artifact_id: "run-v1-runtime-route-blocked",
        artifact_type: "agent_run",
        after_hash: "fnv1a32:blocked-route",
        timestamp,
      },
    ],
  };
}

async function closeServer(server: http.Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function main() {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "aletheia-v1-route-"));
  process.env.ALETHEIA_AUTH_MODE = "single_user";
  process.env.ALETHEIA_DATA_DIR = dataDir;
  process.env.ALETHEIA_LOCAL_USER_ID = "v1-route-user";
  process.env.ALETHEIA_LOCAL_USER_EMAIL = "v1-route@aletheia.internal";

  try {
    const [{ createAletheiaRepository }, { aletheiaRouter }] =
      await Promise.all([
        import("../lib/aletheia"),
        import("../routes/aletheia"),
      ]);

    const ctx = {
      userId: "v1-route-user",
      userEmail: "v1-route@aletheia.internal",
    };
    const repo = createAletheiaRepository();
    const matter = (await repo.createMatter(ctx, {
      title: "V1 Runtime Route Audit Matter",
      objective:
        "Verify local V1 runtime result persistence and approval retry route wiring.",
      template: "legal_matter_review",
      status: "in_progress",
      riskLevel: "high",
      clientOrProject: "V1 local runtime",
      sourceProjectId: null,
      sharedWith: [],
      metadata: { audit: "v1_runtime_route" },
    })) as { id: string };

    const app = express();
    app.use(express.json({ limit: "2mb" }));
    app.use("/aletheia", aletheiaRouter);
    const server = app.listen(0);

    try {
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const address = server.address();
      assert(address && typeof address === "object", "Server should listen");
      const baseUrl = `http://127.0.0.1:${address.port}`;

      const persistResponse = await fetch(
        `${baseUrl}/aletheia/matters/${matter.id}/v1/runtime-results`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(blockedRuntimePayload()),
        },
      );
      assert.equal(persistResponse.status, 201);
      const persisted: any = await persistResponse.json();
      assert.equal(
        persisted.schema_version,
        "aletheia-v1-runtime-persistence-route-local-v0",
      );
      assert.equal(persisted.local_only, true);
      assert.equal(persisted.run.id, "run-v1-runtime-route-blocked");
      assert.equal(persisted.run.status, "blocked");
      assert.equal(
        persisted.run.tool_calls.some(
          (call: any) => call.tool_name === "v1_model_call",
        ),
        false,
      );
      assert.equal(persisted.run.human_checkpoints.length, 1);
      const checkpoint = persisted.run.human_checkpoints[0];
      assert.equal(checkpoint.checkpoint_type, "external_model_call");
      assert.equal(checkpoint.status, "open");

      const earlyResume = await fetch(
        `${baseUrl}/aletheia/matters/${matter.id}/agent-runs/${persisted.run.id}/resume`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ checkpointId: checkpoint.id }),
        },
      );
      assert.equal(earlyResume.status, 409);
      const earlyResumePayload: any = await earlyResume.json();
      assert.equal(earlyResumePayload.code, "approval_required");

      const decisionResponse = await fetch(
        `${baseUrl}/aletheia/matters/${matter.id}/approvals/${checkpoint.id}/decision`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            decision: "approved",
            comment: "Approve a retry record, but do not dispatch a provider.",
          }),
        },
      );
      assert.equal(decisionResponse.status, 200);
      const decision: any = await decisionResponse.json();
      assert.equal(decision.status, "approved");
      assert.equal(decision.decision, "approved");

      const resumeResponse = await fetch(
        `${baseUrl}/aletheia/matters/${matter.id}/agent-runs/${persisted.run.id}/resume`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            checkpointId: checkpoint.id,
            note: "Record local retry authorization.",
          }),
        },
      );
      assert.equal(resumeResponse.status, 200);
      const resumed: any = await resumeResponse.json();
      assert.equal(resumed.id, persisted.run.id);
      assert.equal(resumed.status, "running");
      assert.equal(resumed.current_step_key, "provider_dispatch_ready");
      assert.equal(
        resumed.steps.some(
          (step: any) => step.step_key === "retry_after_external_model_approval",
        ),
        true,
      );
      assert.equal(
        resumed.tool_calls.some(
          (call: any) =>
            call.tool_name === "v1_approval_retry" &&
            call.output.externalProviderDispatched === false,
        ),
        true,
      );

      const detail = (await repo.getMatterDetail(ctx, matter.id)) as {
        auditEvents: Array<{ action: string; details: Record<string, unknown> }>;
      };
      const actions = new Set(detail.auditEvents.map((event) => event.action));
      assert.equal(actions.has("v1_external_model_call_blocked"), true);
      assert.equal(actions.has("approval_approved"), true);
      assert.equal(actions.has("v1_runtime_retry_recorded"), true);
      const retryAudit = detail.auditEvents.find(
        (event) => event.action === "v1_runtime_retry_recorded",
      );
      assert.equal(retryAudit?.details.externalProviderDispatched, false);
      assert.equal(retryAudit?.details.checkpointId, checkpoint.id);

      console.log(
        JSON.stringify(
          {
            ok: true,
            matterId: matter.id,
            runId: persisted.run.id,
            checkpointId: checkpoint.id,
            retryAuditRecorded: true,
          },
          null,
          2,
        ),
      );
    } finally {
      await closeServer(server);
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("[aletheia-v1-runtime-route-audit] failed", error);
  process.exitCode = 1;
});
