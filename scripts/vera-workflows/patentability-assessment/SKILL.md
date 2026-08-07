---
name: "patentability-assessment"
description: "Assess a draft patent claim against pinned prior-art documents and prepare a source-linked feature chart and Word memorandum."
license: "AGPL-3.0-only"
metadata:
  version: "1.0.0"
  author: "Vera"
  language: "English"
  vera-display-name: "Patentability Assessment"
  vera-type: "assistant"
  vera-availability: "system"
  practice: "Patents"
  jurisdictions: "Matter-specified"
---
# Patentability Assessment

Work only within the current Matter and its pinned DocumentVersions. The required source set is: a draft claim or invention disclosure that identifies the claim to assess, plus at least one pinned prior-art publication. A publication obtained through Vera's approved prior-art acquisition flow is in scope only after the lawyer selects it, it is imported as an ordinary Matter DocumentVersion, and that exact version is selected for this Task. This Workflow does not send a search query, silently import a result, expand the selected source set, imply that the selected references are exhaustive, or treat the generated work product as a legal opinion.

Keep three semantic axes separate throughout the work:

1. **Claim-feature disclosure:** `Disclosed`, `Partial`, or `Not shown` for the selected reference and locator.
2. **Source verification:** whether the cited passage and locator have been checked against the current pinned DocumentVersion.
3. **Lawyer review:** whether counsel has accepted, revised, or left unresolved the provisional assessment.

Read all pinned sources before analysis. Identify the exact target claim and split it into reviewable features without changing claim language. Treat each prior-art DocumentVersion as one row in the existing Tabular Review and each claim feature as a column. Every responsive cell must state the disclosure assessment, a concise explanation, and a relocatable source citation. For PDF sources, include the page or printed paragraph locator and a continuous supporting quote. For DOCX sources, include the pinned version and a continuous quote without inventing a page number. Use `Not shown` only after reviewing the relevant pinned source; use `Unverified` when the locator or passage has not been checked.

Create exactly two Matter-owned work products:

- **Patentability feature chart:** an existing Tabular Review whose rows are the pinned prior-art documents and whose columns are the target claim features.
- **Patentability memorandum:** an editable Word document containing `Scope and Sources`, `Executive Conclusion`, `Feature Analysis`, and `Gaps and Next Actions`.

The memorandum must identify the target claim, reviewed references, jurisdiction and priority cutoff when provided, incomplete search coverage, unresolved claim-construction questions, and every material source-verification gap. When a source is an imported provider text snapshot rather than an official publication PDF, repeat its source notice and require verification against the linked patent publication for every material passage. Its material factual and patent-disclosure propositions must link back to the pinned source versions. Do not state that a claim is patentable, valid, infringed, or clear to operate as a final conclusion; describe only the bounded assessment supported by the selected references.

Pause for Required Input instead of guessing when the target claim is missing or ambiguous, no prior-art source is pinned, the jurisdiction or priority cutoff is material but unclear, claim construction changes the result, a cited source version changes, references conflict, or a requested action would expand beyond the pinned Matter scope. Completion requires both current work products, relocatable citations for material propositions, explicit unresolved gaps, completed steps, and final Kernel verification. External filing, client delivery, and reliance remain lawyer-controlled actions.
