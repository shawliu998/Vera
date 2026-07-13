import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalDatabase } from "../lib/aletheia/localDatabase";
import {
  initializeLitigationSchema,
  LitigationValidationError,
  LocalLitigationStore,
} from "../lib/aletheia/litigationStore";

function baseSchema(db: LocalDatabase) {
  db.exec(`
    pragma foreign_keys = on;
    create table aletheia_matters (
      id text primary key,
      user_id text not null,
      template text not null
    );
    create table aletheia_matter_documents (
      id text primary key,
      matter_id text not null references aletheia_matters(id) on delete cascade,
      user_id text not null,
      name text not null
    );
    create table aletheia_document_chunks (
      id text primary key,
      matter_id text not null references aletheia_matters(id) on delete cascade,
      document_id text not null references aletheia_matter_documents(id) on delete cascade,
      user_id text not null,
      page integer,
      section text,
      text text not null,
      quote_start integer not null default 0
    );
    create table aletheia_exports (
      id text primary key,
      matter_id text not null,
      export_type text not null,
      gate_authorization_status text not null,
      approval_checkpoint_id text,
      metadata text not null default '{}',
      created_at text not null
    );
    create table aletheia_human_checkpoints (
      id text primary key,
      matter_id text not null,
      checkpoint_type text not null,
      status text not null,
      decision text,
      requested_payload text not null default '{}'
    );
    create table aletheia_work_products (
      id text primary key,
      matter_id text not null,
      user_id text not null,
      stale_at text
    );
  `);
  initializeLitigationSchema(db);
}

