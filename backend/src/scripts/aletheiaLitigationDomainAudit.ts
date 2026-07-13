import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { LocalDatabase } from "../lib/aletheia/localDatabase";
import {
  initializeLitigationSchema,
  LitigationValidationError,
  LocalLitigationStore,
} from "../lib/aletheia/litigationStore";

function baseSchema(db: LocalDatabase) {
  db.exec(`
    PRAGMA foreign_keys = ON;
    create table aletheia_matters (
      id text primary key,
      user_id text not null,
      template text not null
    );
    create table aletheia_matter_documents (
      id text primary key,
      matter_id text not null references aletheia_matters(id) on delete cascade,
      user_id text not null,
      name text not null,
      document_type text not null default 'other',
      parsed_status text not null default 'pending',
      metadata text not null default '{}'
    );
    create table aletheia_document_chunks (
      id text primary key,
      matter_id text not null references aletheia_matters(id) on delete cascade,
      document_id text not null references aletheia_matter_documents(id) on delete cascade,
      user_id text not null,
      page integer,
      section text,
      text text not null,
      quote_start integer not null default 0,
      metadata text not null default '{}'
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
    create table aletheia_agent_runs (
      id text primary key,
      matter_id text not null,
      user_id text not null,
      workflow text not null,
      goal text not null,
      status text not null,
      metadata text not null default '{}'
    );
    create table aletheia_agent_steps (
      id text primary key,
      run_id text not null,
      matter_id text not null,
      user_id text not null,
      step_key text not null,
      title text not null,
      sequence integer not null,
      handler text,
      status text not null,
      output text not null default '{}'
    );
  `);
  initializeLitigationSchema(db);
}

