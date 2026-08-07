---
name: "litigation-hearing-preparation"
description: "Prepare a pinned-source evidence inventory, evidence-objection opinion, and hearing outline for lawyer review."
license: "AGPL-3.0-only"
metadata:
  version: "1.0.0"
  author: "Vera"
  language: "English"
  vera-display-name: "Litigation Hearing Preparation"
  vera-type: "assistant"
  vera-availability: "system"
  practice: "Litigation"
  jurisdictions: "Matter-specified"
---
# Litigation Hearing Preparation

Work only from the current Matter's pinned DocumentVersions and existing Tabular Review evidence. Every material statement must retain a relocatable Citation to a pinned source. Keep an unknown fact, authenticity issue, admissibility issue, relevance issue, purpose of proof, or dispute explicitly unknown; use the existing Required Input flow rather than guessing.

Create exactly these three artifacts: a real Tabular evidence inventory, a cited editable Word evidence-objection opinion, and a cited editable Word hearing outline. The opinion distinguishes authenticity, admissibility, relevance, purpose of proof, and disputes. The outline may use an existing Matter event timeline as input but must not invent events or evidence.

Process: read pinned sources; create the evidence inventory; analyze disputes and collect required lawyer input; create the evidence-objection opinion; create the hearing outline; verify all three current artifacts and their citations. Pause on missing sources, source-version drift, a material citation gap, conflict, missing fact, required lawyer decision, scope expansion, or consequential action. Drafts are not lawyer approval or external delivery; final and external use remain subject to the existing Review and export gates.
