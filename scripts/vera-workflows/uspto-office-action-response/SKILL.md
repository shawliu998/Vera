---
name: "uspto-office-action-response"
description: "Prepare a source-grounded USPTO Office Action response from pinned Matter documents."
license: "AGPL-3.0-only"
metadata:
  version: "1.0.0"
  author: "Vera"
  language: "English"
  vera-display-name: "USPTO Office Action Response"
  vera-type: "assistant"
  vera-availability: "system"
  practice: "Patents"
  jurisdictions: "United States"
---
# USPTO Office Action Response

Work only from the current Matter's pinned Office Action, current claims, and specification DocumentVersions. Create one editable Word response draft containing `Amendments to the Claims` and `Remarks`. Do not perform external searching or submit anything to the USPTO.

Read the pinned sources first. Keep three layers distinct: (1) the examiner assertion or mapping, cited to the Office Action; (2) a pinned-source fact, claim text, or specification-support statement, cited to its current Matter DocumentVersion; and (3) a provisional lawyer assessment or strategy. Address only §§101, 102, 103, or 112 grounds that actually appear in the Office Action; never invent a rejection. Every substantive conclusion needs a relocatable citation to the exact current source version. For a PDF citation, include the page and a continuous quote; for a DOCX citation, include the version and a continuous quote, but never invent a page number. Mark unsupported conclusions or missing support as unverified. Never use the generated response as evidence. If an examiner-cited reference is not pinned, do not request it solely to continue this fixed workflow. Limit statements about that reference to the examiner's exact mapping in the Office Action, state that the reference itself was not independently verified, and never convert an omission in the Office Action into a conclusion about what the reference itself fails to teach.

Process: read sources; analyze rejections, claim language, and support; obtain the lawyer's explicit prosecution-strategy choice; draft the single response; verify the deliverable, source pins, and citations. During the analyze step, record neutral strategy options in the checkpoint but do not ask for the strategy; the Work Task collects that explicit lawyer choice immediately before drafting. Pause and ask on missing required Office Action, current-claims, or specification sources, source-version drift, citation gaps, evidence conflicts, or consequential action. The draft is for lawyer review and is not an external filing.

Use a conventional USPTO response layout. Keep the document title, application metadata, `Amendments to the Claims`, `Remarks`, rejection-specific subheadings, and ordinary body paragraphs visually distinct. Do not encode the document as one nested or multilevel numbered list. Preserve claim numbers as literal claim numbers. Do not add a deposit-account authorization, filing declaration, signature block, registration number, mailing address, or placeholder for any of them unless that exact information is present in a pinned source or the lawyer expressly supplied it. Keep the draft compact and avoid a mostly blank trailing page.
