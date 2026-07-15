# Vera Reuse Decisions

Date: 2026-07-16

Status: Gate 0 decision record

This document records the reuse boundary for Vera Individual. It complements
the path-level Mike inventory in `docs/mike_port_manifest.md`, the maintained
source inventory in `docs/provenance/open-source-inventory.md`, and the shipped
notices in `THIRD_PARTY_NOTICES.md`.

Mentioning a candidate here does not authorize source, assets, model weights,
datasets, prompts, product copy, or runtime dependencies to enter Vera. An
external candidate without a reviewed canonical repository, fixed version or
commit, and verified license remains `reference_only` or `reject`. Unknown
license terms are never inferred from a project name, reputation, or prior
version.

Allowed reuse modes in this record are `direct`, `adapt`,
`extract_algorithm`, `reference_only`, and `reject`.

## 1. Open Legal Products Mike

- **Capability:** Product shell, Assistant, Project workspace, Workflows,
  Tabular Review, Settings, shared UI primitives, and established interaction
  patterns.
- **Existing Vera implementation:** The active Mike-derived Vera client uses
  controlled ports documented path by path in `docs/mike_port_manifest.md`.
  Vera replaces Mike cloud dependencies with the single local Workspace API,
  SQLCipher, encrypted blobs, Keychain credentials, and the existing durable
  job runtime.
- **Candidate project:** Open Legal Products Mike,
  `https://github.com/Open-Legal-Products/mike`.
- **Exact version/commit:**
  `e32daad5a4c64a5561e04c53ee12411e3c5e7238`. Floating upstream branches are
  not approved sources.
- **License:** `AGPL-3.0-only`, as recorded in the approved manifest and root
  third-party notice.
- **Product fit:** High for the existing desktop information architecture,
  interaction model, and reusable legal-workspace UI.
- **Architecture fit:** High only through controlled ports. Mike must not be
  nested as a second application, and its Supabase, organization, sharing,
  cloud-storage, or server-secret architecture must not be reintroduced.
- **Security impact:** Every adapted path remains subject to Vera loopback
  authentication, renderer sandboxing, SQLCipher, encrypted blob, Keychain,
  audit, backup/restore, and bounded-request controls. Renderer-only hiding is
  not an authorization control.
- **Maintenance impact:** The fixed SHA and source-lock comments make updates
  deliberate. Any additional port requires a manifest entry, reviewed diff,
  provenance comment, and regression coverage.
- **Decision:** Continue the already-approved controlled reuse. Do not follow
  Mike `main` or import unlisted subsystems.
- **Reuse mode:** `direct` for approved isolated components and pure behavior;
  `adapt` for the path-specific local-runtime, cloud-removal, Vera-brand, i18n,
  security, and accessibility changes recorded in the manifest.
- **Copied/adapted files:** Existing controlled files only, exactly as listed
  in `docs/mike_port_manifest.md`. This decision authorizes no additional file
  copy.
- **Required notices:** Retain the root `LICENSE`, the Open Legal Products Mike
  section in `THIRD_PARTY_NOTICES.md`, `docs/license_attribution.md`, the Mike
  manifest, and original copyright/provenance comments in affected files.

## 2. SQLCipher Node binding

- **Capability:** Encrypted Workspace SQLite database binding and linked
  SQLCipher runtime.
- **Existing Vera implementation:** Workspace encrypted mode uses the existing
  `@signalapp/sqlcipher` dependency and verifies the linked cipher/runtime as a
  security and release gate.
- **Candidate project:** Signal `@signalapp/sqlcipher`,
  `https://github.com/signalapp/node-sqlcipher`.
- **Exact version/commit:** npm package `3.3.9`; the backend lockfile records
  the exact package URL and integrity
  `sha512-51NAV0CqIEreGx3r0hq85vjHC8NXZhGr9efywaqHRsjpbEdvdYARmFxObmMI55rjyqE5eLQ/QsPJzigBoQ6thw==`.
- **License:** `AGPL-3.0-only`, verified from installed package metadata and
  `backend/package-lock.json`.
- **Product fit:** High; it is the established database encryption dependency
  for the local desktop product.
