# Vera P1 OCR, Legal Sources, and Document Studio

Date: 2026-07-15

Supersession note (2026-07-16): this remains the implementation/acceptance
record for OCR, Source Foundation and Studio. Current product naming,
navigation, v17 baseline and the next Agent-to-Draft milestone are governed by
[`status.md`](status.md) and
[`local_legal_work_agent_vertical.md`](local_legal_work_agent_vertical.md).

Status: the integrated local-client implementation is complete for local OCR,
Project Sources, the shared citation viewer, OCR-page reopening,
Assistant/Workflow-to-Studio actions, Document Studio/DOCX, and explicit AI
suggestion review. The v13 retention lifecycle and fail-closed model/export
checks are also implemented. Real legal connectors remain deliberately
disabled because their production activation gate still requires physical
legacy-content cleanup and complete derived-lineage enforcement. The final
rebuilt arm64 client passed packaged acceptance; its hashes and truthful
unsigned release state are recorded below.

Product decision: `Project` remains Vera's generic technical owner. Matter is
the active legal-workspace projection. OCR, legal sources, and Document Studio
remain Project-owned capabilities; none becomes a sixth first-level navigation
destination or a replacement parallel workspace.

## 1. Scope

P1 productizes three existing Vera capabilities without rebuilding their
security, storage, or document foundations:

- local OCR for scanned and mixed-text Project documents;
- truthful readiness and credential controls for explicitly configured
  legal-source providers; durable legal-authority snapshots remain behind the
  retention activation gate;
- a Project-scoped Document Studio with versioned drafts, citations, safe DOCX
  interchange, bounded Assistant/Workflow draft actions, and explicit
  accept/reject AI suggestions.

The end-to-end target is:

```text
Project document
  -> local OCR when required
  -> immutable source snapshot and citation anchors
  -> Assistant / Workflow / configured legal-source research
  -> Document Studio draft and explicit user edits
  -> versioned DOCX export
```

## 2. Reuse boundary

P1 reuses rather than duplicates:

- `desktop/native/aletheia-ocr.swift`, PDFKit, and Apple Vision;
- the Workspace document parser, encrypted blobs, jobs, chunks, and versions;
- the retained legal-source adapters and their hardened external transport;
- Mike-derived TipTap editing components;
- the existing DOCX generation, template, content-disarm, and round-trip code;
- SQLCipher, Keychain-backed application/database keys, the retained
  application-envelope-encrypted legal-source credential store, backup,
  restore, and desktop packaging. Model-provider credentials remain on the
  separate Keychain-only credential-worker path.

Legacy Matter, evidence-graph, approval-gate, and Word Add-in surfaces remain
outside the primary Vera product path. Compatibility adapters may call stable
legacy services, but new Project data must not be written into Matter tables.

## 3. Shared contracts

All three tracks converge on two transport-safe concepts:

### Source snapshot

A snapshot is immutable, Project-scoped provenance for either a Project
document version or a legal authority. It records the provider-neutral source
kind, content hash, locator, retrieval time, and declared retention policy.
Provider secrets, filesystem paths, and unrestricted vendor payloads are not
stored in the public projection. A legal source cannot be activated until the
retention policy has the fail-closed enforcement described below.

### Citation anchor

A citation anchor belongs to one snapshot and records an exact quote plus its
stable locator. A Project-document locator may include document version,
chunk, page, offsets, and OCR geometry. A legal-authority locator may include
the authority identifier, section, paragraph, or provider locator. Anchors
must carry a quote hash so stale or modified source text fails closed.

Existing Assistant message sources and Tabular citations remain compatible.
Adapters may project them into the shared contract; P1 does not require a
destructive rewrite of existing history.

## 4. OCR track

The default provider is packaged Apple Vision and it operates locally. The
original file is never overwritten. OCR is a resumable derived operation
bound to the original document version, provider version, requested pages,
and settings.

Required behaviour:

- OCR only pages for which normal extraction produced no usable text;
- retain page text, confidence, and source geometry sufficient to reopen the
  original location;
- provide bounded progress, cancellation, timeout, retry, and restart-safe
  terminal status;
- cache idempotently by source hash, page range, provider, and settings;
- make low-confidence pages visible for user review;
- make no cloud request unless a future provider is explicitly configured and
  selected by the user.

The native helper and its Node caller must remain backward compatible with the
packaged v1 audit until the v2 contract is fully covered.

## 5. Legal-source track

The provider contract owns search, metadata, document/excerpt retrieval,
citation resolution, health, and declared capabilities. The model gateway
never calls an external legal source directly.

Every provider declares:

- configured and connection status;
- whether full text, excerpts, or metadata may be persisted;
- cache time-to-live;
- whether content may be exported or sent to a configured model;
- supported search and citation-resolution capabilities.

