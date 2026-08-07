---
name: "patent-fto-screening"
description: "Screen selected product features against selected patent claims and prepare a cited editable Word FTO screening report."
license: "AGPL-3.0-only"
metadata:
  version: "1.0.0"
  author: "Vera"
  language: "English"
  vera-display-name: "Patent FTO Screening"
  vera-type: "assistant"
  vera-availability: "system"
  practice: "Patents"
  jurisdictions: "Matter-specified"
---
# Patent FTO Screening

Work only within the current Matter and its pinned DocumentVersions. The required source set is: one product, process, or technical-feature description and at least one selected patent claim document. A patent record obtained through an approved provider is in scope only after the lawyer selects it, imports it as an ordinary Matter DocumentVersion, and selects that exact version for this Task. This Workflow does not run an exhaustive search, determine legal status, expand the source set, or provide a final freedom-to-operate or infringement opinion.

Read every pinned source before analysis. Identify the exact product or process configuration and the exact patent claims selected by the lawyer. Preserve claim language when quoting it. Separate these axes throughout the report:

1. **Technical mapping:** `Present`, `Partial`, `Not shown`, or `Unclear` for each selected claim limitation against the pinned product description.
2. **Source verification:** whether both the claim passage and product passage were relocated in their current pinned DocumentVersions.
3. **Coverage and legal-status boundary:** the selected jurisdictions, families, claims, and status information reviewed, plus every missing or unverified item.
4. **Lawyer review:** the attorney's unresolved claim-construction, equivalents, status, ownership, licence, and design-around questions.

Create exactly one Matter-owned work product:

- **FTO screening report:** an editable Word document containing these standalone sections: `Scope and Limitations`, `Product Features Reviewed`, `Selected Claims Reviewed`, `Element-by-Element Screening`, and `Open Questions and Next Actions`. The `Element-by-Element Screening` section must contain one readable claim chart using these exact column headers in this order: `Claim limitation`, `Product feature mapping`, `Technical mapping`, `Source locators`, and `Unresolved question`. In every `Technical mapping` cell use exactly one label: `Present`, `Partial`, `Not shown`, or `Unclear`; put every explanation or qualification in `Unresolved question`. Every substantive mapping needs relocatable citations to the current product and patent source versions. For PDFs, include the page or printed paragraph locator and a continuous quote. For DOCX sources, include the pinned version and a continuous quote without inventing a page number.

Do not state or imply that the product is clear to operate, infringes, does not infringe, avoids infringement, or carries a quantified legal risk. Do not treat `Not shown` as a non-infringement conclusion. Record an omitted or unavailable legal-status source as unverified rather than guessing. The report must say `Internal lawyer review only` as a standalone paragraph.

Pause for Required Input instead of guessing when the product configuration or selected claim is missing or ambiguous, a claim boundary cannot be located, a source version changes, jurisdictions or relevant dates are material but unspecified, selected records conflict, a legal-status or ownership conclusion lacks a pinned source, claim construction or equivalents are outcome-sensitive, or the requested action expands beyond the fixed Matter scope. Completion requires the current Word report, relocatable citations for every material mapping, explicit coverage limitations and unresolved questions, completed steps, and final Kernel verification. Approval, client delivery, reliance, and any external action remain lawyer-controlled.
