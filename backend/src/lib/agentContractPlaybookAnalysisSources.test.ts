import assert from "node:assert/strict";
import test from "node:test";

import type { ContractPlaybookContextV1 } from "./agent-packs/contract/contractPlaybookContext";
import { ContractPlaybookStructuredOutputError } from "./agent-packs/contract/contractPlaybookPack";
import { bindContractPlaybookAnalysisToFixedSources } from "./agentContractPlaybookAnalysisSources";

const context: ContractPlaybookContextV1 = {
  kind: "contract_playbook_context_v1",
  context_version: "1.0.0",
  workflow_id: "builtin-contract-playbook-review",
  contract: {
    document_id: "11111111-1111-4111-8111-111111111111",
    version_id: "22222222-2222-4222-8222-222222222222",
    filename: "contract.docx",
    file_type: "docx",
  },
  reference: {
    role: "playbook",
    document_id: "33333333-3333-4333-8333-333333333333",
    version_id: "44444444-4444-4444-8444-444444444444",
    filename: "playbook.docx",
    file_type: "docx",
    rule_set_digest: `sha256:${"a".repeat(64)}`,
    expected_rule_count: 1,
    expected_rules: [{ rule_id: "PRC-NDA-001", rule_version: "1.0.0" }],
  },
  review: {
    mode: "checklist",
    contract_type: "nda",
    represented_side: "recipient",
    negotiation_posture: "balanced",
    jurisdiction: "China (PRC)",
    language: "zh",
    background_facts: "No additional facts supplied.",
  },
};

const finding = {
  material: true,
  rule_id: "PRC-NDA-001",
  rule_version: "1.0.0",
  rule_outcome: "deviation",
  issue_type: "definition_scope",
  risk_level: "high",
  priority: "must",
  confidence: 0.92,
  target_position: "Reasonably identifiable confidential information.",
  fallback_position: null,
  walk_away_position: null,
  contract_anchor: "Clause 1",
  contract_quote: "all information disclosed at any time",
  contract_citation_refs: [],
  playbook_citation_refs: [],
  recommendation: "Add a reasonable-identification boundary.",
  proposed_text: "information reasonably identified as confidential",
};

test("server binds provider analysis to exact fixed source quotes and rule blocks", () => {
  const result = bindContractPlaybookAnalysisToFixedSources({
    rawOutput: JSON.stringify({
      kind: "contract_playbook_analysis_v1",
      findings: [finding],
    }),
    context,
    sources: {
      contractText:
        "Clause 1: all information disclosed at any time is confidential.",
      referenceText:
        "规则包 ID\nprc-confidentiality\nPRC-NDA-001@1.0.0  ·  定义\n审查要求：信息应可合理识别。\n签署前人工确认",
    },
  });
  const parsed = JSON.parse(result.rawOutput);
  assert.deepEqual(parsed.findings[0].contract_citation_refs, [1]);
  assert.deepEqual(parsed.findings[0].playbook_citation_refs, [2]);
  assert.deepEqual(
    result.citations.map((citation) => ({
      ref: citation.ref,
      document_id: citation.document_id,
      version_id: citation.version_id,
    })),
    [
      {
        ref: 1,
        document_id: context.contract.document_id,
        version_id: context.contract.version_id,
      },
      {
        ref: 2,
        document_id: context.reference.document_id,
        version_id: context.reference.version_id,
      },
    ],
  );
});

test("server extracts one mechanically unambiguous JSON object from provider prose", () => {
  const result = bindContractPlaybookAnalysisToFixedSources({
    rawOutput: `Here is the bounded result:\n${JSON.stringify({
      kind: "contract_playbook_analysis_v1",
      findings: [finding],
    })}\nEnd of result.`,
    context,
    sources: {
      contractText:
        "Clause 1: all information disclosed at any time is confidential.",
      referenceText:
        "PRC-NDA-001@1.0.0  ·  定义\n审查要求：信息应可合理识别。",
    },
  });
  assert.equal(JSON.parse(result.rawOutput).findings.length, 1);
});

test("server ignores unrelated JSON prose and selects the unique typed analysis", () => {
  const result = bindContractPlaybookAnalysisToFixedSources({
    rawOutput: `${JSON.stringify({
        kind: "contract_playbook_analysis_v1",
        findings: [finding],
      })}\n${JSON.stringify({ note: "second object" })}`,
    context,
    sources: {
      contractText: "all information disclosed at any time",
      referenceText:
        "PRC-NDA-001@1.0.0  ·  定义\n审查要求：信息应可合理识别。",
    },
  });
  assert.equal(JSON.parse(result.rawOutput).findings.length, 1);
});

