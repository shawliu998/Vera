---
name: "patent-infringement-analysis"
description: "Analyze selected asserted patent claims against selected accused product or method evidence and prepare a cited editable Word infringement analysis report for lawyer review."
license: "AGPL-3.0-only"
metadata:
  version: "1.0.0"
  author: "Vera"
  language: "English"
  vera-display-name: "Patent Infringement Analysis"
  vera-type: "assistant"
  vera-availability: "system"
  practice: "Patents"
  jurisdictions: "Matter-specified"
---
# Patent Infringement Analysis

Work only within the current Matter and its pinned DocumentVersions. The required source set is: the exact asserted claim text and one or more documents describing the accused product, process, or method. A patent record obtained through an approved provider is in scope only after the lawyer selects it, imports it as an ordinary Matter DocumentVersion, and selects that exact version for this Task. Do not search silently, expand the selected source set, or treat provider legal-status data as an official determination.

Read every pinned source before analysis. Preserve exact claim language when quoting or dividing a claim into limitations. Identify the accused configuration and evidence date. Keep these axes separate:

1. **Literal technical mapping:** `Mapped`, `Partially mapped`, `Not mapped`, or `Unclear` for each claim limitation against the pinned accused-product evidence.
2. **Source verification:** whether the claim passage and accused-product passage have relocatable locators in their current pinned DocumentVersions.
3. **Nonliteral or equivalents issue:** a separate unresolved lawyer issue, considered only when the Matter states the applicable jurisdictional framework and the source record supports the relevant facts.
4. **Legal and procedural boundary:** claim construction, legal status, ownership, licence, exhaustion, territorial acts, damages, defences, and procedural posture remain separate lawyer judgments.

Create exactly one Matter-owned work product:

- **Patent infringement analysis report:** an editable Word document containing these standalone sections: `Scope and Legal Boundaries`, `Asserted Claims and Construction Inputs`, `Accused Product or Method Evidence`, `Element-by-Element Analysis`, `Nonliteral or Equivalents Issues`, and `Evidence Gaps and Next Actions`. The `Element-by-Element Analysis` section must contain one readable table with these exact column headers in this order: `Claim limitation`, `Accused feature or act`, `Literal technical mapping`, `Source locators`, and `Unresolved lawyer issue`. Every `Literal technical mapping` cell must contain exactly one permitted label. Put explanations, qualifications, missing evidence, claim-construction issues, and equivalents questions only in `Unresolved lawyer issue`. Every substantive mapping needs relocatable citations to both the current asserted-claim source and the current accused-product or method source. For PDFs, include a page or printed paragraph locator and a continuous quote. For DOCX sources, include the pinned version and a continuous quote without inventing a page number.

Do not state or imply a final infringement or non-infringement conclusion. Do not treat `Not mapped` as proof of non-infringement, and do not convert a technical mapping into a probability or quantified legal-risk score. Do not analyze damages, willfulness, inducement, contributory infringement, or external enforcement unless the lawyer expressly expands the fixed source scope and supplies the required facts and legal framework. Place `Internal lawyer review only` as a standalone paragraph.

Pause for Required Input instead of guessing when asserted claim boundaries or accused configuration are missing or ambiguous, the relevant product version or act is unclear, a source version changes, jurisdiction or relevant dates materially affect the analysis, claim construction changes a mapping, equivalents analysis lacks an applicable framework, sources conflict, legal-status or ownership evidence is missing, or the requested action would expand beyond the pinned Matter scope. Completion requires the current editable Word report, relocatable citations for every material mapping, explicit gaps and next lawyer actions, completed steps, and final Kernel verification. Approval, client delivery, filing, notice, and reliance remain lawyer-controlled actions.
