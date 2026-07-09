import assert from "node:assert/strict";

import {
  artifactRefsFromResolutions,
  auditCandidatesFromResolutions,
  createBigAtAutocompleteCandidates,
  parseBigAtReferences,
  resolveBigAtReferences,
  withAuditEventReferences,
} from "../../src/aletheia/agentops/references";
import { sampleAgentOpsWorkspace } from "../../src/aletheia/agentops/fixtures";

const workspaceWithClause = {
  ...sampleAgentOpsWorkspace,
  evidence: sampleAgentOpsWorkspace.evidence.map((item, index) =>
    index === 0
      ? {
          ...item,
          source_chunk_id: "chunk-notice-window",
          quote_start: 120,
          quote_end: 244,
        }
      : item,
  ),
};

const text =
  "Review @Matter with @Clause:chunk-notice-window, @Evidence:notice-window, @Issue:notice-timing, @Document.pdf, and @Run:run-evidence-demo-001.";

const parsed = parseBigAtReferences(text);
assert.deepEqual(
  parsed.map((reference) => reference.raw),
  [
    "@Matter",
    "@Clause:chunk-notice-window",
    "@Evidence:notice-window",
    "@Issue:notice-timing",
    "@Document.pdf",
    "@Run:run-evidence-demo-001",
  ],
);

const resolutions = resolveBigAtReferences(text, workspaceWithClause);
assert.equal(resolutions[0].status, "resolved");
assert.equal(resolutions[1].matches[0]?.type, "Clause");
assert.equal(resolutions[1].matches[0]?.artifact_ref?.id, "evidence-notice-window");
assert.equal(resolutions[2].matches[0]?.id, "evidence-notice-window");
assert.equal(resolutions[3].matches[0]?.id, "issue-notice-timing");
assert.equal(resolutions[4].status, "ambiguous");
assert.equal(resolutions[5].matches[0]?.id, "run-evidence-demo-001");

const artifactRefs = artifactRefsFromResolutions(resolutions);
assert.ok(
  artifactRefs.some(
    (artifact) =>
      artifact.type === "evidence_item" && artifact.id === "evidence-notice-window",
  ),
);
assert.ok(
  artifactRefs.some(
    (artifact) => artifact.type === "agent_run" && artifact.id === "run-evidence-demo-001",
  ),
);

const auditEvent = withAuditEventReferences(
  {
    id: "audit-test-reference-preservation",
    matter_id: sampleAgentOpsWorkspace.matter.id,
    actor_type: "agent",
    actor_id: "agent-test",
    action: "reference_test",
    timestamp: "2026-07-09T10:00:00.000Z",
  },
  "Preserve @Evidence:notice-window, @Document.pdf, and @Evidence:missing references in the audit event.",
  workspaceWithClause,
);

assert.deepEqual(auditEvent.big_at_references, [
  "@Evidence:notice-window",
  "@Document.pdf",
  "@Evidence:missing",
]);
assert.ok(
  auditEvent.referenced_artifacts?.some(
    (artifact) => artifact.type === "evidence_item" && artifact.id === "evidence-notice-window",
  ),
);
assert.deepEqual(
  auditEvent.big_at_resolution_records?.map((record) => record.status),
  ["resolved", "ambiguous", "missing"],
);
assert.equal(
  auditEvent.big_at_resolution_records?.[1].candidate_artifact_refs?.length,
  2,
);
assert.equal(auditEvent.big_at_resolution_records?.[2].resolved_artifact_refs.length, 0);

const auditCandidates = auditCandidatesFromResolutions(
  resolveBigAtReferences(auditEvent.big_at_references?.join(" ") ?? "", workspaceWithClause),
  {
    artifact_type: "audit_event",
    id: auditEvent.id,
  },
);
assert.deepEqual(
  auditCandidates.map((candidate) => candidate.status),
  ["resolved", "ambiguous", "missing"],
);
assert.equal(auditCandidates[0].source_text_owner.artifact_type, "audit_event");
assert.equal(auditCandidates[0].resolved_artifact_refs.length, 1);
assert.equal(auditCandidates[0].candidate_artifact_refs.length, 0);
assert.equal(auditCandidates[1].resolved_artifact_refs.length, 0);
assert.equal(auditCandidates[1].candidate_artifact_refs.length, 2);
assert.match(
  auditCandidates[1].required_review_action ?? "",
  /more specific Big @ selector/,
);
assert.equal(auditCandidates[2].resolved_artifact_refs.length, 0);
assert.equal(auditCandidates[2].candidate_artifact_refs.length, 0);
assert.match(
  auditCandidates[2].required_review_action ?? "",
  /missing Big @ reference/,
);

const candidates = createBigAtAutocompleteCandidates(
  "@Evidence:not",
  sampleAgentOpsWorkspace,
);
assert.equal(candidates[0].artifact_ref?.id, "evidence-notice-window");
assert.equal(candidates[0].insertion_text, "@Evidence:evidence-notice-window");

const clauseCandidates = createBigAtAutocompleteCandidates(
  "@Clause:notice",
  workspaceWithClause,
);
assert.equal(clauseCandidates[0].artifact_ref?.id, "evidence-notice-window");
assert.equal(clauseCandidates[0].insertion_text, "@Clause:chunk-notice-window");
