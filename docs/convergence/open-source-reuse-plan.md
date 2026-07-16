# Vera Legal Matter Agent Convergence — Open-Source Reuse Plan

> Registry notice (2026-07-16): this policy remains applicable, while the
> capability-by-capability canonical decisions required for the revised plan
> are recorded in `docs/reuse_decisions.md`. Source provenance continues to
> live under `docs/provenance/`.

Date: 2026-07-16
Status: Phase 0 approval policy

## 1. Rule

No candidate repository, file, dependency, model, weight, dataset, icon, text,
or visual asset enters active Vera code until its exact source, fixed commit or
version, license, copyright notice, dependency impact, and intended modification
are recorded under `docs/provenance/` and reflected in
`THIRD_PARTY_NOTICES.md` when required.

Product ideas may be studied without copying closed-source implementation,
branding, icons, copy, screenshots, or proprietary visual assets.

## 2. Approved current source reuse

| Source | Pin | License | Status | Scope |
| --- | --- | --- | --- | --- |
| Open Legal Products Mike | `e32daad5a4c64a5561e04c53ee12411e3c5e7238` | AGPL-3.0-only | `reuse` / approved | Controlled UI, wire-shape, and workflow ports listed in `docs/mike_port_manifest.md`; per-file provenance comments retained. |
| `@signalapp/sqlcipher` | npm 3.3.9 | AGPL-3.0-only | `reuse` / approved | SQLCipher Node binding; package license distributed with installed dependency. |

Mike remains pinned. New Mike code is read only from a reviewed fixed SHA, never
floating `main`, and receives a manifest entry before landing.

## 3. Candidate research matrix

These entries are not approved for copying. Until a file-and-model review is
recorded, their status is `do-not-use` for source import and `research-only` for
architecture study.

| Candidate | Possible bounded use | Required review before approval |
| --- | --- | --- |
| Meetily | Rust device/system-audio capture, recovery, model loading | Repository and file license, transitive crates, platform capture APIs, notices, fixed commit. Do not copy its UI, database, summarizer, or updater. |
| June | saved-audio-first, dual-source recording, crash recovery patterns | Exact source repository/edition, license, third-party capture code, model terms, fixed commit. Pattern study does not authorize code copying. |
| FunASR | Chinese ASR, VAD, punctuation, hotwords, speaker models | Toolkit license plus every selected model/weight/dataset license and redistribution terms. |
| WhisperX | alignment and word timestamps | Code pin/license, dependencies, selected Whisper/alignment model licenses, redistribution and platform packaging. |
| pyannote | diarization | Code license is insufficient: model access terms, gated weights, training data restrictions, and redistribution must be reviewed separately. |
| LangExtract | structured extraction and source alignment | Pin, license, dependencies, attribution, and whether its source-location model fits immutable Vera anchors. |
| Graphiti | temporal/supersession design | Design reference only for MVP. No server or graph database is introduced. Any future code reuse needs separate approval. |
| Vexa | meeting-to-knowledge compilation pattern | Product/architecture study only pending exact repository/file/license review. |

Screenpipe or other source-available/commercial code is `do-not-use` absent
written authorization that identifies the exact version, files, permitted use,
redistribution conditions, and notice obligations.

## 4. Competitive-product boundary

Legora, Harvey, and other proprietary products are references for information
architecture and workflow concepts only. Vera does not copy their implementation,
trademarks, icons, product copy, private APIs, screenshots, or proprietary visual
system. Public product behavior can inform an independently designed flow.

## 5. Reuse approval record

Before a reuse commit, add a provenance record containing:

```text
project and canonical repository URL
fixed commit/tag/package version
retrieval date
upstream file paths
license identifier and license-file hash
copyright headers/notices
selected Vera destination files
why reuse is preferable
excluded upstream subsystems
local modifications
transitive native/runtime dependencies
model/weight/dataset license review, if applicable
security review and test evidence
```

Copied files retain copyright headers. Required license text and notices ship in
source and packaged distributions. Unknown or conflicting license terms block
the import; “research use” is not treated as a waiver.

## 6. Voice-specific gate

Capture code and AI models are separate approvals. A permissively licensed ASR
toolkit does not establish that a model weight or its training/redistribution
terms are usable. The capture-runtime phase must therefore land in this order:

1. provenance and license decision;
2. minimal source import with notices;
3. native build and sandbox review;
4. saved-audio durability/recovery tests;
5. separately approved model adapter;
6. separately documented optional model installation.

No external project contributes Matter logic, provider credentials, legal
strategy, Artifact/Review state, or a second persistence layer.

## 7. Word and hosted scripts

The current Legacy Office.js proof-of-concept loads Microsoft's hosted Office.js
runtime. It is `migrate`, not an approved Word Local Bridge implementation. The
Word phase must review Microsoft Add-in terms, origin/CSP behavior, manifest
requirements, and distribution constraints and then record the exact runtime
dependency. Provider credentials and local paths never enter the Add-in.

## 8. Inventory maintenance

`docs/provenance/open-source-inventory.md` is the source-level inventory for
this convergence. npm lockfiles remain the authoritative package/version graph;
package license metadata and distributed license files are reviewed during the
release gate. Any reuse change updates the inventory and root notice in the same
commit as the imported source, never afterward.
