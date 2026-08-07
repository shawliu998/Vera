---
name: "litigation-case-map"
description: "Create a source-linked first-instance civil and commercial case analysis and supporting evidence inventory for lawyer review."
license: "AGPL-3.0-only"
metadata:
  version: "1.2.0"
  author: "Vera"
  language: "English"
  vera-display-name: "Litigation Case Analysis"
  vera-type: "assistant"
  vera-availability: "system"
  practice: "Litigation"
  jurisdictions: "Matter-specified"
---
# Litigation Case Analysis

Work only from the current Matter's pinned DocumentVersions and the task-owned evidence inventory. This workflow supports first-instance civil and commercial litigation. Respect the procedural stage and represented side confirmed by counsel. Every material factual proposition must retain a relocatable citation to the pinned case record. Verified legal authority is optional for this workflow: if a pinned authority from a completed Vera Citation Research task is available, cite it with an article, paragraph, or judgment locator and the fixed authority as-of date; if no verified authority is available, explicitly mark the legal rule, element, and burden proposition as unverified or missing, keep legal authorities and case-record evidence visibly distinct, and state a concrete next-lawyer action to obtain or verify authority. Never fabricate an authority or locator.

Create exactly two Matter-owned work products: a real Tabular evidence inventory and a cited editable Word document titled `First-instance case analysis and evidence strategy`. The evidence inventory remains a document-row review of evidence items. The Word document is the primary case analysis and must use one section per disputed issue.

For every issue, preserve this relationship: legal rule or element and burden of proof; each party's position; supporting and opposing evidence; source and exact locator; gap, conflict, or uncertainty; provisional assessment; and next lawyer action. Do not flatten these into one status field. Distinguish factual dispute, evidentiary sufficiency, source verification, and lawyer-review progress. Mark missing facts, missing legal authority, and conflicts explicitly instead of inferring a tidy answer.

Process: confirm the pinned case-record set and any available authority as-of date; read the pinned record and any available authority sources; create the evidence inventory; identify and structure the disputed issues; create the cited editable Word case analysis; verify both current work products, record citations, any authority citations, and their locators. If verified authority is not yet available, continue from the pinned case record and make the missing-authority status explicit in every affected legal-rule section. Pause on missing sources, source-version drift, a material factual citation gap, evidence conflict, missing fact, an unresolved burden or legal element without a stated next-lawyer action, a required lawyer decision, material scope expansion, or consequential action. Drafts are not lawyer approval or external delivery; final and external use remain subject to the existing Review and export gates.