- **Architecture fit:** High; it preserves the single Workspace database and
  requires no parallel persistence service.
- **Security impact:** Positive only when encryption is mandatory and runtime
  attestation, downgrade rejection, file permissions, backup, and restore
  checks remain fail-closed. Plain `node:sqlite` must never be described as
  SQLCipher-encrypted.
- **Maintenance impact:** Native prebuild compatibility, Electron/Node ABI,
  macOS packaging, upstream security fixes, and package integrity require
  continued release testing.
- **Decision:** Continue the pinned dependency; upgrades require a separate
  dependency, license, native-build, migration, and packaged-runtime review.
- **Reuse mode:** `direct`.
- **Copied/adapted files:** No upstream source is copied into Vera. The exact
  dependency is installed through `backend/package.json` and
  `backend/package-lock.json`.
- **Required notices:** Retain the SQLCipher Node binding section in
  `THIRD_PARTY_NOTICES.md` and distribute the installed package license as
  required.

## 3. Existing Vera Word/Office proof of concept

- **Capability:** Word task-pane manifest, selected-text capture, and a
  review-only handoff into retained Legacy matter records.
- **Existing Vera implementation:** `office-addin/word-manifest.xml` and
  `frontend/src/app/office/word/page.tsx` form a Hermes/Aletheia proof of
  concept. It is not the target Vera Word Local Bridge and currently depends on
  Legacy APIs and product semantics.
- **Candidate project:** Existing Vera repository implementation. The current
  provenance record identifies no copied external project source for these
  proof-of-concept entry files.
- **Exact version/commit:** Repository commit
  `52cdf15cb10dba90896a277c4b7a91d0026ac22f` is the recorded introduction
  point for the manifest/page baseline.
- **License:** The repository files are governed by Vera's recorded
  `AGPL-3.0-only` baseline. The separately loaded Microsoft Office.js runtime
  is not covered by this repository license decision.
- **Product fit:** Partial. Selection capture and review-before-apply behavior
  are useful, but Hermes/Aletheia naming, Legacy data ownership, and the current
  handoff contract are not active-product foundations.
- **Architecture fit:** Partial. The existing package should be migrated in
  place so Vera retains one Add-in, but its data path must move to the single
  authenticated `/api/v1` composition root and a bounded local capability
  bridge.
- **Security impact:** The target must use short-lived, Matter/document-scoped
  capability tokens, an explicit Office-origin allowlist, explicit Matter
  selection, bounded selected content, no Keychain access, no provider
  credential, and no automatic whole-document upload or mutation.
- **Maintenance impact:** Office host compatibility, manifest validation,
  origin/CSP behavior, bridge lifecycle, cross-restart pairing, and packaged
  macOS/Word testing create a dedicated integration surface.
- **Decision:** Migrate and replace the existing proof of concept in place
  during the Word gate. Do not create or ship a second simultaneous Add-in, and
  do not expose the Legacy implementation as the target integration.
- **Reuse mode:** `adapt` for the existing repository package boundary and validated
  selection/review behavior; no Legacy repository or route is reused by the
  active integration.
- **Copied/adapted files:** Existing
  `office-addin/word-manifest.xml` and
  `frontend/src/app/office/word/page.tsx`. No new external file copy is
  authorized here.
- **Required notices:** Vera's root AGPL notice remains applicable. Before
  target release, separately record every Office runtime or official sample
  actually used, its exact version/source, terms or license, copied files, and
  required Microsoft notices.

## 4. Microsoft-hosted Office.js runtime

- **Capability:** Official Office host APIs used by the retained Word proof of
  concept.
- **Existing Vera implementation:** The Legacy page loads
  `https://appsforoffice.microsoft.com/lib/1/hosted/office.js`; the script is
  hosted, not vendored.
- **Candidate project:** Microsoft Office.js hosted runtime and official Office
  Add-in documentation/samples.
- **Exact version/commit:** Not pinned. `/lib/1/hosted/office.js` is a moving
  hosted endpoint, not an approved immutable version.
- **License:** Not verified for the target Vera distribution in the current
  provenance record. Microsoft platform terms, official sample licenses, and
  distribution requirements require review.
