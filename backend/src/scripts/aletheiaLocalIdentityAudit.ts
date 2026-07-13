import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalDatabase } from "../lib/aletheia/localDatabase";
import type { NextFunction, Request, Response } from "express";
import { LocalGovernanceService } from "../lib/aletheia/localGovernance";
import { LocalIdentityRepository } from "../lib/aletheia/localIdentity";
import { LocalAletheiaRepository } from "../lib/aletheia/localRepository";
import { requireAuth } from "../middleware/auth";

function middlewareAuth(token: string) {
  let statusCode = 200;
  let responseBody: unknown;
  let nextCalled = false;
  const req = {
    originalUrl: "/aletheia/governance/approval-requests/test/votes",
    headers: { authorization: `Bearer ${token}` },
  } as Request;
  const res = {
    locals: {},
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(body: unknown) {
      responseBody = body;
      return this;
    },
  } as unknown as Response;
  requireAuth(req, res, (() => {
    nextCalled = true;
  }) as NextFunction);
  return { statusCode, responseBody, nextCalled, locals: res.locals };
}

async function main() {
  const root = mkdtempSync(path.join(os.tmpdir(), "aletheia-identity-"));
  const databasePath = path.join(root, "aletheia.db");
  const bootstrapToken = randomBytes(32).toString("hex");
  process.env.ALETHEIA_DATA_DIR = root;
  process.env.ALETHEIA_AUTH_MODE = "private_token";
  process.env.ALETHEIA_PRIVATE_AUTH_TOKEN = bootstrapToken;
  process.env.ALETHEIA_LOCAL_USER_ID = "identity-admin";
  process.env.ALETHEIA_LOCAL_USER_EMAIL = "admin@local.invalid";
  process.env.ALETHEIA_MULTI_PRINCIPAL_ENABLED = "true";

  const repository = new LocalAletheiaRepository();
  const admin = { userId: "identity-admin", userEmail: "admin@local.invalid" };
  const matter = (await repository.createMatter(admin, {
    title: "Distinct local identity approval",
    objective: "Prove two authenticated local principals are distinct",
    template: "legal_matter_review",
    status: "in_progress",
    riskLevel: "high",
    clientOrProject: null,
    sourceProjectId: null,
    sharedWith: [],
    metadata: { identityTest: true },
  })) as { id: string };
  const governance = new LocalGovernanceService({ databasePath });
  assert.equal(governance.multiPrincipalEnabled, true);
  governance.governance(admin.userId, matter.id);
  governance.createPrincipal(admin.userId, {
    id: "identity-reviewer",
    displayName: "Identity Reviewer",
    roles: ["reviewer"],
  });
  governance.createPrincipal(admin.userId, {
    id: "identity-auditor",
    displayName: "Identity Auditor",
    roles: ["auditor"],
  });
  governance.setMatterAcl(
    admin.userId,
    matter.id,
    "identity-reviewer",
    "reviewer",
  );
  governance.setMatterAcl(
    admin.userId,
    matter.id,
    "identity-auditor",
    "auditor",
  );
  governance.setApprovalPolicy(admin.userId, matter.id, {
    action: "restricted_export",
    requiredApprovals: 2,
    eligibleRoles: ["reviewer", "auditor"],
    requireDistinctRoles: true,
  });

  const identities = new LocalIdentityRepository({ databasePath });
  const reviewer = identities.issueToken({
    principalId: "identity-reviewer",
    createdBy: admin.userId,
    label: "Reviewer workstation",
    email: "reviewer@local.invalid",
    expiresInSeconds: 3_600,
  });
  const auditor = identities.issueToken({
    principalId: "identity-auditor",
    createdBy: admin.userId,
    label: "Auditor workstation",
    email: "auditor@local.invalid",
    expiresInSeconds: 3_600,
  });
  const adminIssued = identities.issueToken({
    principalId: admin.userId,
    createdBy: admin.userId,
    label: "Admin secondary token",
    expiresInSeconds: 3_600,
  });
  assert.match(reviewer.token, /^alp_[A-Za-z0-9_-]{43}$/);
  assert.equal(reviewer.token.length >= 40, true);
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      identities.listTokens("identity-reviewer")[0],
      "token",
    ),
    false,
  );

  const bootstrap = middlewareAuth(bootstrapToken);
  assert.equal(bootstrap.nextCalled, true);
  assert.equal(bootstrap.locals.userId, admin.userId);
  assert.equal(bootstrap.locals.authKind, "bootstrap");

  const reviewerAuth = middlewareAuth(reviewer.token);
  const auditorAuth = middlewareAuth(auditor.token);
  const adminAuth = middlewareAuth(adminIssued.token);
  assert.equal(reviewerAuth.nextCalled, true);
  assert.equal(reviewerAuth.locals.userId, "identity-reviewer");
  assert.equal(reviewerAuth.locals.authKind, "principal_token");
  assert.equal(auditorAuth.locals.userId, "identity-auditor");
  assert.equal(adminAuth.locals.userId, admin.userId);
  assert.notEqual(reviewerAuth.locals.userId, auditorAuth.locals.userId);

  const request = governance.requestApproval(
    admin.userId,
    matter.id,
    "restricted_export",
    { exportType: "audit_pack" },
  ) as { id: string };
  assert.throws(
    () =>
      governance.voteApproval(
        String(adminAuth.locals.userId),
        request.id,
        "approved",
      ),
    /requester cannot approve/i,
  );
  const firstVote = governance.voteApproval(
    String(reviewerAuth.locals.userId),
    request.id,
    "approved",
  ) as { status: string };
  assert.equal(firstVote.status, "pending");
  const secondVote = governance.voteApproval(
    String(auditorAuth.locals.userId),
    request.id,
    "approved",
  ) as { status: string; votes: Array<{ principal_id: string }> };
  assert.equal(secondVote.status, "approved");
  assert.deepEqual(
    new Set(secondVote.votes.map((vote) => vote.principal_id)),
    new Set(["identity-reviewer", "identity-auditor"]),
  );

  const rows = new LocalDatabase(databasePath);
  const tokenRow = rows
    .prepare(
      "select token_hash, last_used_at from aletheia_principal_tokens where id = ?",
    )
    .get(reviewer.id) as { token_hash: string; last_used_at: string | null };
  assert.match(tokenRow.token_hash, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(tokenRow.token_hash, reviewer.token);
  assert.ok(tokenRow.last_used_at);
  const columns = rows
    .prepare("pragma table_info(aletheia_principal_tokens)")
    .all() as Array<{
    name: string;
  }>;
  assert.equal(
    columns.some((column) => column.name === "token"),
    false,
  );
  rows.close();

  identities.close();
  const restarted = new LocalIdentityRepository({ databasePath });
  assert.equal(
    restarted.authenticate(auditor.token)?.principalId,
    "identity-auditor",
  );
  assert.equal(
    restarted.revokeToken({
      tokenId: auditor.id,
      principalId: "identity-reviewer",
      revokedBy: admin.userId,
    }),
    null,
  );
  assert.equal(
    restarted.authenticate(auditor.token)?.principalId,
    "identity-auditor",
  );
  assert.ok(
    restarted.revokeToken({
      tokenId: reviewer.id,
      principalId: "identity-reviewer",
      revokedBy: admin.userId,
    }),
  );
  assert.equal(restarted.authenticate(reviewer.token), null);
  const revokedAuth = middlewareAuth(reviewer.token);
  assert.equal(revokedAuth.nextCalled, false);
  assert.equal(revokedAuth.statusCode, 401);
  restarted.close();

  let fakeNow = new Date();
  const expiringIdentities = new LocalIdentityRepository({
    databasePath,
    now: () => new Date(fakeNow),
  });
  const expiring = expiringIdentities.issueToken({
    principalId: "identity-auditor",
    createdBy: admin.userId,
    expiresInSeconds: 60,
  });
  assert.equal(
    expiringIdentities.authenticate(expiring.token)?.principalId,
    "identity-auditor",
  );
  fakeNow = new Date(fakeNow.getTime() + 61_000);
  assert.equal(expiringIdentities.authenticate(expiring.token), null);
  expiringIdentities.close();

  process.env.ALETHEIA_AUTH_MODE = "single_user";
  const singleUser = middlewareAuth(auditor.token);
  assert.equal(singleUser.nextCalled, true);
  assert.equal(singleUser.locals.userId, admin.userId);
  assert.notEqual(singleUser.locals.userId, "identity-auditor");
  const singleUserGovernance = new LocalGovernanceService({ databasePath });
  assert.equal(singleUserGovernance.multiPrincipalEnabled, false);
  singleUserGovernance.close();
  governance.close();

  console.log(
    JSON.stringify(
      {
        ok: true,
        assertions: {
          randomTokenReturnedOnce: true,
          hashOnlyPersistence: true,
          bootstrapDesktopTokenPreserved: true,
          distinctMiddlewarePrincipals: true,
          requesterSelfApprovalBlocked: true,
          distinctTokenApprovalCompleted: true,
          restartPersistence: true,
          expiryEnforced: true,
          revocationEnforced: true,
          crossPrincipalBindingEnforced: true,
          lastUsedPersisted: true,
          singleUserDoesNotBecomeDualControl: true,
        },
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
