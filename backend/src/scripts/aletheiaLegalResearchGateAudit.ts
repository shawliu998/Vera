import assert from "node:assert/strict";
import {
  evaluateLegalResearchGate,
  normalizeLegalResearchRequest,
  previewResearchQuery,
} from "../lib/aletheia/legalResearch";

async function main() {
  const request = normalizeLegalResearchRequest({
    title: "合同解除争议研究",
    facts: "甲公司主张乙公司迟延交货，拟研究解除权与损失赔偿。",
    jurisdiction: "中国大陆",
    asOfDate: "2026-07-12",
    question: "迟延交货是否满足解除合同条件？",
  });
  assert.equal(request.jurisdiction, "中国大陆");
  const preview = previewResearchQuery({
    query: "甲公司（2026）沪01民初123号联系人13800138000于2026年7月12日在杭州市签订金额1000万元的采购合同，迟延交货解除合同",
    protectedTerms: ["甲公司"],
    jurisdiction: request.jurisdiction,
    asOfDate: request.asOfDate,
  });
  assert.equal(preview.query.includes("甲公司"), false);
  assert.equal(preview.query.includes("13800138000"), false);
  assert.equal(preview.query.includes("民初123号"), false);
  assert.equal(preview.query.includes("2026年7月12日"), false);
  assert.equal(preview.query.includes("1000万元"), false);
  assert.equal(preview.query.includes("杭州市"), false);
  assert.match(preview.queryHash, /^sha256:[a-f0-9]{64}$/);

  const insufficient = evaluateLegalResearchGate({
    asOfDate: request.asOfDate,
    findings: [
      {
        conclusion: "可以解除合同。",
        citations: [],
        confidence: "high",
        uncertainty: null,
        position: "supporting",
      },
    ],
  });
  assert.equal(insufficient.status, "insufficient_basis");

  const inapplicable = evaluateLegalResearchGate({
    asOfDate: request.asOfDate,
    findings: [
      {
        conclusion: "可以解除合同。",
        citations: [
          {
            snapshotId: "snapshot-1",
            quote: "迟延履行致使不能实现合同目的的，当事人可以解除合同。",
            sourceType: "statute",
            effectiveFrom: "2027-01-01",
            effectiveTo: null,
          },
        ],
        confidence: "medium",
        uncertainty: "需要核对合同目的是否落空。",
        position: "supporting",
      },
    ],
  });
  assert.equal(inapplicable.status, "insufficient_basis");

  const unverifiedCase = evaluateLegalResearchGate({
    asOfDate: request.asOfDate,
    findings: [
      {
        conclusion: "某案支持解除合同。",
        citations: [
          {
            snapshotId: "snapshot-case-1",
            quote: "迟延履行已经致使合同目的不能实现。",
            sourceType: "case",
            effectiveFrom: null,
            effectiveTo: null,
            caseVerificationStatus: "unverified",
          },
        ],
        confidence: "low",
        uncertainty: "案号尚未由授权来源核验。",
        position: "supporting",
      },
    ],
  });
  assert.equal(unverifiedCase.status, "insufficient_basis");

  const ready = evaluateLegalResearchGate({
    asOfDate: request.asOfDate,
    findings: [
      {
        conclusion: "迟延履行是否构成解除事由取决于合同目的是否不能实现。",
        citations: [
          {
            snapshotId: "snapshot-2",
            quote: "当事人一方迟延履行债务或者有其他违约行为致使不能实现合同目的的，当事人可以解除合同。",
            sourceType: "statute",
            effectiveFrom: "2021-01-01",
            effectiveTo: null,
          },
        ],
        confidence: "medium",
        uncertainty: "仍需结合交货期限、替代履行可能性与合同目的审查。",
        position: "neutral",
      },
    ],
  });
  assert.deepEqual(ready, { status: "ready_for_review", reasons: [] });

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      suite: "vera-legal-research-gate-v1",
      checks: [
        "local research request normalization",
        "actual outbound query redaction preview",
        "automatic amount date and location redaction",
        "query hash binding",
        "insufficient-basis gate",
        "legal source effective-date gate",
        "unverified case-number gate",
        "exact local snapshot citation gate",
      ],
    })}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