- **Product fit:** Potentially high because Office.js is the official Word
  Add-in API, but only the minimum capabilities required by Vera should be
  used.
- **Architecture fit:** Reference fit only until the target manifest,
  origin/CSP model, local bridge, and runtime distribution approach are
  reviewed.
- **Security impact:** A moving hosted script expands supply-chain and network
  trust. The Add-in must not receive provider credentials or unrestricted local
  access, and host-origin/capability checks must be authoritative in the local
  bridge.
- **Maintenance impact:** Microsoft host/API compatibility and terms can change
  independently of Vera; exact supported requirement sets and update policy
  must be owned by the Word integration.
- **Decision:** Keep the current reference confined to the retained Legacy POC.
  Do not approve it as the target runtime dependency until pinning/terms and
  security review are complete.
- **Reuse mode:** `reference_only`.
- **Copied/adapted files:** None. The current Legacy page contains only a hosted
  script reference; no Office.js source is copied into Vera.
- **Required notices:** None are newly asserted by this record. The Word gate
  must determine and add the exact notices and terms required by the runtime or
  official samples actually selected.

## 5. June

- **Capability:** Saved-audio-first patterns, separation of local data and
  hybrid inference, crash recovery, agent sandboxing, and tool-broker concepts.
- **Existing Vera implementation:** Vera already owns local encrypted storage,
  durable jobs, model gateway, credential isolation, and fail-closed lifecycle
  controls. Conversation capture has not been approved as a new active module.
- **Candidate project:** June; no canonical repository or edition is approved
  in the current provenance inventory.
- **Exact version/commit:** Not pinned.
- **License:** Not verified. No license is inferred.
- **Product fit:** Useful for architecture study, especially saved-audio-first
  and recovery behavior; general computer/media-agent features are out of Vera
  scope.
- **Architecture fit:** Reference fit only. Vera must not be rewritten to
  Tauri, embed Hermes, or import a second agent runtime, database, or frontend.
- **Security impact:** Importing unreviewed sandbox, capture, credential, or
  tool code could expand filesystem, process, network, and secret access.
- **Maintenance impact:** Unknown until the exact project, edition,
  dependencies, release model, and native components are identified.
- **Decision:** Study public architecture concepts only. No code, assets,
  prompts, models, or dependencies may be copied.
- **Reuse mode:** `reference_only`.
- **Copied/adapted files:** None.
- **Required notices:** None while no source is copied. Any future proposal
  requires a fixed source, verified license, file-level provenance, dependency
  review, and corresponding notices before implementation.

## 6. Meetily

- **Capability:** Future device/system-audio capture, VAD, noise reduction,
  local transcription integration, and crash-recoverable recording patterns.
- **Existing Vera implementation:** The active product has no approved
  Conversation capture runtime. A Legacy Python voice sidecar remains isolated
  and is not a target implementation.
- **Candidate project:** Meetily; the current inventory records it only as a
  research candidate.
- **Exact version/commit:** Not pinned.
- **License:** Not verified. No license is inferred.
- **Product fit:** Potential future fit for bounded audio primitives after
  Conversation requirements are validated; its meeting UI, database,
  summarizer, updater, and application shell do not fit Vera.
- **Architecture fit:** Any approved primitive would have to be isolated in a
  minimal capture sidecar with no Matter, credential, Review, or document
  ownership. No Tauri shell or second database is permitted.
- **Security impact:** Audio-device and system-audio access, raw-audio
  retention, native permissions, model loading, and updater behavior require
  dedicated review.
- **Maintenance impact:** Native macOS APIs, Rust crates, model adapters,
  packaging, permissions, and upstream compatibility would add material cost.
- **Decision:** Architecture reference only until exact source, file scope,
  license, transitive dependencies, and security tests are approved.
- **Reuse mode:** `reference_only`.
- **Copied/adapted files:** None.
- **Required notices:** None while no source is copied. A future approved import
  must add the exact upstream copyright/license, selected file inventory,
  transitive notices, and separately reviewed model notices.

## 7. Vexa

- **Capability:** Online meeting-bot and pre-/post-meeting knowledge workflows.
- **Existing Vera implementation:** Vera has no active meeting-bot cluster and
  does not need one for the Individual desktop product.
