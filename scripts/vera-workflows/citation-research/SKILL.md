---
name: "citation-research"
description: "Prepare a source-verifiable legal research memorandum from authority materials within the current Matter."
license: "AGPL-3.0-only"
metadata:
  version: "1.0.0"
  author: "Vera"
  language: "English"
  vera-display-name: "Citation Research Memo"
  vera-type: "assistant"
  vera-availability: "system"
  practice: "Legal Research"
  jurisdictions: "Matter-specified"
---
# Citation Research Memo

## Assignment boundary

Work only within the current Matter, its pinned source versions, the jurisdiction stated in the Task, and the Task's fixed as-of date. If the jurisdiction, as-of date, material facts, or research question is missing or ambiguous, pause for the missing input instead of guessing.

This Skill states research and output requirements only. The Kernel remains responsible for Task and Step execution, Matter scope, source-version pins, Provider and Connector authorization, citations, recovery, verification, review, and export control.

## Source standard

- Count a source toward legal-authority coverage only when it comes from a formally subscribed, locally allowlisted Provider authorized for the current Task.
- Treat general web material as background only. It cannot establish that authority research is complete and cannot replace an unavailable authority Provider.
- Record the issuing body or court, jurisdiction, authority type, date, stated status, canonical citation, pinpoint, Provider external identifier, retrieval time, and the allowed excerpt for each included authority.
- Keep an unknown validity or treatment status explicitly unknown. Do not infer good-law or current-effect status from silence.
- Search for controlling, contrary, adverse, limiting, and superseding authority as well as authority supporting the proposed conclusion.

## Research process

1. Produce a `ResearchPlan` covering issues, jurisdiction, as-of date, authority types, planned queries and synonyms, contrary-authority checks, pagination, and stopping conditions.
2. Run only read-only research operations admitted by the Task-scoped Capability Resolver and the locally registered Provider adapter.
3. Continue through the declared pagination boundary. Deduplicate results by stable Provider identity and normalized citation.
4. Evaluate relevance, hierarchy, date, stated status, and conflicts. Separate Matter facts from legal analysis.
5. Produce an `AuthorityRecord` for every authority used in a material claim and a `CoverageReceipt` describing actual queries, Provider and subscription scope, pages examined, truncation, included and excluded results, conflicts, Provider failures, and remaining gaps.
6. Create an editable Word memorandum whose material legal propositions carry relocatable citations to the pinned authority versions. Include the question presented, short answer, facts and assumptions, analysis by issue, contrary authority and limitations, and conclusion.

## Mandatory pause conditions

Pause and report the unresolved gap when an eligible authority Provider is unavailable, a Provider or page fails, pagination is truncated, the Provider schema changes, authority status remains unknown where status is material, contrary authorities cannot be reconciled, the requested jurisdiction or as-of date cannot be supported, a material proposition lacks a relocatable citation, or the request would expand beyond the pinned Matter scope.

Do not present a partial or background-only search as complete authority research. Describe coverage only within the Providers, jurisdictions, dates, authority types, queries, pages, and stopping conditions recorded in the `CoverageReceipt`.

## Completion

Completion requires the `ResearchPlan`, authority records, `CoverageReceipt`, and editable cited Word memorandum to exist for the same Task and pinned source versions. The Kernel Verifier must confirm required deliverables, source support, citation relocation, jurisdiction and as-of coverage, and completed Steps. A lawyer retains control over legal judgment and final delivery.
