---
name: "patent-claim-comparison"
description: "Compare selected patent claim texts and prepare a cited editable Word claim comparison chart."
license: "AGPL-3.0-only"
metadata:
  version: "1.1.2"
  author: "Vera"
  language: "English"
  vera-display-name: "Patent Claim Comparison"
  vera-type: "assistant"
  vera-availability: "system"
  practice: "Patents"
  jurisdictions: "Matter-specified"
---
# Patent Claim Comparison

Work only within the current Matter and its pinned DocumentVersions. The lawyer must select at least two claim documents. Compare only the selected claim text; do not search for documents, import material, expand the source set, infer product operation, or treat an unselected document as evidence.

Read every pinned claim document before analysis. Preserve the selected claim language exactly when quoting it. Identify the selected claim number, heading, or other boundary and divide only the selected text into reviewable comparison units. If a claim boundary, claim identifier, selected text, or requested comparison scope is missing or ambiguous, pause for Required Input rather than guessing or selecting a different passage.

Create exactly one Matter-owned work product:

- **Claim comparison chart:** an editable Word document containing a clear side-by-side table. Generate a landscape chart with compact readable table text, a repeated header row, and data rows kept together rather than split across pages. Prefer one or two useful pages and do not leave a nearly blank trailing page. Place `Internal lawyer review only` as its own standalone Word paragraph, exactly as written; including the phrase only inside a title or longer sentence does not satisfy this boundary. Use these exact table headers: `Comparison unit`, `Source A selected claim text`, `Source B selected claim text`, `Textual relationship`, `Source locators`, and `Unresolved question`. In every `Textual relationship` cell, enter exactly one of these five labels and no other words or punctuation: `Same`, `Overlapping`, `Different`, `Not stated`, or `Needs lawyer review`. Put explanations, qualifications, and unresolved status only in the `Unresolved question` cell. When selected claim text is unavailable and lawyer input or a new pinned source is required, use `Needs lawyer review` for the relationship and state the missing-source request in `Unresolved question`; never append text such as `(unresolved)` to a relationship label. Keep `Source locators` compact by using stable source aliases such as `Source A (matter source identifier), Claim 1 [n]`; do not repeat a long filename in every row when the citation record already binds that alias to the pinned DocumentVersion. Include relocatable citations to the applicable pinned sources. For PDF sources, include the page or printed paragraph locator and a continuous supporting quote. For DOCX sources, include the pinned version and a continuous quote without inventing a page number.

Keep three layers distinct: (1) quoted or paraphrased selected claim text with its pinned-source locator; (2) a limited textual comparison observation; and (3) an explicit unresolved question for lawyer review. Do not determine, imply, or label infringement, freedom to operate, validity, patentability, claim construction, equivalence, enforceability, or a legal conclusion. Do not use the generated chart as evidence.

Pause for Required Input instead of guessing when claim boundaries are ambiguous, selected sources conflict, a material comparison unit cannot be located, a source version changes, a requested action expands beyond the pinned Matter scope, or a lawyer judgment is required. Completion requires the current Word chart, relocatable citations for material comparison units, explicit unresolved gaps, completed steps, and final Kernel verification. The chart is for internal lawyer review only; approval, client delivery, and reliance remain lawyer-controlled actions.