- **Candidate project:** Vexa; the current inventory records it only as a
  research candidate.
- **Exact version/commit:** Not pinned.
- **License:** Not verified. No license is inferred.
- **Product fit:** Low for the desktop MVP; selected public workflow concepts
  may inform later Conversation planning.
- **Architecture fit:** Poor for active reuse because a bot cluster, Docker or
  Kubernetes runtime would create a parallel deployment and operations model.
- **Security impact:** Meeting credentials, external network access,
  participant data, recording consent, and multi-service storage materially
  exceed the current product boundary.
- **Maintenance impact:** High and unjustified for Vera Individual.
- **Decision:** Use only as a public product/architecture reference. Do not
  import its bot runtime, services, UI, storage, or deployment stack.
- **Reuse mode:** `reference_only`.
- **Copied/adapted files:** None.
- **Required notices:** None while no source is copied.

## 8. LangExtract

- **Capability:** Schema-constrained extraction, exact-source grounding, and
  refusal when source location cannot be established.
- **Existing Vera implementation:** Vera already has a model gateway, immutable
  Source Snapshot, Citation Anchor, bounded document retrieval, and strict
  TypeScript contracts that should own the target extraction boundary.
- **Candidate project:** LangExtract; no reviewed source pin is present in the
  current inventory.
- **Exact version/commit:** Not pinned.
- **License:** Not verified. No license is inferred.
- **Product fit:** High as a conceptual reference for grounded extraction.
- **Architecture fit:** The preferred implementation is a thin Vera-native
  contract over the existing model/source stack. A permanent Python sidecar or
  parallel provenance model does not fit without a demonstrated gap.
- **Security impact:** Any runtime reuse would need bounded inputs/outputs,
  prompt and source-content controls, provider policy enforcement, safe errors,
  and exact-anchor verification.
- **Maintenance impact:** External runtime and schema drift would be avoidable
  cost unless a measured capability gap justifies them.
- **Decision:** Reproduce the required behavior independently in Vera using
  public concepts; do not copy code before a separate pin/license review.
- **Reuse mode:** `reference_only`.
- **Copied/adapted files:** None.
- **Required notices:** None while no source is copied. Public conceptual
  reference must not be represented as imported implementation.

## 9. Graphiti

- **Capability:** Temporal facts, validity intervals, supersession, relations,
  and provenance concepts.
- **Existing Vera implementation:** Vera's target uses SQLCipher tables,
  immutable revisions, typed relations, and source links; no graph server is
  required.
- **Candidate project:** Graphiti; no reviewed source pin is present in the
  current inventory.
- **Exact version/commit:** Not pinned.
- **License:** Not verified. No license is inferred.
- **Product fit:** Useful as a conceptual reference for temporal and
  supersession semantics.
- **Architecture fit:** Source/runtime reuse does not fit the current product.
  Neo4j, FalkorDB, or another graph database would violate the single-database
  boundary.
- **Security impact:** A graph service would create new storage, network,
  backup, encryption, access-control, and deletion surfaces.
- **Maintenance impact:** High relative to a bounded SQLCipher revision model.
- **Decision:** Reference concepts only; independently implement required
  temporal semantics in the existing Workspace database.
- **Reuse mode:** `reference_only`.
- **Copied/adapted files:** None.
- **Required notices:** None while no source is copied.

## 10. FunASR

- **Capability:** Future Chinese ASR, VAD, punctuation, hotwords, and related
  speech-model adapters.
- **Existing Vera implementation:** No FunASR toolkit, model, weight, or dataset
  is approved or bundled. The retained Legacy voice adapter is not approval for
  a new Conversation runtime.
- **Candidate project:** FunASR toolkit and separately selected models/weights.
- **Exact version/commit:** Not pinned for code; no model or weight version is
  selected.
- **License:** Not verified for either toolkit code or any model, weight,
  dataset, training data, or redistribution terms. No license is inferred.
- **Product fit:** Potentially high for optional Chinese transcription after
  Conversation requirements and quality targets are established.
- **Architecture fit:** Only a bounded optional adapter could fit. It must not
  own Matter, Source, Proposal, Review, credentials, or a second job/database
  runtime.
