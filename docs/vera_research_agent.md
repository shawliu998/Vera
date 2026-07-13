# Vera Research Agent

## Product decision

Vera is the first domain pack for **Aletheia Research**, a local-first harness
for confidential professional research. The first release serves the handling
lawyer and legal assistant in a 5-30 person Chinese civil-commercial litigation
team.

The only end-to-end task in scope is:

`local matter -> verified legal research -> lawyer-approved legal-opinion draft`

It is intentionally not a general legal chatbot, contract platform, law-firm
OA, consumer legal service, or multi-tenant SaaS.

## Non-negotiable boundary

Matter files, client identity, evidence text, strategy, and internal research
questions remain in the local encrypted workspace. The only network egress is
the Research Broker. It accepts a lawyer-visible redacted query after a
single-use human approval and calls only a configured authorized API adapter.

The Broker never accepts a matter, fact list, document body, or arbitrary URL.
It rejects missing credentials, non-HTTPS endpoints, non-allowlisted hosts,
redirects, oversized responses, malformed provider data, and failed requests.
It does not fall back to another source.

## Core flow

1. Create a local research request by selecting confirmed Matter facts with
   their local evidence excerpts, and optionally confirmed source-bound
   procedural events, together with jurisdiction, date, and legal question.
   Vera stores the selection as an immutable local case-context work product;
   the request never accepts a client-supplied fact summary. Context ID,
   content hash, and canonical item hash are carried through plans, approvals,
   candidates, source snapshots, excerpts, input manifests, and memos. If a
   selected fact, procedural event, or local evidence excerpt changes, the
   chain is blocked and a pending memo becomes stale before approval. Its audit
   record carries only IDs, counts, and hashes, never selected fact text or
   quotations.
2. The lawyer records a bounded, acyclic local issue tree before research: one
   root issue and editable open, resolved, or missing-material subissues. The
   query plan persists that exact tree ID and hash. A later tree revision
   invalidates the old plan rather than allowing it to run under changed issues.
3. Create a redacted outbound query plan. The lawyer sees the exact text and
   approves or rejects it before any request is dispatched.
4. Research Broker searches a configured Pkulaw or Wolters authorized API and
   saves returned candidates locally.
5. The lawyer chooses a candidate and separately approves its download. The
   Broker stores the full result as an encrypted local source workpaper with
   URL, retrieval time, SHA-256 content hash, source version, effective dates,
   document kind, and case-verification metadata where supplied.
6. The lawyer confirms exact local quotes. Those quotes receive immutable quote
   hashes and are the only materials that can enter the Agent input manifest.
7. A research memo records individual conclusions with supporting, adverse, or
   neutral positions and citations to those reviewed excerpts. Deterministic
   gates reject missing snapshots, missing quotes, inapplicable law, and
   unverified case citations. No usable support produces `依据不足`, not a
   fabricated conclusion.
8. A memo requires a human review item before it can be accepted. A later
   snapshot with changed source bytes marks the memo stale and blocks approval.
9. Only accepted research conclusions are eligible for the legal-opinion
   builder. It deterministically assembles the accepted findings, exact quoted
   citations and stated limitations; it does not ask a model to add analysis.
   The opinion has its own lawyer review and approval, then produces a
   hash-bound, protected local DOCX export. A changed answer, issue tree,
   reviewed input, source snapshot or review decision blocks approval, export
   and download.

## Data and runtime

* Local persistence: SQLCipher-backed matter repository plus encrypted local
  workpaper exports.
* Authorized-source credentials: encrypted local control repository. API
  status endpoints return only masked state, never the secret.
* Current adapters: Pkulaw and Wolters are provider-neutral API contracts.
  They require a vendor-issued endpoint, allowlisted host list, and local
  credential. An official-public API adapter uses the same bounded contract but
  no credential. No commercial database scraping is implemented or planned.
* Lawyer-imported material is available in the Matter research workbench as a
  local-only fallback when no authorized API is configured. It accepts only a
  bounded legal-material record, derives its identity and hash on the server,
  and is labelled `captured_unverified`; it never represents an official or
  licensed source by itself. It still requires an exact reviewed excerpt, the
  immutable input manifest, Citation Gate, and lawyer review before it can
  support a research memo.
* Local model: not currently accepted for production research. The installed
  runtime must be registered, calibrated, and evaluated before it may propose
  facts, issue trees, query candidates, or research cards. Until then the
  related actions remain unavailable rather than returning deterministic text.

## Delivery sequence

1. Finish and expose the Research Broker workflow in the matter workbench.
2. Add local-model-backed fact and issue candidates, with lawyer confirmation
   and no external transfer.
3. Add research cards for supporting and adverse authority, legal-version and
   case-verification Gate reasons, and an explicit `依据不足` state.
4. Expose the existing opinion-builder and DOCX path in the research workbench.
5. Run an anonymized civil-commercial matter and a 20-question evaluation set;
   publish measured failures and limitations rather than claiming legal
   correctness.

## Evidence commands

```bash
cd backend
npm run test:vera:legal-research-gate
npm run test:vera:legal-research-broker
npm run test:vera:legal-opinion
npm run check:aletheia:legal-source-control
npx tsx src/scripts/legalSourceAdapterAudit.ts
```

These audits use injected authorized-API doubles only to prove broker behavior;
they are not evidence that a production database credential or a trusted local
model is configured.