Commercial providers are unavailable until the user supplies licensed API
configuration. Vera must not scrape a provider, invent an endpoint, silently
substitute fixtures, or display a successful connection without a real check.
Legal-source credentials use the retained compatibility path: the renderer
submits a write-only value once, the backend stores only application-envelope
ciphertext plus non-secret hint/status fields in SQLCipher, and decryption is
server-side only. The encryption keys remain Keychain-backed. Plaintext and
credential readback never enter renderer responses, logs, or diagnostics.

The current implementation provides the provider contract and reports the
real local configuration state only. `configured_unverified` means that a
configuration is present but a live connection has not been verified. It is
never a successful connection state. Public Project Source routes do not
accept `legal_authority` snapshot or anchor writes.

### Retention activation gate

The v13 lifecycle now fails closed for expired and tombstoned legal snapshots
and anchors. Read, new-anchor creation, Studio binding, Studio export, and
configured-model use are rechecked at their final boundary. Assistant,
Workflow, and Tabular execution repeat the check immediately before each model
call so a source tombstoned after an earlier read cannot escape through a
TOCTOU window. Public Project Source projections redact prohibited legal
payloads, and local-only policies never reach a configured model.

Production activation remains code-owned and closed. The remaining blockers
are not UI work: legacy v11 rows can still physically contain exact quotes or
full text pending a verified cleanup lifecycle; every derived artifact must
retain legal-source lineage; and every future model/export callsite must prove
it uses the same final-boundary gate. In particular, a legal source must not be
laundered through one Studio document into a later Assistant message or Studio
document as an ordinary Project source. Until these conditions are proven,
configured providers report `activation_gate_closed`, credentials are not
read, and provider calls remain zero.

This gate applies to retained legal-provider content. Current Project document
snapshots are user-provided and use `full_text_permitted` with no TTL, so their
Project Source and Studio citation flow is not blocked by this activation gate.

## 6. Document Studio track

Document Studio is an edit mode for a Project document, not a parallel root
document system. It extends the existing Workspace documents, immutable
versions, and edit suggestions.

Delivered local-client slice:

- create a blank Project draft;
- edit a canonical TipTap document with a safe plain-text/Markdown projection;
- save with compare-and-swap revision checks and explicit conflict handling;
- create immutable content checkpoints, list and read historical versions, and
  restore by creating a new version rather than mutating content history;
- attach citations to a specific document version and preserve their exact
  source identity;
- import and export macro-free DOCX through the existing safe round-trip path;
- remain fully readable and editable after desktop restart while model or legal
  providers are offline.

Assistant and completed Workflow outputs can create immutable Studio drafts by
durable identity; the server reloads and revalidates the completed source
rather than accepting renderer-supplied content. Project citations use one
shared source viewer, including verified PDF-page navigation. AI changes are
durable, bounded suggestions: the model must read the current document before
suggesting an edit, the user reviews the exact diff, and accept/reject is an
explicit operation. Acceptance verifies the reviewed suggestion, base version,
exact splice, citation provenance, source execution, and retention policy
before atomically creating a `user_accept` version. The model never overwrites
the document autonomously.

Pixel-perfect Word fidelity, Word Add-in, collaborative editing, cloud sync,
arbitrary HTML, and autonomous overwrite are not P1 requirements.

## 7. Delivery sequence

### Gate A: shared foundation

- additive Workspace migration and repositories for snapshots and anchors;
- verified reuse of the existing durable `document_parse` job type (no new
  competing OCR or Studio job constraint is needed for the first vertical);
- compatibility tests against a real v10 database and a fresh database;
- no product UI change.

### Gate B: independent verticals

- local OCR provider and Project document status/review;
- legal-source provider contract and Settings readiness;
- Document Studio persistence, routes, editor, versions, and DOCX interchange.

These tracks may run in parallel only after their table and file ownership is
explicit. They must not each create competing provenance or credential models.

### Gate C: convergence

- Project-document citations use the shared source viewer; the same contract is
  reserved for legal authorities when provider activation becomes safe;
- Assistant and Workflow create a Studio draft through bounded identity-only
  actions backed by durable completed output;
- OCR-derived citations reopen the verified original PDF page;
- legal-source retention and licence policy is enforced during enabled model
  and export paths, while provider activation remains closed for the blockers
  documented above.

### Gate D: packaged acceptance

The packaged client must complete the full scanned-document-to-DOCX flow,
release its ports on exit, and recover the same encrypted Project, jobs,
citations, draft, and versions on restart. No fixture provider may satisfy this
gate.