- **Security impact:** Model loading, native/Python execution, audio retention,
  network downloads, cache paths, and model provenance require separate
  controls.
- **Maintenance impact:** High because toolkit compatibility and every selected
  model artifact need independent versioning, quality, packaging, and license
  review.
- **Decision:** No implementation reuse or model distribution is approved.
  Evaluate only when the optional Conversation gate begins.
- **Reuse mode:** `reference_only`.
- **Copied/adapted files:** None.
- **Required notices:** None now. Future approval requires separate notices and
  provenance for toolkit code and for every selected model/weight/dataset.

## 11. WhisperX

- **Capability:** Future speech alignment and word-level timestamps.
- **Existing Vera implementation:** Vera has no approved WhisperX code,
  dependency, model, or alignment weight in the active product.
- **Candidate project:** WhisperX and separately selected Whisper/alignment
  models.
- **Exact version/commit:** Not pinned for code; no model or weight version is
  selected.
- **License:** Not verified for the complete code/dependency/model chain. No
  license is inferred.
- **Product fit:** Potential future fit for precise transcript anchors, subject
  to measured Chinese-language quality and packaging feasibility.
- **Architecture fit:** Only an optional transcription/alignment adapter may
  fit; it cannot introduce a second Matter/source/provenance model.
- **Security impact:** Python/native execution, model acquisition, cache
  locations, audio handling, and potential network access require review.
- **Maintenance impact:** High due to model/runtime compatibility, native
  dependencies, packaging size, and hardware variation.
- **Decision:** Research reference only until code and every selected model are
  independently pinned and licensed.
- **Reuse mode:** `reference_only`.
- **Copied/adapted files:** None.
- **Required notices:** None now. Future approval requires code, dependency,
  model, and dataset provenance/notices as applicable.

## 12. pyannote

- **Capability:** Future speaker diarization and speaker-segment attribution.
- **Existing Vera implementation:** No pyannote code or model is approved or
  bundled. Speaker correction remains a future Conversation capability.
- **Candidate project:** pyannote toolkit and separately gated diarization
  models.
- **Exact version/commit:** Not pinned for code; no model revision is selected.
- **License:** Not verified. Toolkit licensing alone would not establish model
  access, use, redistribution, or training-data rights; no license is inferred.
- **Product fit:** Potential fit for optional diarization after user need and
  Chinese/multilingual quality are validated.
- **Architecture fit:** Only a bounded adapter may fit. Human speaker correction
  must remain authoritative and machine attribution must not overwrite the
  reviewed transcript layer.
- **Security impact:** Gated model access, account tokens, model downloads,
  local caches, biometric/privacy implications, and raw-audio handling require
  dedicated review.
- **Maintenance impact:** High due to model gating, version compatibility,
  quality evaluation, hardware requirements, and redistribution constraints.
- **Decision:** No code or model reuse is approved; retain as a future research
  reference only.
- **Reuse mode:** `reference_only`.
- **Copied/adapted files:** None.
- **Required notices:** None now. Future approval requires separate toolkit,
  model, weight, and dataset provenance and notices.

## 13. Screenpipe

- **Capability:** Timeline and local-capture interaction concepts.
- **Existing Vera implementation:** Vera does not need continuous screen
  capture for its legal workspace and has no approved Screenpipe source or
  runtime.
- **Candidate project:** Screenpipe or any similarly named/packaged edition.
- **Exact version/commit:** No approved source or version is pinned.
- **License:** Not approved. The current inventory explicitly warns that
  source-available or commercial terms must not be treated as ordinary
  open-source permission.
- **Product fit:** Low. Continuous screen capture is outside the current Matter,
  document, source, Review, and optional Conversation scope.
- **Architecture fit:** Poor; it would add broad capture, storage, indexing,
  retention, and potentially background-agent surfaces.
- **Security impact:** Unbounded screen content can expose credentials,
  privileged communications, unrelated matters, personal data, paths, and
  third-party applications.
- **Maintenance impact:** High and not justified by the approved roadmap.
- **Decision:** Use only public high-level timeline and local-capture
  interaction concepts as a reference. Reject source, runtime, model, and asset
  reuse absent separate written authorization and a future product decision
  that changes scope.
