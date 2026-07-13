import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";

async function request(
  baseUrl: string,
  pathname: string,
  options: { method?: string; body?: unknown } = {},
) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method ?? "GET",
    headers:
      options.body === undefined
        ? undefined
        : { "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { response, body: (await response.json()) as Record<string, any> };
}

async function main() {
  const dataDir = mkdtempSync(
    path.join(os.tmpdir(), "vera-authority-version-"),
  );
  process.env.ALETHEIA_AUTH_MODE = "single_user";
  process.env.ALETHEIA_DATA_DIR = dataDir;
  process.env.ALETHEIA_LOCAL_USER_ID = "authority-auditor";
  process.env.ALETHEIA_LOCAL_USER_EMAIL = "authority@vera.local";
  process.env.ALETHEIA_APPLICATION_ENCRYPTION = "disabled";
  process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";

  let server: http.Server | null = null;
  try {
    const [{ createAletheiaRepository }, { litigationRouter }] =
      await Promise.all([
        import("../lib/aletheia"),
        import("../routes/litigation"),
      ]);
    const repository = createAletheiaRepository();
    const ctx = { userId: "authority-auditor" };
    const matter = (await repository.createMatter(ctx, {
      title: "Legal authority version audit",
      objective: "Verify version-effective legal support.",
      template: "civil_litigation",
      status: "in_progress",
      riskLevel: "high",
      clientOrProject: "Authority audit",
      sourceProjectId: null,
      sharedWith: [],
      metadata: {},
    })) as Record<string, any>;
    const evidenceText =
      "The contract set payment due on 1 September 2026. The defendant did not pay on the agreed date.";
    await repository.uploadMatterDocument(ctx, matter.id, {
      filename: "payment-term.txt",
      mimeType: "text/plain",
      sizeBytes: Buffer.byteLength(evidenceText, "utf8"),
      buffer: Buffer.from(evidenceText, "utf8"),
    });
    const evidenceResults = (await repository.searchMatterDocuments(
      ctx,
      matter.id,
      { query: "payment due", limit: 5 },
    )) as Array<Record<string, any>>;
    assert.equal(evidenceResults.length, 1);
    const claim = (await repository.createLitigationClaim(ctx, matter.id, {
      kind: "claim",
      title: "Payment was due under the contract.",
      legalBasis: "Civil Code contract performance rule",
      confidence: "medium",
      uncertainty: "The applicable version requires verification.",
      sourceRelation: "supports",
      source: {
        sourceChunkId: evidenceResults[0].chunk_id,
        quoteStart: evidenceResults[0].quote_start,
        quoteEnd: evidenceResults[0].quote_end,
      },
      createdBy: "human",
    })) as Record<string, any>;
    await repository.decideLitigationClaim(ctx, matter.id, claim.id, {
      decision: "confirmed",
      comment: "Counsel confirmed the legal issue for authority linking.",
    });
    const missingAuthorityWorkspace = (await repository.getLitigationWorkspace(
      ctx,
      matter.id,
    )) as Record<string, any>;
    assert.equal(
      missingAuthorityWorkspace.position_authority_statuses.find(
        (item: Record<string, unknown>) => item.claim_id === claim.id,
      ).status,
      "missing",
    );
    const incompleteArtifact = (await repository.generateLitigationArtifact(
      ctx,
      matter.id,
      "claim_defense_matrix",
    )) as Record<string, any>;
    assert.equal(
      incompleteArtifact.validation_errors.some(
        (item: Record<string, unknown>) =>
          item.code === "verified_legal_authority_missing" &&
          item.claimId === claim.id,
      ),
      true,
    );
    const incompleteSnapshot = (await repository.prepareLitigationAgentSnapshot(
      ctx,
      matter.id,
    )) as Record<string, any>;
    assert.equal(
      incompleteSnapshot.positions.some(
        (item: Record<string, unknown>) => item.id === claim.id,
      ),
      false,
    );

    const app = express();
    app.use(express.json({ limit: "2mb" }));
    app.use("/aletheia", litigationRouter);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server?.once("listening", resolve));
    const address = server.address();
    assert(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const authorityPath = `/aletheia/matters/${matter.id}/litigation/legal-authorities`;
    const sourceText =
      "第五百零九条 当事人应当按照约定全面履行自己的义务。合同履行应当遵循诚信原则。";
    const authorityPayload = {
      authorityType: "statute",
      title: "中华人民共和国民法典",
      issuer: "全国人民代表大会",
      officialIdentifier: "中华人民共和国主席令第四十五号",
      versionLabel: "2021-01-01施行文本",
      sourceReference: "全国人大官网核验副本",
      content: sourceText,
      effectiveFrom: "2021-01-01",
      effectiveTo: null,
    };

    const invalidInterval = await request(baseUrl, authorityPath, {
      method: "POST",
      body: {
        ...authorityPayload,
        effectiveFrom: "2025-01-01",
        effectiveTo: "2024-01-01",
      },
    });
    assert.equal(invalidInterval.response.status, 400);

    const created = await request(baseUrl, authorityPath, {
      method: "POST",
      body: authorityPayload,
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.status, "draft");
    assert.match(created.body.content_sha256, /^[a-f0-9]{64}$/);
    const detailRead = await request(
      baseUrl,
      `${authorityPath}/${created.body.id}`,
    );
    assert.equal(detailRead.response.status, 200);
    assert.equal(detailRead.body.content, sourceText);
    assert.equal(detailRead.body.content_sha256, created.body.content_sha256);

    const linkPath = `/aletheia/matters/${matter.id}/litigation/position-authorities`;
    const validLink = {
      claimId: claim.id,
      authorityVersionId: created.body.id,
      applicabilityDate: "2026-09-01",
      provisionReference: "第五百零九条",
      exactQuote: "当事人应当按照约定全面履行自己的义务。",
      rationale:
        "This provision directly governs the pleaded performance duty.",
    };
    assert.equal(
      (
        await request(baseUrl, linkPath, {
          method: "POST",
          body: validLink,
        })
      ).response.status,
      400,
      "draft authority must not support a position",
    );

    const verifyPath = `${authorityPath}/${created.body.id}/verify`;
    assert.equal(
      (
        await request(baseUrl, verifyPath, {
          method: "POST",
          body: { comment: "short" },
        })
      ).response.status,
      400,
    );
    const verified = await request(baseUrl, verifyPath, {
      method: "POST",
      body: {
        comment:
          "Counsel compared the stored text, identifier and effective date with the official copy.",
      },
    });
    assert.equal(verified.response.status, 200);
    assert.equal(verified.body.status, "verified");

    const proposedClaim = (await repository.createLitigationClaim(ctx, matter.id, {
      kind: "defense",
      title: "A proposed position can receive authority before its decision.",
      legalBasis: "Civil Code contract performance rule",
      confidence: "medium",
      uncertainty: null,
      sourceRelation: "supports",
      source: {
        sourceChunkId: evidenceResults[0].chunk_id,
        quoteStart: evidenceResults[0].quote_start,
        quoteEnd: evidenceResults[0].quote_end,
      },
      createdBy: "human",
    })) as Record<string, any>;
    const proposedLink = await request(baseUrl, linkPath, {
      method: "POST",
      body: { ...validLink, claimId: proposedClaim.id },
    });
    assert.equal(proposedLink.response.status, 201);
    await repository.decideLitigationClaim(ctx, matter.id, proposedClaim.id, {
      decision: "rejected",
      comment: "Rejected after testing pre-decision authority preparation.",
    });

    const outsideEffectivePeriod = await request(baseUrl, linkPath, {
      method: "POST",
      body: { ...validLink, applicabilityDate: "2020-12-31" },
    });
    assert.equal(outsideEffectivePeriod.response.status, 400);
    assert.match(outsideEffectivePeriod.body.detail, /not effective/);

    const alteredQuote = await request(baseUrl, linkPath, {
      method: "POST",
      body: { ...validLink, exactQuote: "当事人可以不按照约定履行义务。" },
    });
    assert.equal(alteredQuote.response.status, 400);
    assert.match(
      alteredQuote.body.detail,
      /match the stored source text exactly/,
    );

    const linked = await request(baseUrl, linkPath, {
      method: "POST",
      body: validLink,
    });
    assert.equal(linked.response.status, 201);
    assert.equal(linked.body.status, "active");
    assert.match(linked.body.quote_sha256, /^[a-f0-9]{64}$/);
    const satisfiedWorkspace = (await repository.getLitigationWorkspace(
      ctx,
      matter.id,
    )) as Record<string, any>;
    assert.equal(
      satisfiedWorkspace.position_authority_statuses.find(
        (item: Record<string, unknown>) => item.claim_id === claim.id,
      ).status,
      "satisfied",
    );
    const detailAfterLink = (await repository.getMatterDetail(
      ctx,
      matter.id,
    )) as Record<string, any>;
    assert.ok(
      detailAfterLink.workProducts.find(
        (item: Record<string, unknown>) => item.id === incompleteArtifact.id,
      )?.stale_at,
      "linking authority must stale an artifact generated with an authority gap",
    );
    const authorityArtifact = (await repository.generateLitigationArtifact(
      ctx,
      matter.id,
      "claim_defense_matrix",
    )) as Record<string, any>;
    const authorityPosition = authorityArtifact.content.positions.find(
      (position: Record<string, unknown>) => position.id === claim.id,
    );
    assert.equal(authorityPosition.legalAuthorities.length, 1);
    assert.equal(
      authorityArtifact.content.sources.some(
        (source: Record<string, unknown>) =>
          source.id === `legal-authority:${linked.body.id}` &&
          source.kind === "verified_legal_authority",
      ),
      true,
      "verified legal authority must enter the hash-bound artifact source set",
    );
    const agentSnapshot = (await repository.prepareLitigationAgentSnapshot(
      ctx,
      matter.id,
    )) as Record<string, any>;
    assert.equal(
      agentSnapshot.sources.some(
        (source: Record<string, unknown>) =>
          source.id === `legal-authority:${linked.body.id}`,
      ),
      true,
      "verified legal authority must enter the cited-position Agent snapshot",
    );

    const overlappingDraft = await request(baseUrl, authorityPath, {
      method: "POST",
      body: {
        ...authorityPayload,
        versionLabel: "2026复核文本",
        effectiveFrom: "2026-01-01",
      },
    });
    assert.equal(overlappingDraft.response.status, 201);
    const overlappingVerifyPath = `${authorityPath}/${overlappingDraft.body.id}/verify`;
    const overlappingVerification = await request(
      baseUrl,
      overlappingVerifyPath,
      {
        method: "POST",
        body: {
          comment:
            "Counsel checked this proposed version before resolving the overlapping interval.",
        },
      },
    );
    assert.equal(overlappingVerification.response.status, 400);
    assert.match(
      overlappingVerification.body.detail,
      /overlaps another verified/,
    );

    const withdrawPath = `${linkPath}/${linked.body.id}/withdraw`;
    assert.equal(
      (
        await request(baseUrl, withdrawPath, {
          method: "POST",
          body: { comment: "short" },
        })
      ).response.status,
      400,
    );
    const withdrawn = await request(baseUrl, withdrawPath, {
      method: "POST",
      body: {
        comment:
          "Counsel withdrew this authority link before replacing the applicable version.",
      },
    });
    assert.equal(withdrawn.response.status, 200);
    assert.equal(withdrawn.body.status, "withdrawn");
    const withdrawnWorkspace = (await repository.getLitigationWorkspace(
      ctx,
      matter.id,
    )) as Record<string, any>;
    assert.equal(
      withdrawnWorkspace.position_authority_statuses.find(
        (item: Record<string, unknown>) => item.claim_id === claim.id,
      ).status,
      "missing",
    );
    const detailAfterWithdrawal = (await repository.getMatterDetail(
      ctx,
      matter.id,
    )) as Record<string, any>;
    assert.ok(
      detailAfterWithdrawal.workProducts.find(
        (item: Record<string, unknown>) => item.id === authorityArtifact.id,
      )?.stale_at,
      "withdrawing the last authority must stale the previously complete artifact",
    );
    const withdrawnArtifact = (await repository.generateLitigationArtifact(
      ctx,
      matter.id,
      "claim_defense_matrix",
    )) as Record<string, any>;
    assert.equal(
      withdrawnArtifact.validation_errors.some(
        (item: Record<string, unknown>) =>
          item.code === "verified_legal_authority_missing" &&
          item.claimId === claim.id,
      ),
      true,
    );
    assert.equal(
      (
        await request(baseUrl, withdrawPath, {
          method: "POST",
          body: {
            comment: "A withdrawn authority link must remain immutable.",
          },
        })
      ).response.status,
      404,
    );

    const retirePath = `${authorityPath}/${created.body.id}/retire`;
    assert.equal(
      (
        await request(baseUrl, retirePath, {
          method: "POST",
          body: { comment: "short" },
        })
      ).response.status,
      400,
    );
    const retired = await request(baseUrl, retirePath, {
      method: "POST",
      body: {
        comment:
          "Counsel retired this verified copy after adopting a replacement version.",
      },
    });
    assert.equal(retired.response.status, 200);
    assert.equal(retired.body.status, "retired");
    assert.equal(
      (
        await request(baseUrl, retirePath, {
          method: "POST",
          body: { comment: "A retired version must remain retired." },
        })
      ).response.status,
      404,
    );

    const replacementVerified = await request(baseUrl, overlappingVerifyPath, {
      method: "POST",
      body: {
        comment:
          "Counsel verified the replacement after retiring the overlapping prior copy.",
      },
    });
    assert.equal(replacementVerified.response.status, 200);
    assert.equal(replacementVerified.body.status, "verified");
    const replacementLink = await request(baseUrl, linkPath, {
      method: "POST",
      body: {
        ...validLink,
        authorityVersionId: overlappingDraft.body.id,
        rationale:
          "The replacement verified version now supports the confirmed position.",
      },
    });
    assert.equal(replacementLink.response.status, 201);
    const replacementRetired = await request(
      baseUrl,
      `${authorityPath}/${overlappingDraft.body.id}/retire`,
      {
        method: "POST",
        body: {
          comment:
            "The replacement source was withdrawn and must invalidate its active link.",
        },
      },
    );
    assert.equal(replacementRetired.response.status, 200);
    const invalidWorkspace = (await repository.getLitigationWorkspace(
      ctx,
      matter.id,
    )) as Record<string, any>;
    assert.equal(
      invalidWorkspace.position_authority_statuses.find(
        (item: Record<string, unknown>) => item.claim_id === claim.id,
      ).status,
      "invalid",
    );
    await assert.rejects(
      () => repository.prepareLitigationAgentSnapshot(ctx, matter.id),
      /Legal authority integrity or effective-date validation failed/,
    );

    const listed = await request(baseUrl, authorityPath);
    assert.equal(listed.response.status, 200);
    assert.equal(listed.body.versions.length, 2);
    assert.equal(listed.body.links.length, 3);
    assert.equal("content" in listed.body.versions[0], false);
    assert.equal(
      await repository.listLitigationLegalAuthorities(
        { userId: "different-user" },
        matter.id,
      ),
      null,
    );

    const detail = (await repository.getMatterDetail(ctx, matter.id)) as Record<
      string,
      any
    >;
    const actions = new Set(
      detail.auditEvents.map((event: Record<string, unknown>) => event.action),
    );
    assert(actions.has("litigation_legal_authority_version_created"));
    assert(actions.has("litigation_legal_authority_version_verified"));
    assert(actions.has("litigation_position_legal_authority_linked"));
    assert(actions.has("litigation_position_legal_authority_withdrawn"));
    assert(actions.has("litigation_legal_authority_version_retired"));

    console.log(
      JSON.stringify(
        {
          ok: true,
          suite: "vera-legal-authority-version-v1",
          checks: [
            "immutable source content hash",
            "owner-scoped full source detail",
            "effective date interval validation",
            "draft authority rejection",
            "mandatory counsel verification",
            "out-of-period version rejection",
            "exact quote enforcement",
            "confirmed position authority-missing readiness gate",
            "proposed position pre-decision authority linking",
            "withdrawal restores authority-missing artifact and Agent gate",
            "authority link and withdrawal stale prior artifacts",
            "artifact source and position projection",
            "cited-position Agent snapshot inclusion",
            "overlapping verified interval rejection",
            "immutable link withdrawal",
            "verified version retirement and replacement",
            "retired active authority produces invalid readiness and Agent fail-closed",
            "matter/user isolation",
            "matter audit chain events",
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
    rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