The packaged acceptance audit now exercises the real Apple Vision helper,
Project Source snapshot and exact citation anchor, Studio citation binding,
encrypted restart, renderer source-viewer action, and verified PDF-page
navigation. It uses a generated image-only PDF and the packaged client rather
than a fixture provider. Final artifact hashes are accepted only after this
audit and the packaging/security gates pass against the newly built app.

## 8. Quality gates

Minimum evidence before a track is called complete:

- backend TypeScript build and focused Workspace migration/repository audits;
- provider contract tests for unavailable, configured, timeout, cancellation,
  redirect, retention, and redaction behaviour;
- native and packaged OCR audits using text-only, image-only, and mixed PDFs;
- frontend lint/source tests for real API wiring, accessibility, failure, and
  empty states;
- malicious or unsupported DOCX input fails closed;
- a packaged cross-restart E2E validates encrypted persistence and original
  source location;
- the pre-existing P0 client and desktop security suites remain green.

## 9. Rollback

Migrations are additive and legacy routes remain mounted. Each new UI surface
is capability-gated by the real local backend. If a vertical is disabled or
rolled back, existing Projects, document versions, Assistant history,
Workflows, and Tabular Reviews remain usable. Rollback must never delete source
snapshots or rewrite original files.

## 10. Implementation evidence (2026-07-15)

Completed:

- v11 Project source snapshots and citation anchors, including immutable
  provenance, Project isolation, policy metadata, and upgrade/rollback tests;
- the packaged Apple Vision OCR provider contract, mixed-PDF page selection,
  normalized top-left geometry, confidence, timeout, cancellation, and legacy
  helper compatibility;
- bounded `vera-document-chunk-ocr-v1` provenance in existing Workspace chunks:
  engine, coordinate space, page, page-local UTF-16 origin, page confidence,
  low-confidence state, and intersecting text-free block geometry; metadata is
  size/count bounded and rejects malformed page binding;
- versioned `vera-pdf-page-spans-v1` PDF extraction metadata, so Project page
  assignment is derived from structured UTF-16 spans rather than scanning
  user-controlled `[Page n]` text; malformed, discontinuous, duplicate, and
  surrogate-splitting spans fail closed;
- current-version OCR summaries and Mike-style OCR/review badges in the
  existing Project document list and side panel, including bounded
  low-confidence page numbers and truncation state, without a new top-level
  navigation destination;
- authenticated, Project-scoped Source APIs for capturing immutable Project
  document-version snapshots, bounded listing/detail reads, and verified
  exact-quote anchors; all snapshot identity, policy, hash, locator, and
  ordinal fields are derived or rechecked by the backend;
- strict citation offsets and integrity behaviour: chunk-local and page-local
  offsets are UTF-16 code units, verified document offsets explicitly identify
  the normalized document-text basis, duplicate quotes require explicit
  offsets, and historical padded chunks omit document offsets that cannot be
  proven rather than guessing them;
- UTF-16 chunk boundaries preserve surrogate pairs, including emoji at the
  fixed chunk and overlap boundaries, while multi-chunk coverage continues to
  advance without gaps and every quote anchor reproduces its exact source
  slice;
- immutable snapshot, version, chunk, and quote hashes are revalidated at the
  relevant read/write boundary. Tampered hashes, malformed OCR metadata,
  synthetic page-marker offsets, cross-Project references, and unsafe
  structured metadata fail closed; structured response metadata excludes
  filesystem paths and secrets;
- the legal-research provider boundary and truthful
  `configured_unverified`/`unavailable` configuration states for authorized
  gateways. This is a contract/readiness implementation, not evidence of a
  successful legal-provider connection, and public `legal_authority` writes
  remain closed;
- a code-owned production activation gate on every environment-backed legal
  Provider: even fully configured endpoint/allowlist/credential environments
  return `activation_gate_closed`, do not read the credential, and perform no
  outbound fetch until every remaining activation blocker is closed;
- a Mike-layout `/settings/legal-sources` page with strict local status reads,
  write-only locally encrypted credential entry, removal, responsive
  empty/error states, and no renderer-side provider call or synthetic
  connection test;
- v12 Project Document Studio over the existing encrypted documents, versions,
  blob records, and parse jobs;
- real blank-draft creation, Markdown editing, immutable CAS saves, historical
  reads, version listing, restore-as-new-version, version-bound citations, and
  restart persistence;
- Studio version content, content hashes, source lineage, and citation bindings
  are immutable. A user rename may update the current version's filename
  metadata for compatibility with the generic Project document model;
- the shared Mike-derived TipTap Markdown editor used by both Workflows and
  Document Studio, with no duplicate editor implementation;
- capability-gated Project UI: only real v12 draft/template lineage opens in
  Studio, and generic version upload cannot bypass the Studio lineage;