- **Reuse mode:** `reference_only` for public concepts; source, runtime, model,
  and asset reuse remains rejected.
- **Copied/adapted files:** None.
- **Required notices:** None because no source or assets are incorporated.

## 14. Harvey

- **Capability:** Publicly described enterprise legal AI capability families,
  including Assistant, document work, workflow agents, knowledge,
  integrations, and governance.
- **Existing Vera implementation:** Vera independently implements its local
  Workspace, documents, Assistant, workflows, sources, Studio, security, and
  planned Review/Knowledge boundaries.
- **Candidate project:** Harvey, a proprietary commercial product, as a public
  product-capability reference only.
- **Exact version/commit:** Not applicable; no source repository, version, or
  implementation is licensed to Vera.
- **License:** Proprietary; Vera has no reuse license recorded for source,
  assets, prompts, data, or non-public implementation.
- **Product fit:** Useful only for high-level capability-gap and user-value
  comparison.
- **Architecture fit:** Public concepts can inform independent planning. Its
  private architecture, implementation, APIs, prompts, and workflows are not
  Vera dependencies.
- **Security impact:** Copying or reverse engineering non-public behavior would
  create legal, provenance, and potentially security risks. Public references
  must not be used to justify fake provider or enterprise capabilities.
- **Maintenance impact:** Low when limited to occasional public capability
  review; unacceptable if treated as an implementation dependency.
- **Decision:** Use only public product information for independent capability
  comparison. Do not copy or imitate protected implementation, branding,
  assets, text, prompts, data, private APIs, or non-public workflows.
- **Reuse mode:** `reference_only`.
- **Copied/adapted files:** None.
- **Required notices:** None because nothing is incorporated. Do not use Harvey
  trademarks or branding as Vera product assets.

## 15. Legora

- **Capability:** Publicly described Matter workspace, multi-file context,
  Assistant, Tabular Review, Workflows, Word work, drafting, legal research,
  playbooks, and human-review concepts.
- **Existing Vera implementation:** Mike-derived Vera already owns the active
  product shell and independently implements Projects/Documents, Assistant,
  Tabular Review, Workflows, Source Snapshot, Citation Anchor, and Document
  Studio.
- **Candidate project:** Legora, a proprietary commercial product, as a public
  product-capability reference only.
- **Exact version/commit:** Not applicable; no source repository, version, or
  implementation is licensed to Vera.
- **License:** Proprietary; Vera has no reuse license recorded for source,
  assets, prompts, data, or non-public implementation.
- **Product fit:** Useful only for capability-gap, information-architecture,
  and user-value comparison without pixel-level imitation.
- **Architecture fit:** Public concepts may inform an independently designed
  flow. Legora code, design assets, private APIs, prompts, data models, and
  non-public workflows cannot become dependencies.
- **Security impact:** Copying, scraping, or reverse engineering protected
  material creates legal and provenance risk and can bypass Vera's controlled
  security boundaries.
- **Maintenance impact:** Low when limited to public product research;
  unacceptable if Vera tracks proprietary UI or behavior as an implementation
  specification.
- **Decision:** Reference public capabilities only. Do not copy branding,
  trademarks, screenshots, UI assets, product copy, private prompts, source,
  data, private APIs, or non-public implementation.
- **Reuse mode:** `reference_only`.
- **Copied/adapted files:** None.
- **Required notices:** None because nothing is incorporated. Do not use Legora
  trademarks or branding as Vera product assets.

## Approval rule for future changes

Before any `reference_only` or `reject` entry can become `direct`, `adapt`, or
`extract_algorithm`, the implementation commit must update this record and the
maintained provenance inventory with:

1. canonical repository and fixed commit/tag/package version;
2. retrieval date and exact upstream paths;
3. verified license identifier, license-file hash, copyright headers, and
   model/dataset terms where applicable;
4. selected Vera destination files and excluded upstream subsystems;
5. dependency, native-build, packaging, security, and maintenance review;
6. required root/package notices and retained source headers; and
7. focused and packaged validation evidence appropriate to the capability.

The provenance and notice update must land in the same commit as any approved
source or dependency import, never afterward.