test("server rejects two typed analysis objects as ambiguous", () => {
  const typed = JSON.stringify({
    kind: "contract_playbook_analysis_v1",
    findings: [finding],
  });
  assert.throws(() =>
    bindContractPlaybookAnalysisToFixedSources({
      rawOutput: `${typed}\n${typed}`,
      context,
      sources: {
        contractText: "all information disclosed at any time",
        referenceText:
          "PRC-NDA-001@1.0.0  ·  定义\n审查要求：信息应可合理识别。",
      },
    }),
  );
});

test("server mechanically normalizes a bounded decimal confidence string", () => {
  const result = bindContractPlaybookAnalysisToFixedSources({
    rawOutput: JSON.stringify({
      kind: "contract_playbook_analysis_v1",
      findings: [{ ...finding, confidence: "0.92" }],
    }),
    context,
    sources: {
      contractText:
        "Clause 1: all information disclosed at any time is confidential.",
      referenceText:
        "PRC-NDA-001@1.0.0  ·  定义\n审查要求：信息应可合理识别。",
    },
  });
  assert.equal(JSON.parse(result.rawOutput).findings[0].confidence, 0.92);
});

test("server nulls an uncalibrated confidence without gating the finding", () => {
  const result = bindContractPlaybookAnalysisToFixedSources({
    rawOutput: JSON.stringify({
      kind: "contract_playbook_analysis_v1",
      findings: [{ ...finding, confidence: "92%" }],
    }),
    context,
    sources: {
      contractText: "all information disclosed at any time",
      referenceText:
        "PRC-NDA-001@1.0.0  ·  定义\n审查要求：信息应可合理识别。",
    },
  });
  assert.equal(JSON.parse(result.rawOutput).findings[0].confidence, null);
});

test("server normalizes only an exact JSON boolean string and accepts a localized issue label", () => {
  const result = bindContractPlaybookAnalysisToFixedSources({
    rawOutput: JSON.stringify({
      kind: "contract_playbook_analysis_v1",
      findings: [
        {
          ...finding,
          material: "true",
          issue_type: "保密信息定义范围",
        },
      ],
    }),
    context,
    sources: {
      contractText: "all information disclosed at any time",
      referenceText:
        "PRC-NDA-001@1.0.0  ·  定义\n审查要求：信息应可合理识别。",
    },
  });
  const normalized = JSON.parse(result.rawOutput).findings[0];
  assert.equal(normalized.material, true);
  assert.equal(normalized.issue_type, "prc_nda_001");
});

test("server rejects an ambiguous material value", () => {
  assert.throws(() =>
    bindContractPlaybookAnalysisToFixedSources({
      rawOutput: JSON.stringify({
        kind: "contract_playbook_analysis_v1",
        findings: [{ ...finding, material: "yes" }],
      }),
      context,
      sources: {
        contractText: "all information disclosed at any time",
        referenceText:
          "PRC-NDA-001@1.0.0  ·  定义\n审查要求：信息应可合理识别。",
      },
    }),
  );
});

test("server rejects a provider quote that is not an exact fixed substring", () => {
  assert.throws(
    () =>
      bindContractPlaybookAnalysisToFixedSources({
        rawOutput: JSON.stringify({
          kind: "contract_playbook_analysis_v1",
          findings: [{ ...finding, contract_quote: "paraphrased information" }],
        }),
        context,
        sources: {
          contractText: "all information disclosed at any time",
          referenceText:
            "PRC-NDA-001@1.0.0  ·  定义\n审查要求：信息应可合理识别。",
        },
      }),
    ContractPlaybookStructuredOutputError,
  );
});

test("server rejects a provider rule identity absent from the fixed Playbook", () => {
  assert.throws(
    () =>
      bindContractPlaybookAnalysisToFixedSources({
        rawOutput: JSON.stringify({
          kind: "contract_playbook_analysis_v1",
          findings: [{ ...finding, rule_id: "PRC-NDA-999" }],
        }),
        context,
        sources: {
          contractText: "all information disclosed at any time",
          referenceText:
            "PRC-NDA-001@1.0.0  ·  定义\n审查要求：信息应可合理识别。",
        },
      }),
    ContractPlaybookStructuredOutputError,
  );
});
