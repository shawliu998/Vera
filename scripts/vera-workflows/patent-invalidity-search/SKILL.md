---
name: "patent-invalidity-search"
description: "Screen selected challenged claims against pinned prior-art references and prepare a source-linked claim-element chart and editable Word screening memorandum."
license: "AGPL-3.0-only"
metadata:
  version: "1.0.0"
  author: "Vera"
  language: "English"
  vera-display-name: "Patent Invalidity Search"
  vera-type: "assistant"
  vera-availability: "system"
  practice: "Patents"
  jurisdictions: "Matter-specified"
---
# Patent Invalidity Search

Work only within the current Matter and its pinned DocumentVersions. The required source set is: the exact challenged or asserted claim numbers and claim text, plus at least one pinned prior-art publication or record. A patent record obtained through an approved provider is in scope only after the lawyer selects it, imports it as an ordinary Matter DocumentVersion, and selects that exact version for this Task. This Workflow does not run a live patent-source search, silently import a result, expand the selected source set, imply that the selected references are exhaustive, or treat the generated work product as a final invalidity opinion.

Before analysis, confirm or request:

- Challenged / asserted claim numbers and exact claim text.
- Jurisdiction and applicable claim-construction framework.
- Priority or critical date.
- Search scope (publication types, date ranges, jurisdictions, non-patent literature if any).
- Known references already pinned, if any.

Read every pinned source before analysis. Preserve the exact claim language when quoting or splitting claims into elements. Keep four semantic axes separate throughout the work:

1. **Source disclosure:** what the pinned reference actually discloses, with a relocatable locator and continuous quote.
2. **Anticipation analysis:** whether a single reference discloses every claim element, arranged by element.
3. **Combination / obviousness analysis:** whether a claimed combination is shown or suggested by the pinned references, with any explicit motivation or teaching away.
4. **Lawyer judgment:** the provisional assessment, remaining gaps, and the next lawyer action.

Create exactly two Matter-owned work products:

- **Invalidity claim-element chart:** an existing Tabular Review whose rows are the pinned prior-art references and whose columns are the challenged claim elements. Each responsive cell must state the disclosure assessment, a concise explanation, and a relocatable citation. Use `Disclosed`, `Partial`, `Not shown`, or `Unverified` as the assessment label; put explanation and qualification in the cell note, not the label. For PDF sources, include the page or printed paragraph locator and a continuous supporting quote. For DOCX sources, include the pinned version and a continuous quote without inventing a page number.
- **Invalidity screening memorandum:** an editable Word document containing these standalone sections: `Scope and Limitations`, `Challenged Claims Reviewed`, `Prior Art Sources`, `Anticipation Analysis`, `Obviousness / Combination Analysis`, `Source Verification Notes`, and `Open Questions and Next Actions`.

The memorandum must identify the challenged claims, reviewed references, jurisdiction and priority cutoff, search-scope limitations, every missing non-patent-literature source, every unverified legal-status or translation item, unresolved claim-construction questions, and each material source-verification gap. When a source is an imported provider text snapshot rather than an official publication PDF, repeat its source notice and require verification against the linked patent publication for every material passage. Do not state that a claim is invalid, valid, infringed, or patentable as a final conclusion; describe only the bounded invalidity screening supported by the selected references.

Pause for Required Input instead of guessing when the challenged claims or exact claim text are missing or ambiguous, no prior-art source is pinned, the jurisdiction or priority/critical date is material but unclear, claim construction changes the result, a cited source version changes, references conflict, a requested action would expand beyond the pinned Matter scope, or a missing non-patent-literature, legal-status, translation, or claim-construction input would affect the analysis. Completion requires both current work products, relocatable citations for material propositions, explicit unresolved gaps, completed steps, and final Kernel verification. External filing, client delivery, and reliance remain lawyer-controlled actions.