function seed(db: LocalDatabase) {
  const insertMatter = db.prepare(
    "insert into aletheia_matters (id, user_id, template) values (?, ?, 'civil_litigation')",
  );
  insertMatter.run("matter-a", "lawyer-a");
  insertMatter.run("matter-b", "lawyer-a");
  insertMatter.run("matter-x", "lawyer-b");
  db.prepare(
    "insert into aletheia_matter_documents (id, matter_id, user_id, name) values (?, ?, ?, ?)",
  ).run("doc-a", "matter-a", "lawyer-a", "civil-code.txt");
  db.prepare(
    `insert into aletheia_document_chunks (
      id, matter_id, document_id, user_id, page, section, text, quote_start
    ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "chunk-a",
    "matter-a",
    "doc-a",
    "lawyer-a",
    12,
    "Article 42",
    "Article 42 authorizes rescission where the material breach is proven.",
    900,
  );
}

function claimStatus(
  store: LocalLitigationStore,
  matterId: string,
  claimId: string,
) {
  const workspace = store.getWorkspace(
    { userId: "lawyer-a" },
    matterId,
  ) as Record<string, Array<Record<string, unknown>>>;
  return workspace.claims.find((claim) => claim.id === claimId);
}

function main() {
  const directory = mkdtempSync(
    path.join(tmpdir(), "aletheia-position-review-"),
  );
  const databasePath = path.join(directory, "audit.sqlite");
  const ctx = { userId: "lawyer-a" };
  const otherUser = { userId: "lawyer-b" };
  const chunkText =
    "Article 42 authorizes rescission where the material breach is proven.";
  const quote = "authorizes rescission";
  const quoteStart = chunkText.indexOf(quote);
  const quoteEnd = quoteStart + quote.length;
  let db = new LocalDatabase(databasePath);
  try {
    baseSchema(db);
    seed(db);
    let store = new LocalLitigationStore(db);

    const citedClaim = store.createClaim(ctx, "matter-a", {
      kind: "claim",
      title: "The claimant may rescind for material breach.",
      legalBasis: "Article 42",
      confidence: "medium",
      uncertainty: "Materiality remains fact-sensitive.",
      sourceRelation: "authority",
      source: { sourceChunkId: "chunk-a", quoteStart, quoteEnd },
      createdBy: "agent",
    }) as Record<string, unknown>;
    assert.equal(citedClaim.confidence, "medium");
    assert.equal(citedClaim.uncertainty, "Materiality remains fact-sensitive.");
    store.decideClaim(ctx, "matter-a", String(citedClaim.id), {
      decision: "confirmed",
      comment: "Initial legal position confirmed.",
    });

    const workspace = store.getWorkspace(ctx, "matter-a") as Record<
      string,
      Array<Record<string, unknown>>
    >;
    assert.equal(workspace.claim_sources.length, 1);
    assert.equal(workspace.legal_assessments.length, 1);
    assert.equal(workspace.legal_assessments[0].version, 1);
    assert.equal(
      workspace.claims.find((item) => item.id === citedClaim.id)
        ?.current_assessment_id,
      workspace.legal_assessments[0].id,
    );
    assert.equal(
      workspace.legal_assessments[0].source_snapshot.evidenceSources.length,
      1,
    );
    assert.equal(
      workspace.legal_assessments[0].source_snapshot.legalAuthorities.length,
      0,
    );
    const source = workspace.claim_sources[0];
    assert.equal(source.relation, "authority");
    assert.equal(source.document_name, "civil-code.txt");
    assert.equal(source.page, 12);
    assert.equal(source.section, "Article 42");
    assert.equal(source.quote, quote);
    assert.equal(source.chunk_quote_start, quoteStart);
    assert.equal(source.chunk_quote_end, quoteEnd);
    assert.equal(source.document_quote_start, 900 + quoteStart);
    assert.equal(source.document_quote_end, 900 + quoteEnd);
    assert.equal(
      source.source_chunk_sha256,
      createHash("sha256").update(chunkText).digest("hex"),
    );
    assert.equal(
      source.quote_sha256,
      createHash("sha256").update(quote).digest("hex"),
    );

    const otherMatterClaim = store.createClaim(ctx, "matter-b", {
      kind: "claim",
      title: "A claim owned by another matter",
    }) as Record<string, unknown>;
    db.prepare(
      `insert into aletheia_litigation_claim_sources
        (id, matter_id, claim_id, source_span_id, relation, created_at)
       values (?, ?, ?, ?, ?, ?)`,
    ).run(
      "polluted-claim-source",
      "matter-a",
      otherMatterClaim.id,
      source.source_span_id,
      "supports",
      new Date().toISOString(),
    );
    db.prepare(
      `insert into aletheia_position_reviews (
        id, matter_id, user_id, claim_id, kind, reason, requested_outcome,
        status, resolution, resolution_comment, resolved_by, resolved_at,
        created_by, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "polluted-position-review",
      "matter-a",
      "lawyer-b",
      citedClaim.id,
      "objection",
      "Cross-user pollution row",
      "rejected",
      "resolved",
      "dismissed",
      null,
      "lawyer-b",
      new Date().toISOString(),
      "lawyer-b",
      new Date().toISOString(),
      new Date().toISOString(),
    );
    const pollutionFiltered = store.getWorkspace(ctx, "matter-a") as Record<
      string,
      Array<Record<string, unknown>>
    >;
    assert.equal(pollutionFiltered.claim_sources.length, 1);
    assert.equal(pollutionFiltered.position_reviews.length, 0);

    assert.throws(
      () =>
        store.createClaim(ctx, "matter-b", {
          kind: "claim",
          title: "Cross-matter citation",
          source: { sourceChunkId: "chunk-a", quoteStart, quoteEnd },
        }),
      LitigationValidationError,
    );

    const failedDecisionClaim = store.createClaim(ctx, "matter-a", {
      kind: "defense",
      title: "A proposed position used to verify decision audit rollback",
    }) as Record<string, unknown>;
    assert.throws(
      () =>
        store.decideClaim(
          ctx,
          "matter-a",
          String(failedDecisionClaim.id),
          { decision: "rejected" },
          () => {
            throw new Error("simulated decision audit write failure");
          },
        ),
      /simulated decision audit write failure/,
    );
    assert.equal(
      claimStatus(store, "matter-a", String(failedDecisionClaim.id))?.status,
      "proposed",
    );
    assert.equal(
      (
        store.getWorkspace(ctx, "matter-a") as Record<
          string,
          Array<Record<string, unknown>>
        >
      ).legal_assessments.some(
        (item) => item.claim_id === failedDecisionClaim.id,
      ),
      false,
    );

    const auditFailureClaim = store.createClaim(ctx, "matter-a", {
      kind: "defense",
      title: "A rejected position used to verify transactional audit failure",
    }) as Record<string, unknown>;
    store.decideClaim(ctx, "matter-a", String(auditFailureClaim.id), {
      decision: "rejected",
    });
    assert.throws(
      () =>
        store.createPositionReview(
          ctx,
          "matter-a",
          String(auditFailureClaim.id),
          {
            kind: "reconsideration",
            reason: "Creation must roll back when its audit cannot be written.",
            requestedOutcome: "confirmed",
          },
          () => {
            throw new Error("simulated audit write failure");
          },
        ),
      /simulated audit write failure/,
    );
    let auditFailureWorkspace = store.getWorkspace(ctx, "matter-a") as Record<
      string,
      Array<Record<string, unknown>>
    >;
    assert.equal(
      auditFailureWorkspace.position_reviews.some(
        (item) => item.claim_id === auditFailureClaim.id,
      ),
      false,
    );
    const auditFailureReview = store.createPositionReview(
      ctx,
      "matter-a",
      String(auditFailureClaim.id),
      {
        kind: "reconsideration",
        reason: "Review transaction rollback test.",
        requestedOutcome: "confirmed",
      },
    ) as Record<string, unknown>;
    assert.throws(
      () =>
        store.resolvePositionReview(
          ctx,
          "matter-a",
          String(auditFailureReview.id),
          { resolution: "granted" },
          () => {
            throw new Error("simulated audit write failure");
          },
        ),
      /simulated audit write failure/,
    );
    assert.equal(
      claimStatus(store, "matter-a", String(auditFailureClaim.id))?.status,
      "rejected",
    );
    auditFailureWorkspace = store.getWorkspace(ctx, "matter-a") as Record<
      string,
      Array<Record<string, unknown>>
    >;
    assert.equal(
      auditFailureWorkspace.position_reviews.find(
        (item) => item.id === auditFailureReview.id,
      )?.status,
      "open",
    );
    assert.throws(
      () =>
        store.withdrawPositionReview(
          ctx,
          "matter-a",
          String(auditFailureReview.id),
          () => {
            throw new Error("simulated audit write failure");
          },
        ),
      /simulated audit write failure/,
    );
    auditFailureWorkspace = store.getWorkspace(ctx, "matter-a") as Record<
      string,
      Array<Record<string, unknown>>
    >;
    assert.equal(
      auditFailureWorkspace.position_reviews.find(
        (item) => item.id === auditFailureReview.id,
      )?.status,
      "open",
    );
    store.withdrawPositionReview(
      ctx,
      "matter-a",
      String(auditFailureReview.id),
    );

    const review = store.createPositionReview(
      ctx,
      "matter-a",
      String(citedClaim.id),
      {
        kind: "objection",
        reason: "The cited authority may not apply to this remedy.",
        requestedOutcome: "rejected",
      },
    ) as Record<string, unknown>;
    const artifactWhileOpen = store.buildArtifact(
      ctx,
      "matter-a",
      "claim_defense_matrix",
    ) as Record<string, any>;
    assert.equal(artifactWhileOpen.content.unresolvedPositionReviews, 1);
    assert.equal(artifactWhileOpen.content.positions.length, 0);
    assert.match(artifactWhileOpen.content.sourcePolicy, /Exact source spans/);
    const snapshotWhileOpen = store.buildAgentSnapshot(
      ctx,
      "matter-a",
    ) as Record<string, any>;
    assert.equal(snapshotWhileOpen.exclusions.openPositionReviews, 1);
    assert.equal(snapshotWhileOpen.positions.length, 0);

    db.close();
    db = new LocalDatabase(databasePath);
    initializeLitigationSchema(db);
    store = new LocalLitigationStore(db);
    const restarted = store.getWorkspace(ctx, "matter-a") as Record<
      string,
      Array<Record<string, unknown>>
    >;
    assert.equal(
      restarted.position_reviews.filter((item) => item.status === "open")
        .length,
      1,
    );
    assert.equal(
      restarted.position_reviews.find((item) => item.id === review.id)?.status,
      "open",
    );
    assert.equal(restarted.claim_sources[0].quote_sha256, source.quote_sha256);

    assert.throws(
      () =>
        store.createPositionReview(ctx, "matter-a", String(citedClaim.id), {
          kind: "reconsideration",
          reason: "A duplicate open request must fail.",
          requestedOutcome: "rejected",
        }),
      LitigationValidationError,
    );
    assert.equal(
      store.resolvePositionReview(ctx, "matter-b", String(review.id), {
        resolution: "granted",
      }),
      null,
    );
    assert.equal(
      store.withdrawPositionReview(otherUser, "matter-x", String(review.id)),
      null,
    );
    assert.equal(
      store.createPositionReview(otherUser, "matter-x", String(citedClaim.id), {
        kind: "objection",
        reason: "Cross-user claim lookup must not succeed.",
        requestedOutcome: "rejected",
      }),
      null,
    );

    const proposed = store.createClaim(ctx, "matter-a", {
      kind: "defense",
      title: "An undecided position",
    }) as Record<string, unknown>;
    assert.throws(
      () =>
        store.createPositionReview(ctx, "matter-a", String(proposed.id), {
          kind: "objection",
          reason: "Premature review",
          requestedOutcome: "rejected",
        }),
      LitigationValidationError,
    );
    assert.throws(
      () =>
        store.createPositionReview(ctx, "matter-a", String(citedClaim.id), {
          kind: "withdrawal",
          reason: "Invalid withdrawal target",
          requestedOutcome: "rejected",
        }),
      LitigationValidationError,
    );

    db.prepare(
      "update aletheia_litigation_claims set current_assessment_id = ? where id = ?",
    ).run("stale-version-pointer", citedClaim.id);
    assert.throws(
      () =>
        store.resolvePositionReview(ctx, "matter-a", String(review.id), {
          resolution: "granted",
        }),
      /stale legal assessment version/,
    );
    db.prepare(
      "update aletheia_litigation_claims set current_assessment_id = ? where id = ?",
    ).run(workspace.legal_assessments[0].id, citedClaim.id);

    const granted = store.resolvePositionReview(
      ctx,
      "matter-a",
      String(review.id),
      { resolution: "granted", comment: "Authority is inapplicable." },
    ) as Record<string, unknown>;
    assert.equal(granted.status, "resolved");
    assert.equal(granted.claim_status, "rejected");
    assert.equal(granted.result_assessment_version, 2);
    const versionedWorkspace = store.getWorkspace(ctx, "matter-a") as Record<
      string,
      Array<Record<string, unknown>>
    >;
    const citedAssessments = versionedWorkspace.legal_assessments.filter(
      (item) => item.claim_id === citedClaim.id,
    );
    assert.equal(citedAssessments.length, 2);
    assert.equal(citedAssessments[1].version, 2);
    assert.equal(citedAssessments[1].supersedes_id, citedAssessments[0].id);
    assert.equal(citedAssessments[1].source_review_id, review.id);
    assert.equal(granted.assessment_id, citedAssessments[0].id);
    assert.equal(granted.result_assessment_id, citedAssessments[1].id);
    const appeal = store.createPositionReview(
      ctx,
      "matter-a",
      String(citedClaim.id),
      {
        kind: "reconsideration",
        reason: "Escalate the granted objection for second-level review.",
        requestedOutcome: "confirmed",
        parentReviewId: String(review.id),
      },
    ) as Record<string, unknown>;
    assert.equal(appeal.review_level, 2);
    assert.equal(appeal.parent_review_id, review.id);
    assert.equal(appeal.independent_review, 0);
    assert.equal(appeal.assessment_id, citedAssessments[1].id);
    store.resolvePositionReview(ctx, "matter-a", String(appeal.id), {
      resolution: "upheld",
      comment: "Second-level review leaves the revised position unchanged.",
    });
    assert.throws(
      () =>
        store.createPositionReview(ctx, "matter-a", String(citedClaim.id), {
          kind: "reconsideration",
          reason: "A sibling appeal must not be allowed.",
          requestedOutcome: "confirmed",
          parentReviewId: String(review.id),
        }),
      LitigationValidationError,
    );
    assert.throws(
      () =>
        store.createPositionReview(ctx, "matter-a", String(citedClaim.id), {
          kind: "reconsideration",
          reason: "A third level must not be allowed.",
          requestedOutcome: "confirmed",
          parentReviewId: String(appeal.id),
        }),
      LitigationValidationError,
    );
    const rejectedClaim = claimStatus(store, "matter-a", String(citedClaim.id));
    assert.equal(rejectedClaim?.status, "rejected");
    assert.equal(rejectedClaim?.decision_comment, "Authority is inapplicable.");
    assert.equal(rejectedClaim?.decided_by, "lawyer-a");
    assert.throws(
      () =>
        store.resolvePositionReview(ctx, "matter-a", String(review.id), {
          resolution: "dismissed",
        }),
      LitigationValidationError,
    );

    const withdrawalClaim = store.createClaim(ctx, "matter-a", {
      kind: "defense",
      title: "A position to withdraw",
    }) as Record<string, unknown>;
    store.decideClaim(ctx, "matter-a", String(withdrawalClaim.id), {
      decision: "confirmed",
    });
    const withdrawal = store.createPositionReview(
      ctx,
      "matter-a",
      String(withdrawalClaim.id),
      {
        kind: "withdrawal",
        reason: "The client no longer advances this position.",
        requestedOutcome: "withdrawn",
      },
    ) as Record<string, unknown>;
    store.resolvePositionReview(ctx, "matter-a", String(withdrawal.id), {
      resolution: "granted",
      comment: "Withdrawal approved.",
    });
    assert.equal(
      claimStatus(store, "matter-a", String(withdrawalClaim.id))?.status,
      "withdrawn",
    );

    const retainedClaim = store.createClaim(ctx, "matter-a", {
      kind: "rebuttal",
      title: "An uncited retained position",
    }) as Record<string, unknown>;
    store.decideClaim(ctx, "matter-a", String(retainedClaim.id), {
      decision: "rejected",
    });
    const withdrawnReview = store.createPositionReview(
      ctx,
      "matter-a",
      String(retainedClaim.id),
      {
        kind: "reconsideration",
        reason: "Reconsider rejection.",
        requestedOutcome: "confirmed",
      },
    ) as Record<string, unknown>;
    store.withdrawPositionReview(ctx, "matter-a", String(withdrawnReview.id));
    assert.equal(
      claimStatus(store, "matter-a", String(retainedClaim.id))?.status,
      "rejected",
    );
    assert.throws(
      () =>
        store.resolvePositionReview(
          ctx,
          "matter-a",
          String(withdrawnReview.id),
          { resolution: "granted" },
        ),
      LitigationValidationError,
    );

    const upheldClaim = store.createClaim(ctx, "matter-a", {
      kind: "claim",
      title: "An uncited confirmed position",
    }) as Record<string, unknown>;
    store.decideClaim(ctx, "matter-a", String(upheldClaim.id), {
      decision: "confirmed",
    });
    const upheldReview = store.createPositionReview(
      ctx,
      "matter-a",
      String(upheldClaim.id),
      {
        kind: "objection",
        reason: "Test an upheld outcome.",
        requestedOutcome: "rejected",
      },
    ) as Record<string, unknown>;
    store.resolvePositionReview(ctx, "matter-a", String(upheldReview.id), {
      resolution: "upheld",
    });
    assert.equal(
      claimStatus(store, "matter-a", String(upheldClaim.id))?.status,
      "confirmed",
    );

    const independentClaim = store.createClaim(ctx, "matter-a", {
      kind: "defense",
      title: "A position requiring distinct authenticated reviewers",
    }) as Record<string, unknown>;
    store.decideClaim(ctx, "matter-a", String(independentClaim.id), {
      decision: "confirmed",
    });
    const independentLevelOne = store.createPositionReview(
      ctx,
      "matter-a",
      String(independentClaim.id),
      {
        kind: "objection",
        reason: "Requester challenges the confirmed position.",
        requestedOutcome: "rejected",
      },
      undefined,
      "counsel-requester",
    ) as Record<string, unknown>;
    assert.equal(independentLevelOne.user_id, "lawyer-a");
    assert.equal(independentLevelOne.created_by, "counsel-requester");
    assert.throws(
      () =>
        store.resolvePositionReview(
          ctx,
          "matter-a",
          String(independentLevelOne.id),
          { resolution: "upheld" },
          undefined,
          "counsel-requester",
          true,
        ),
      /cannot resolve their own/,
    );
    const independentLevelOneResult = store.resolvePositionReview(
      ctx,
      "matter-a",
      String(independentLevelOne.id),
      { resolution: "upheld", comment: "Independent first-level review." },
      undefined,
      "reviewer-one",
      true,
    ) as Record<string, unknown>;
    assert.equal(independentLevelOneResult.resolved_by, "reviewer-one");
    assert.equal(independentLevelOneResult.independent_review, 1);

    const independentAppeal = store.createPositionReview(
      ctx,
      "matter-a",
      String(independentClaim.id),
      {
        kind: "reconsideration",
        reason: "Escalate to a second distinct reviewer.",
        requestedOutcome: "rejected",
        parentReviewId: String(independentLevelOne.id),
      },
      undefined,
      "counsel-requester",
    ) as Record<string, unknown>;
    assert.throws(
      () =>
        store.resolvePositionReview(
          ctx,
          "matter-a",
          String(independentAppeal.id),
          { resolution: "granted" },
          undefined,
          "reviewer-one",
          true,
        ),
      /must differ from the level-1 reviewer/,
    );
    const independentAppealResult = store.resolvePositionReview(
      ctx,
      "matter-a",
      String(independentAppeal.id),
      { resolution: "granted", comment: "Second reviewer grants appeal." },
      undefined,
      "reviewer-two",
      true,
    ) as Record<string, unknown>;
    assert.equal(independentAppealResult.resolved_by, "reviewer-two");
    assert.equal(independentAppealResult.independent_review, 1);
    const independentWorkspace = store.getWorkspace(ctx, "matter-a") as Record<
      string,
      Array<Record<string, unknown>>
    >;
    const independentAssessment = independentWorkspace.legal_assessments.find(
      (item) => item.id === independentAppealResult.result_assessment_id,
    );
    assert.equal(independentAssessment?.user_id, "lawyer-a");
    assert.equal(independentAssessment?.created_by, "reviewer-two");

    const requesterWithdrawalClaim = store.createClaim(ctx, "matter-a", {
      kind: "rebuttal",
      title: "A review request only its requester may withdraw",
    }) as Record<string, unknown>;
    store.decideClaim(ctx, "matter-a", String(requesterWithdrawalClaim.id), {
      decision: "rejected",
    });
    const requesterWithdrawal = store.createPositionReview(
      ctx,
      "matter-a",
      String(requesterWithdrawalClaim.id),
      {
        kind: "reconsideration",
        reason: "Requester-controlled withdrawal test.",
        requestedOutcome: "confirmed",
      },
      undefined,
      "counsel-requester",
    ) as Record<string, unknown>;
    assert.throws(
      () =>
        store.withdrawPositionReview(
          ctx,
          "matter-a",
          String(requesterWithdrawal.id),
          undefined,
          "reviewer-one",
        ),
      /Only the requester/,
    );
    store.withdrawPositionReview(
      ctx,
      "matter-a",
      String(requesterWithdrawal.id),
      undefined,
      "counsel-requester",
    );
    const finalArtifact = store.buildArtifact(
      ctx,
      "matter-a",
      "litigation_brief",
    ) as Record<string, any>;
    assert.equal(finalArtifact.content.unresolvedPositionReviews, 0);
    assert.ok(
      finalArtifact.content.uncitedLegalPositions.some(
        (item: Record<string, unknown>) => item.claimId === upheldClaim.id,
      ),
    );
    const finalSnapshot = store.buildAgentSnapshot(ctx, "matter-a") as Record<
      string,
      any
    >;
    assert.ok(finalSnapshot.exclusions.uncitedPositions >= 1);
    assert.equal(
      finalSnapshot.positions.some(
        (item: Record<string, unknown>) => item.id === upheldClaim.id,
      ),
      false,
    );

    const latestAssessment = citedAssessments[1];
    db.prepare(
      "update aletheia_legal_assessments set payload_sha256 = ? where id = ?",
    ).run("tampered-assessment-hash", latestAssessment.id);
    assert.throws(
      () => store.buildArtifact(ctx, "matter-a", "litigation_brief"),
      /assessment integrity check failed/,
    );
    db.prepare(
      "update aletheia_legal_assessments set payload_sha256 = ? where id = ?",
    ).run(latestAssessment.payload_sha256, latestAssessment.id);

    db.prepare("update aletheia_document_chunks set text = ? where id = ?").run(
      `${chunkText} tampered`,
      "chunk-a",
    );
    assert.throws(
      () => store.buildArtifact(ctx, "matter-a", "litigation_brief"),
      LitigationValidationError,
    );

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          suite: "aletheia-position-review-audit-v1",
          checks: [
            "persistent restart",
            "claim exact source span and hashes",
            "matter and user isolation",
            "workspace pollution row exclusion",
            "decision and assessment audit rollback",
            "audit callback failure rolls back review lifecycle",
            "immutable assessment version lineage",
            "stale review target rejection",
            "assessment hash tamper fail-closed",
            "bounded two-level review chain without branching",
            "non-independent single-user review disclosure",
            "owner-scoped rows with authenticated actor provenance",
            "multi-principal self-review prohibition",
            "distinct level-2 reviewer enforcement",
            "requester-only withdrawal",
            "single open review per claim",
            "review state transition validation",
            "open review artifact exclusion",
            "open review agent snapshot exclusion",
            "granted status change and decision provenance",
            "granted withdrawal and request withdrawal semantics",
            "upheld outcome preserves claim",
            "uncited legal position warning",
            "uncited legal position agent snapshot exclusion",
            "source tamper fail-closed",
          ],
          transactionNote:
            "Review state, granted claim updates, and the authoritative repository audit callback commit atomically; artifact staleness and matter touch run after commit.",
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

main();