function seed(db: LocalDatabase) {
  db.prepare(
    "insert into aletheia_matters (id, user_id, template) values (?, ?, ?)",
  ).run("matter-a", "lawyer-a", "civil_litigation");
  db.prepare(
    "insert into aletheia_matters (id, user_id, template) values (?, ?, ?)",
  ).run("matter-b", "lawyer-a", "civil_litigation");
  db.prepare(
    "insert into aletheia_matters (id, user_id, template) values (?, ?, ?)",
  ).run("contract-a", "lawyer-a", "legal_matter_review");
  db.prepare(
    `insert into aletheia_matter_documents
      (id, matter_id, user_id, name, document_type, parsed_status, metadata)
     values (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "doc-a",
    "matter-a",
    "lawyer-a",
    "court-notice.txt",
    "court_filing",
    "parsed",
    JSON.stringify({ originalSha256: "a".repeat(64), pageCount: 1 }),
  );
  db.prepare(
    `insert into aletheia_document_chunks (
      id, matter_id, document_id, user_id, page, section, text, quote_start
    ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "chunk-a",
    "matter-a",
    "doc-a",
    "lawyer-a",
    1,
    "notice",
    "法院通知：本案于2026年8月10日开庭。被告应在指定期限内提交证据。",
    120,
  );
  db.prepare(
    `insert into aletheia_document_chunks (
      id, matter_id, document_id, user_id, page, section, text, quote_start,
      metadata
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "chunk-low-ocr",
    "matter-a",
    "doc-a",
    "lawyer-a",
    2,
    "scan",
    "扫描件记载：被告已于2026年7月1日付款。",
    240,
    JSON.stringify({
      ocrProvenance: { engine: "apple-vision", page: 2, confidence: 0.55 },
    }),
  );
}

function main() {
  const db = new LocalDatabase(":memory:");
  try {
    baseSchema(db);
    seed(db);
    const store = new LocalLitigationStore(db);
    const ctx = { userId: "lawyer-a" };
    const chunkText =
      "法院通知：本案于2026年8月10日开庭。被告应在指定期限内提交证据。";
    const quoteStart = chunkText.indexOf("2026年8月10日");
    const quoteEnd = quoteStart + "2026年8月10日".length;

    const fact = store.createFact(ctx, "matter-a", {
      statement: "法院通知本案于2026年8月10日开庭。",
      occurredAt: "2026-08-10T09:00:00+08:00",
      datePrecision: "day",
      sourceRelation: "supports",
      helpfulness: "neutral",
      confidence: "high",
      createdBy: "agent",
      source: { sourceChunkId: "chunk-a", quoteStart, quoteEnd },
    }) as Record<string, unknown>;
    assert.equal(fact.status, "proposed");

    const span = db
      .prepare("select * from aletheia_source_spans where matter_id = ?")
      .get("matter-a") as Record<string, unknown>;
    assert.equal(span.quote, "2026年8月10日");
    assert.equal(span.document_quote_start, 120 + quoteStart);
    assert.equal(
      span.source_chunk_sha256,
      createHash("sha256").update(chunkText).digest("hex"),
    );
    assert.equal(
      span.quote_sha256,
      createHash("sha256").update("2026年8月10日").digest("hex"),
    );

    assert.throws(
      () =>
        store.createFact(ctx, "matter-b", {
          statement: "Cross-matter source must fail.",
          source: { sourceChunkId: "chunk-a", quoteStart, quoteEnd },
        }),
      LitigationValidationError,
    );
    assert.throws(
      () =>
        store.createFact(ctx, "contract-a", {
          statement: "Wrong domain pack must fail.",
        }),
      LitigationValidationError,
    );

    const decidedFact = store.decideFact(ctx, "matter-a", String(fact.id), {
      decision: "confirmed",
      comment: "Checked against the notice.",
    }) as Record<string, unknown>;
    assert.equal(decidedFact.status, "confirmed");
    assert.equal(
      store.decideFact(ctx, "matter-a", String(fact.id), {
        decision: "rejected",
      }),
      null,
      "A decided proposal must not be decided twice.",
    );

    const lowOcrText = "扫描件记载：被告已于2026年7月1日付款。";
    const lowQuoteStart = lowOcrText.indexOf("2026年7月1日付款");
    const lowQuoteEnd = lowQuoteStart + "2026年7月1日付款".length;
    const lowOcrFact = store.createFact(ctx, "matter-a", {
      statement: "被告于2026年7月1日付款。",
      source: {
        sourceChunkId: "chunk-low-ocr",
        quoteStart: lowQuoteStart,
        quoteEnd: lowQuoteEnd,
      },
    }) as Record<string, unknown>;
    const lowOcrSource = db
      .prepare(
        `select s.* from aletheia_source_spans s
          join aletheia_litigation_fact_sources fs on fs.source_span_id = s.id
         where fs.fact_id = ?`,
      )
      .get(lowOcrFact.id) as Record<string, unknown>;
    const lowMetadata = JSON.parse(String(lowOcrSource.metadata));
    assert.equal(lowMetadata.ocrProvenance.confidence, 0.55);
    assert.match(lowMetadata.ocrProvenanceSha256, /^sha256:[a-f0-9]{64}$/);
    assert.throws(
      () =>
        store.decideFact(ctx, "matter-a", String(lowOcrFact.id), {
          decision: "confirmed",
        }),
      /must be compared with the original scan/,
    );
    assert.throws(
      () =>
        store.verifySourceSpanOriginal(
          ctx,
          "matter-a",
          String(lowOcrSource.id),
          "too short",
        ),
      /between 10 and 2000 characters/,
    );
    assert.equal(
      store.verifySourceSpanOriginal(
        ctx,
        "matter-b",
        String(lowOcrSource.id),
        "Compared every character against the original scan.",
      ),
      null,
      "Cross-matter verification must not reveal a source span.",
    );
    const verification = store.verifySourceSpanOriginal(
      ctx,
      "matter-a",
      String(lowOcrSource.id),
      "Compared the date and payment wording against the original scan.",
    ) as Record<string, unknown>;
    assert.equal(verification.source_span_id, lowOcrSource.id);
    const workspaceAfterVerification = store.getWorkspace(
      ctx,
      "matter-a",
    ) as Record<string, Array<Record<string, unknown>>>;
    assert.equal(
      workspaceAfterVerification.fact_sources.find(
        (item) => item.fact_id === lowOcrFact.id,
      )?.current_verification_id,
      verification.id,
    );
    assert.equal(
      (
        store.decideFact(ctx, "matter-a", String(lowOcrFact.id), {
          decision: "confirmed",
        }) as Record<string, unknown>
      ).status,
      "confirmed",
    );

    const tamperedFact = store.createFact(ctx, "matter-a", {
      statement: "付款事实待核验。",
      source: {
        sourceChunkId: "chunk-low-ocr",
        quoteStart: lowQuoteStart,
        quoteEnd: lowQuoteEnd,
      },
    }) as Record<string, unknown>;
    const tamperedSource = db
      .prepare(
        `select s.* from aletheia_source_spans s
          join aletheia_litigation_fact_sources fs on fs.source_span_id = s.id
         where fs.fact_id = ?`,
      )
      .get(tamperedFact.id) as Record<string, unknown>;
    store.verifySourceSpanOriginal(
      ctx,
      "matter-a",
      String(tamperedSource.id),
      "Compared the quoted payment wording against the original scan.",
    );
    db.prepare(
      "update aletheia_document_chunks set metadata = ? where id = ?",
    ).run(
      JSON.stringify({
        ocrProvenance: { engine: "apple-vision", page: 2, confidence: 0.95 },
      }),
      "chunk-low-ocr",
    );
    assert.throws(
      () =>
        store.decideFact(ctx, "matter-a", String(tamperedFact.id), {
          decision: "confirmed",
        }),
      /Source text changed after citation/,
      "Changed OCR provenance must invalidate the old verification.",
    );
    db.prepare(
      "update aletheia_document_chunks set metadata = ? where id = ?",
    ).run(
      JSON.stringify({
        ocrProvenance: { engine: "apple-vision", page: 2, confidence: 0.55 },
      }),
      "chunk-low-ocr",
    );

    const claim = store.createClaim(ctx, "matter-a", {
      kind: "defense",
      title: "Hearing preparation must be completed before 10 August 2026.",
      legalBasis: "Court hearing notice",
      createdBy: "agent",
      source: { sourceChunkId: "chunk-a", quoteStart, quoteEnd },
    }) as Record<string, unknown>;
    const element = store.createElement(ctx, "matter-a", String(claim.id), {
      title: "Confirmed hearing date",
      sequence: 1,
    }) as Record<string, unknown>;
    const link = store.linkElementFact(ctx, "matter-a", String(element.id), {
      factId: String(fact.id),
      relation: "supports",
    }) as Record<string, unknown>;
    assert.equal(link.relation, "supports");
    const authorityQuote = "A verified hearing notice controls preparation duties.";
    const authorityContent = `${authorityQuote} This source is effective throughout 2026.`;
    db.prepare(
      `insert into aletheia_litigation_legal_authority_versions (
         id, matter_id, user_id, jurisdiction, authority_type, title, issuer,
         official_identifier, version_label, source_reference, content,
         content_sha256, effective_from, effective_to, status,
         verification_comment, verified_by, verified_at, created_by, created_at
       ) values (?, ?, ?, 'CN', 'regulation', ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 'verified', ?, ?, ?, ?, ?)`,
    ).run(
      "authority-a",
      "matter-a",
      "lawyer-a",
      "Verified hearing preparation rule",
      "Verified court administration",
      "HEARING-PREP-2026",
      "2026 official copy",
      "Named official publication",
      authorityContent,
      createHash("sha256").update(authorityContent).digest("hex"),
      "2026-01-01",
      "2026-12-31",
      "Counsel checked the named official publication.",
      "lawyer-a",
      "2026-07-01T00:00:00.000Z",
      "lawyer-a",
      "2026-07-01T00:00:00.000Z",
    );
    db.prepare(
      `insert into aletheia_litigation_position_authorities (
         id, matter_id, user_id, claim_id, authority_version_id,
         applicability_date, provision_reference, exact_quote, quote_sha256,
         rationale, status, created_by, created_at
       ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    ).run(
      "position-authority-a",
      "matter-a",
      "lawyer-a",
      claim.id,
      "authority-a",
      "2026-07-10",
      "Hearing preparation duty",
      authorityQuote,
      createHash("sha256").update(authorityQuote).digest("hex"),
      "The verified rule directly governs preparation for this hearing.",
      "lawyer-a",
      "2026-07-01T00:00:00.000Z",
    );
    const decidedClaim = store.decideClaim(ctx, "matter-a", String(claim.id), {
      decision: "confirmed",
      comment: "Approved legal position.",
    }) as Record<string, unknown>;
    assert.equal(decidedClaim.status, "confirmed");
    const decidedElement = store.decideElement(
      ctx,
      "matter-a",
      String(element.id),
      { decision: "confirmed", comment: "Approved legal element." },
    ) as Record<string, unknown>;
    assert.equal(decidedElement.status, "confirmed");
    assert.equal(
      store.decideElement(ctx, "matter-a", String(element.id), {
        decision: "rejected",
      }),
      null,
      "A decided legal element must not be decided twice.",
    );

    const event = store.createProceduralEvent(ctx, "matter-a", {
      eventType: "hearing_notice",
      title: "Hearing notice received",
      occurredAt: "2026-07-10T10:00:00+08:00",
      createdBy: "agent",
      source: { sourceChunkId: "chunk-a", quoteStart, quoteEnd },
    }) as Record<string, unknown>;
    const decidedEvent = store.decideProceduralEvent(
      ctx,
      "matter-a",
      String(event.id),
      { decision: "confirmed", comment: "Verified against the court notice." },
    ) as Record<string, unknown>;
    assert.equal(decidedEvent.status, "confirmed");
    assert.equal(
      store.decideProceduralEvent(ctx, "matter-a", String(event.id), {
        decision: "rejected",
      }),
      null,
      "A decided procedural event must not be decided twice.",
    );
    const deadline = store.createDeadline(ctx, "matter-a", {
      title: "Internal evidence review cutoff",
      dueAt: "2026-08-03T18:00:00+08:00",
      triggeringEventId: String(event.id),
      ruleLabel: "Internal hearing preparation policy",
      ruleVersion: "firm-policy-2026-01",
      calculation: "Seven calendar days before the hearing.",
      createdBy: "agent",
      source: { sourceChunkId: "chunk-a", quoteStart, quoteEnd },
    }) as Record<string, unknown>;
    assert.equal(deadline.status, "proposed");
    const decidedDeadline = store.decideDeadline(
      ctx,
      "matter-a",
      String(deadline.id),
      { decision: "confirmed", comment: "Approved by responsible lawyer." },
    ) as Record<string, unknown>;
    assert.equal(decidedDeadline.status, "confirmed");

    const workspace = store.getWorkspace(ctx, "matter-a") as Record<
      string,
      unknown[]
    >;
    assert.equal(workspace.facts.length, 3);
    assert.equal(workspace.fact_sources.length, 3);
    assert.equal(workspace.claims.length, 1);
    assert.equal(workspace.elements.length, 1);
    assert.equal(workspace.element_facts.length, 1);
    assert.equal(workspace.element_evidence_statuses.length, 1);
    assert.deepEqual(workspace.position_authority_statuses[0], {
      claim_id: claim.id,
      status: "satisfied",
      valid_link_ids: ["position-authority-a"],
      invalid_link_ids: [],
    });
    assert.deepEqual(workspace.element_evidence_statuses[0], {
      element_id: element.id,
      status: "supported",
      total_links: 1,
      confirmed_supports: 1,
      confirmed_contradictions: 0,
      pending_links: 0,
      rejected_links: 0,
      uncited_confirmed_links: 0,
    });
    assert.equal(workspace.procedural_events.length, 1);
    assert.equal(workspace.deadlines.length, 1);

    for (const kind of [
      "evidence_catalog",
      "claim_defense_matrix",
      "procedural_clock",
      "litigation_brief",
      "hearing_plan",
      "hearing_bundle_index",
    ] as const) {
      const artifact = store.buildArtifact(ctx, "matter-a", kind) as Record<
        string,
        any
      >;
      assert.equal(artifact.content.kind, kind);
      assert.equal(artifact.content.sourceIntegrity, "verified");
      assert.equal(artifact.content.statePolicy, "confirmed_only");
      if (kind === "hearing_bundle_index") {
        assert.equal(artifact.content.hearingBundleEntries.length, 1);
        assert.equal(
          artifact.content.hearingBundleEntries[0].exhibitNumber,
          "EX-001",
        );
        assert.equal(artifact.content.status, "ready_for_review");
        assert.equal(
          artifact.content.hearingBundleEntries[0].originalSha256,
          "a".repeat(64),
        );
        assert.equal(
          artifact.content.bundlePagination.mode,
          "continuous_source_sequence",
        );
        assert.equal(
          artifact.content.hearingBundleEntries[0].bundlePageStart,
          1,
        );
        assert.equal(artifact.content.hearingBundleEntries[0].bundlePageEnd, 1);
        assert.equal(artifact.validationErrors.length, 0);
      }
    }
    const customProfile = store.updateProfile(ctx, "matter-a", {
      organizationName: "Aletheia Trial Team",
      court: "Shanghai Commercial Court",
      caseNumber: "2026-CIV-001",
      exhibitPrefix: "DEF",
      exhibitStart: 12,
      paginationPolicy: "source_native",
      documentTemplateId: "neutral-review-memorandum",
      documentTemplateVersion: 1,
    }) as Record<string, unknown>;
    assert.equal(customProfile.exhibit_prefix, "DEF");
    assert.equal(
      customProfile.document_template_id,
      "neutral-review-memorandum",
    );
    const customBundle = store.buildArtifact(
      ctx,
      "matter-a",
      "hearing_bundle_index",
    ) as Record<string, any>;
    assert.equal(
      customBundle.content.hearingBundleEntries[0].exhibitNumber,
      "DEF-012",
    );
    assert.equal(
      customBundle.content.bundlePagination.mode,
      "source_native_only",
    );
    assert.equal(
      customBundle.content.documentTemplate.id,
      "neutral-review-memorandum",
    );
    assert.match(
      customBundle.content.documentTemplate.templateHash,
      /^sha256:[a-f0-9]{64}$/,
    );
    assert.throws(
      () =>
        store.updateProfile(ctx, "matter-a", {
          exhibitPrefix: "EX",
          exhibitStart: 1,
          paginationPolicy: "auto",
          documentTemplateId: "unapproved-template",
          documentTemplateVersion: 1,
        }),
      LitigationValidationError,
    );
    assert.throws(
      () =>
        store.updateProfile(ctx, "matter-a", {
          exhibitPrefix: "../../bad",
          exhibitStart: 1,
          paginationPolicy: "auto",
        }),
      LitigationValidationError,
    );
    store.updateProfile(ctx, "matter-a", {
      exhibitPrefix: "EX",
      exhibitStart: 1,
      paginationPolicy: "auto",
      documentTemplateId: "cn-litigation-working-paper",
      documentTemplateVersion: 1,
    });
    db.prepare(
      "update aletheia_matter_documents set metadata = '{}' where id = ?",
    ).run("doc-a");
    const blockedBundle = store.buildArtifact(
      ctx,
      "matter-a",
      "hearing_bundle_index",
    ) as Record<string, any>;
    assert.equal(blockedBundle.content.status, "not_ready");
    assert.equal(
      blockedBundle.content.bundlePagination.mode,
      "source_native_only",
    );
    assert.ok(
      blockedBundle.validationErrors.some(
        (item: Record<string, unknown>) =>
          item.code === "bundle_source_hash_missing",
      ),
    );
    db.prepare(
      "update aletheia_matter_documents set metadata = ? where id = ?",
    ).run(
      JSON.stringify({ originalSha256: "a".repeat(64), pageCount: 1 }),
      "doc-a",
    );
    const evalRun = store.runEvalSuite(ctx, "matter-a") as Record<string, any>;
    assert.equal(evalRun.passed, 17);
    assert.equal(evalRun.total, 17);
    assert.equal(evalRun.results.length, 17);
    assert.equal(
      (store.listEvalRuns(ctx, "matter-a") as Array<Record<string, any>>)
        .length,
      1,
    );
    const agentSnapshot = store.buildAgentSnapshot(ctx, "matter-a") as Record<
      string,
      any
    >;
    assert.equal(agentSnapshot.statePolicy, "confirmed_cited_no_open_review");
    assert.equal(agentSnapshot.sourceIntegrity, "verified");
    assert.match(agentSnapshot.snapshotHash, /^sha256:[a-f0-9]{64}$/);
    assert.match(agentSnapshot.stateHash, /^sha256:[a-f0-9]{64}$/);
    assert.equal(
      (store.buildAgentSnapshot(ctx, "matter-a") as Record<string, any>)
        .stateHash,
      agentSnapshot.stateHash,
      "stable state binding must not change only because generatedAt changed",
    );
    const originalFactStatement = String(
      (
        db
          .prepare(
            "select statement from aletheia_litigation_facts where id = ?",
          )
          .get(fact.id) as { statement: string }
      ).statement,
    );
    db.prepare(
      "update aletheia_litigation_facts set statement = ? where id = ?",
    ).run(`${originalFactStatement} changed`, fact.id);
    assert.notEqual(
      (store.buildAgentSnapshot(ctx, "matter-a") as Record<string, any>)
        .stateHash,
      agentSnapshot.stateHash,
      "stable state binding must change when confirmed cited state changes",
    );
    db.prepare(
      "update aletheia_litigation_facts set statement = ? where id = ?",
    ).run(originalFactStatement, fact.id);
    assert.equal(agentSnapshot.facts.length, 2);
    assert.equal(agentSnapshot.positions.length, 1);
    assert.deepEqual(agentSnapshot.exclusions, {
      uncitedFacts: 0,
      uncitedPositions: 0,
      positionsMissingVerifiedAuthority: 0,
      openPositionReviews: 0,
    });
    const pendingElement = store.createElement(
      ctx,
      "matter-a",
      String(claim.id),
      { title: "Payment performance", sequence: 2 },
    ) as Record<string, unknown>;
    const uncitedFact = store.createFact(ctx, "matter-a", {
      statement: "Payment was allegedly made without a cited record.",
    }) as Record<string, unknown>;
    store.linkElementFact(ctx, "matter-a", String(pendingElement.id), {
      factId: String(uncitedFact.id),
      relation: "supports",
    });
    let evidenceStatus = (
      store.getWorkspace(ctx, "matter-a") as Record<string, any>
    ).element_evidence_statuses.find(
      (item: Record<string, unknown>) => item.element_id === pendingElement.id,
    );
    assert.equal(evidenceStatus.status, "pending_review");
    store.decideFact(ctx, "matter-a", String(uncitedFact.id), {
      decision: "confirmed",
    });
    evidenceStatus = (
      store.getWorkspace(ctx, "matter-a") as Record<string, any>
    ).element_evidence_statuses.find(
      (item: Record<string, unknown>) => item.element_id === pendingElement.id,
    );
    assert.equal(evidenceStatus.status, "needs_source");
    const rejectedFact = store.createFact(ctx, "matter-a", {
      statement: "Rejected fact must not be linked as new evidence.",
    }) as Record<string, unknown>;
    store.decideFact(ctx, "matter-a", String(rejectedFact.id), {
      decision: "rejected",
    });
    assert.equal(
      store.linkElementFact(ctx, "matter-a", String(pendingElement.id), {
        factId: String(rejectedFact.id),
        relation: "supports",
      }),
      null,
    );
    assert.throws(
      () =>
        store.linkElementFact(ctx, "matter-a", String(pendingElement.id), {
          factId: String(fact.id),
          relation: "gap" as "supports",
        }),
      /must support or contradict/,
    );
    const rollbackElement = store.createElement(
      ctx,
      "matter-a",
      String(claim.id),
      { title: "Rollback evidence link", sequence: 3 },
    ) as Record<string, unknown>;
    const linksBeforeRollback = Number(
      (
        db
          .prepare(
            "select count(*) as count from aletheia_litigation_element_facts",
          )
          .get() as { count: number }
      ).count,
    );
    assert.throws(
      () =>
        store.linkElementFact(
          ctx,
          "matter-a",
          String(rollbackElement.id),
          { factId: String(fact.id), relation: "supports" },
          () => {
            throw new Error("simulated audit failure");
          },
        ),
      /simulated audit failure/,
    );
    assert.equal(
      Number(
        (
          db
            .prepare(
              "select count(*) as count from aletheia_litigation_element_facts",
            )
            .get() as { count: number }
        ).count,
      ),
      linksBeforeRollback,
    );
    db.prepare(
      "update aletheia_litigation_facts set user_id = ? where id = ?",
    ).run("lawyer-b", uncitedFact.id);
    assert.equal(
      (store.getWorkspace(ctx, "matter-a") as Record<string, any>).facts.some(
        (item: Record<string, unknown>) => item.id === uncitedFact.id,
      ),
      false,
    );
    assert.equal(
      store.linkElementFact(ctx, "matter-a", String(rollbackElement.id), {
        factId: String(uncitedFact.id),
        relation: "supports",
      }),
      null,
    );
    const lowOcrClaim = store.createClaim(ctx, "matter-a", {
      kind: "defense",
      title: "The payment shown in the scan supports a performance defense.",
      source: {
        sourceChunkId: "chunk-low-ocr",
        quoteStart: lowQuoteStart,
        quoteEnd: lowQuoteEnd,
      },
    }) as Record<string, unknown>;
    const lowOcrClaimSource = db
      .prepare(
        `select s.* from aletheia_source_spans s
          join aletheia_litigation_claim_sources cs on cs.source_span_id = s.id
         where cs.claim_id = ?`,
      )
      .get(lowOcrClaim.id) as Record<string, unknown>;
    assert.throws(
      () =>
        store.decideClaim(ctx, "matter-a", String(lowOcrClaim.id), {
          decision: "confirmed",
        }),
      /must be compared with the original scan/,
      "Legal positions must use the same OCR verification gate as facts.",
    );
    store.verifySourceSpanOriginal(
      ctx,
      "matter-a",
      String(lowOcrClaimSource.id),
      "Compared the payment date and wording against the original scan.",
    );
    assert.equal(
      (
        store.decideClaim(ctx, "matter-a", String(lowOcrClaim.id), {
          decision: "confirmed",
          comment:
            "OCR text comparison recorded; legal effect reviewed separately.",
        }) as Record<string, unknown>
      ).status,
      "confirmed",
    );
    db.prepare("update aletheia_document_chunks set text = ? where id = ?").run(
      `${chunkText} altered`,
      "chunk-a",
    );
    const tamperedEvalRun = store.runEvalSuite(ctx, "matter-a") as Record<
      string,
      any
    >;
    assert.ok(tamperedEvalRun.passed < tamperedEvalRun.total);
    assert.equal(
      tamperedEvalRun.results.find(
        (item: Record<string, unknown>) =>
          item.case_id === "source_hash_tamper_badcase",
      )?.passed,
      false,
    );
    assert.equal(
      tamperedEvalRun.results.find(
        (item: Record<string, unknown>) =>
          item.case_id === "hearing_bundle_pagination_integrity",
      )?.passed,
      false,
    );
    assert.equal(
      (store.listEvalRuns(ctx, "matter-a") as Array<Record<string, any>>)
        .length,
      2,
    );
    assert.throws(
      () => store.buildArtifact(ctx, "matter-a", "litigation_brief"),
      LitigationValidationError,
      "Artifact generation must fail when a cited source chunk changes.",
    );
    assert.throws(
      () => store.buildAgentSnapshot(ctx, "matter-a"),
      LitigationValidationError,
      "Agent snapshot compilation must fail when a cited source chunk changes.",
    );

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          suite: "aletheia-civil-litigation-domain-v1",
          checks: [
            "source span exact slicing and hashing",
            "low-confidence OCR verification and provenance tamper gate",
            "matter and domain isolation",
            "single-decision fact proposal",
            "claim-element-fact relationship",
            "source-aware element evidence readiness and isolation",
            "single-decision legal element confirmation",
            "single-decision procedural event confirmation",
            "procedural event and deadline candidate",
            "single-decision deadline confirmation",
            "workspace projection",
            "confirmed-state litigation artifact projections",
            "artifact source-integrity fail-closed gate",
            "instance-hash and stable-state-bound cited-only agent snapshot",
            "persisted deterministic golden and bad-case eval suite",
          ],
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    db.close();
  }
}

main();