- complete Project-scoped DOCX import/export routes and Studio UI integration,
  including immutable historical export, CAS import, bounded warnings, and
  explicit simplification behaviour;
- a shared fail-closed DOCX package preflight used before PizZip, Mammoth, and
  the litigation compatibility path: raw ZIP directory/header validation,
  canonical duplicate/path rejection, CRC verification, ZIP64/multi-disk and
  active-content rejection, strict support for standard signed/unsigned ZIP
  data descriptors, and bounded DEFLATE expansion before downstream parsing.
- a Project-scoped source viewer that reloads bounded authoritative content,
  verifies snapshot/version/chunk/quote hashes and page bounds, and opens PDF
  citations at the exact verified page rather than trusting renderer locators;
- identity-only Assistant and Workflow entry actions that reload completed
  durable output, reject cross-Project or incomplete sources, reuse validated
  provenance, and create immutable `assistant_edit` Studio versions;
- v13 legal-source lifecycle state with monotonic expiry/tombstone handling,
  final-boundary model/export checks, public-payload redaction, and TOCTOU
  audits proving a tombstoned source causes zero provider calls;
- v14 durable Studio suggestions with read-before-suggest, bounded previews and
  exact detail reads, a maximum of 50 pending suggestions per document,
  lease/retry/cancel cleanup, stale-version rejection, Unicode-safe splices,
  and atomic accept/reject semantics;
- strict renderer binding between the reviewed suggestion and the accepted
  document: identity, Project scope, base/current version, exact diff/content,
  `user_accept` source, citation provenance, and poisoned responses all fail
  closed;
- explicit unsigned and Developer ID release modes. The signed path verifies
  exact authority and Team ID, hardened runtime, every nested executable, the
  final DMG's mounted Vera.app, notarization, and stapling. Offline audits stub
  all signing/notary/keychain/network operations and cannot publish artifacts.

Intentionally deferred gates and follow-on work:

- keep real legal connectors disabled until legacy legal exact-quote/full-text
  rows have a proven physical-cleanup lifecycle, derived artifacts preserve
  legal lineage end to end, and all model/export callsites are covered by the
  final-boundary gate;
- keep public release readiness false until a real Developer ID Application
  identity and Apple notarization credentials are supplied and the signed
  artifacts pass the strict online verification path;
- pixel-perfect Word fidelity, Word Add-in support, collaborative editing,
  cloud sync, arbitrary HTML, and autonomous overwrite remain outside this
  local-client scope.

Final packaged acceptance passed on arm64. The audit used the real packaged
Apple Vision helper and an image-only PDF; created a Project snapshot, bounded
chunk, exact quote anchor, and Studio citation binding; performed the DOCX
export/import round trip; restarted the same SQLCipher/AES-GCM profile; and
reloaded the original immutable source version. The renderer then opened the
shared citation viewer, requested the exact historical `version_id`, verified
`application/pdf`, highlighted the exact quote, and opened PDF page 1. Studio
remained saved throughout, both app launches closed without a browser dialog,
and all local ports were released.

The package script built into an isolated staging directory, ran startup,
migration, Workspace, backup, interrupted-restore, package-hygiene, and native
OCR acceptance before atomically replacing `desktop/dist`. Failure or signal
interruption restores the previous artifacts. The resulting release state is
truthfully `signed=false`, `notarized=false`, and `releaseReady=false`; these are
complete local-client artifacts, not public release candidates.

Acceptance artifacts:

- `desktop/dist/mac-arm64/Vera.app`;
- `desktop/dist/Vera-1.0.1-arm64.dmg` (198,122,845 bytes), SHA-256
  `fd246214916b3485e25bb16c8e00bcf6e8be471ed95679190e7685a5c1c49ef8`;
- `desktop/dist/Vera-1.0.1-arm64.zip` (200,992,113 bytes), SHA-256
  `7be4a9504151ddd8518141901e3d2753a1cda2fbe13ac27fa7842a9f3d347f1b`;
- `desktop/dist/Vera-1.0.1-SHA256SUMS.txt`, reverified with both artifacts
  reporting `OK`.

Verified commands:

```text
cd backend && npm run test:workspace:p0-client
cd frontend && npm run test:p0-client
cd backend && npm run build
cd frontend && npm run lint
cd frontend && NEXT_PUBLIC_ALETHEIA_LOCAL_CLIENT=true npm run build
cd desktop && npm run test:p0-source
cd desktop && npm run test:signing-pipeline
VERA_RELEASE_SIGNING=false ./scripts/package-desktop-mac.sh
cd desktop/dist && shasum -a 256 -c Vera-1.0.1-SHA256SUMS.txt
git diff --check
```
