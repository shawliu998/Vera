---
name: "contract-playbook-review"
description: "Review a pinned contract against a fixed Matter Playbook, including Vera's evaluation-stage PRC commercial packs, and produce a cited revision, clean contract, and review opinion."
license: "AGPL-3.0-only"
metadata:
  version: "1.3.1"
  author: "Vera"
  language: "English"
  vera-display-name: "Contract Playbook Review"
  vera-type: "assistant"
  vera-availability: "system"
  practice: "Contract Review"
  jurisdictions: "Matter-specified, China (PRC pilot)"
---

# Contract Playbook Review

## Assignment boundary

Work only from the current Matter's pinned contract and Playbook/source versions. The original contract remains a source; do not replace, modify, or treat it as an output. This Skill specifies review requirements only. The Kernel remains responsible for Matter scope, Task and Step execution, citations, Required Input, recovery, review, verification, and export control.

Use the fixed Playbook as the complete review standard for this Task. Do not silently add legal rules or negotiating positions that are absent from that source. A Vera PRC commercial pilot Playbook is an evaluation-stage product position, not legal authority; keep its `lawyer_validation_required` boundary intact and require separate authority before stating a specific legal-effect, mandatory-rule, limitation, or enforceability conclusion.

## Review inputs and outcomes

- Fix the contract type, represented side, review mode, negotiation posture, jurisdiction, review language, and material background facts before analysis.
- Use one review workflow for every contract. Contract type selects only the fixed Playbook overlay; it must not create a separate page, Task type, output contract, or review engine.
- For release acceptance, prioritize the ordinary commercial families already supplied by Vera: sale/procurement, services/commission, confidentiality/NDA, and employment/consulting. Treat commercial lease and loan/guarantee as extended coverage. Treat bilingual text, existing redlines, long documents, complex tables, scans, and multi-file packages as document conditions rather than additional contract families.
- A software, SaaS, licence, or DPA review may use the services overlay plus the Matter's fixed specialist Playbook. Do not imply that a generic commercial overlay supplies privacy, cybersecurity, cross-border-transfer, sector, or mandatory-law authority.
- In `checklist` mode, return exactly one outcome for every fixed Playbook rule. In `deep` mode, include supported material and non-material outcomes. In `quick` mode, include only material findings requiring lawyer attention.
- In `compare` mode, treat the second pinned DOCX only as the earlier or comparison baseline. Report source-supported clause additions, deletions, and changes; do not treat the baseline as a Playbook, legal authority, market standard, or negotiating position. Encode the baseline clause identifier as an ASCII machine token such as `baseline_clause_7_2` for `rule_id`; it must match `^[A-Za-z0-9][A-Za-z0-9._:-]*$`, contain no spaces or Chinese characters, and be at most 120 characters. Use the exact pinned baseline version as `rule_version`. Keep target, fallback, and walk-away positions null. A proposed replacement may reproduce exact baseline wording only when the lawyer is being asked whether to restore that wording; otherwise use a comment or no document change.
- Use only `compliant`, `deviation`, `missing`, `uncertain`, or `not_applicable`. Treat a missing fact or unresolved legal judgment as `uncertain`, never as `compliant`.
- Outside `compare` mode, preserve each fixed `rule_id` and `rule_version`. Apply its target, fallback, and walk-away positions from the represented side and negotiation posture; do not invent a stronger position.
- Outside `compare` mode, cite the exact Playbook rule for every finding. In `compare` mode, cite the exact baseline clause instead. Cite the exact contract text for every outcome other than `missing`, and for `not_applicable` whenever contract text is used to support that outcome.

## Required outputs

Create exactly these editable Word outputs for the same Task:

1. `contract-revision`: a revision containing only native tracked changes and anchored comments for findings with an exact contract anchor. A missing clause has no fabricated document markup; retain it as a document-level unresolved item in `review-opinion`. Never accept changes automatically.
2. `contract-clean`: the clean contract obtained by accepting the revision's tracked changes. It must contain no tracked changes or comments.
3. `review-opinion`: a clean review opinion summarising findings, the lawyer's decisions, unresolved items, and the source-backed rationale. It must contain no tracked changes or comments.

Every material finding, proposed change, and conclusion must preserve a relocatable citation to the pinned Matter source. A finding that needs a lawyer decision must remain unresolved until that decision is supplied through the existing Required Input flow; do not infer a negotiating position, legal conclusion, or missing fact.

## Process

1. Read the pinned contract, the complete fixed Playbook, and any identified precedent or source material.
2. Evaluate the contract once against each applicable Playbook rule and preserve its fixed identity, outcome, risk, source location, recommendation, proposed text, and whether a lawyer decision is required. Ask through the existing Required Input mechanism when a decision is missing.
3. Produce the revision with native pending tracked changes or comments for exact, non-conflicting anchors. A missing clause remains a document-level unresolved item in the review opinion; do not force a manual anchor. Use the constrained browser review surface by default; use Word for complex formatting or optional advanced refinement.
4. Produce the matching clean contract from that revision.
5. Produce the clean review opinion using the resolved decisions and identify every remaining open issue.
6. Verify that all three outputs are current, cited, and internally consistent. The revision's accepted view must reproduce the clean contract, while the original contract remains unchanged.

## Mandatory pause conditions

Pause for missing source material, an ambiguous or conflicting Playbook position, a missing material fact, a required lawyer decision, source-version drift, material scope expansion, or a citation that cannot be relocated. Do not create an output outside the three declared deliverables and do not imply final legal approval or external delivery.

## Release acceptance boundary

A release claim for the contract-review Skill requires a fresh ordinary-user Task, started through the product UI, to complete the pinned-source review, lawyer decisions, browser review and optional Word handoff, revision, clean contract, review opinion, verification, approval, and download without database edits, hard-coded Task or user identifiers, direct storage repair, or manual OOXML repair.

The core release gate is the high-frequency family set above plus the software/DPA composite fixture. Extended-family and document-condition fixtures remain regression coverage, but a provider outage or an unsupported scanned-file edit must fail closed and must not be reported as a missing high-frequency contract capability.
