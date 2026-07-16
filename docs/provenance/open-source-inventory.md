# Open-Source Inventory

Date: 2026-07-16
Scope: source-level and runtime integrations relevant to legal-agent convergence

| Component | Source / version | License status | Embedded? | Classification | Notes |
| --- | --- | --- | --- | --- | --- |
| Vera repository | current repository at `12af6fc5` baseline | AGPL-3.0-only | Yes | `reuse` | Root `LICENSE` retained. |
| Open Legal Products Mike | `https://github.com/Open-Legal-Products/mike`, commit `e32daad5a4c64a5561e04c53ee12411e3c5e7238` | AGPL-3.0-only | Controlled ports | `reuse` | Exact port rules and paths are in `docs/mike_port_manifest.md`; source object and `upstream-mike` remote are present. |
| `@signalapp/sqlcipher` | npm 3.3.9 | AGPL-3.0-only per installed package metadata | Dependency | `reuse` | Provides the SQLCipher binding; linked cipher/runtime attestation remains a release gate. |
| Electron | npm 39.8.10 | MIT per installed package metadata | Dependency | `reuse` | Desktop runtime; lockfile controls exact dependency graph. |
| Next.js | npm 16.2.6 | MIT per installed package metadata | Dependency | `reuse` | Renderer/runtime framework; lockfile controls exact dependency graph. |
| Apple Vision OCR | macOS platform framework | Platform SDK terms | No copied third-party source | `reuse` | Vera-owned Swift adapter uses the operating-system framework. |
| Office.js | Microsoft hosted runtime referenced by Legacy `/office/word` | Terms review required for target distribution | Not vendored | `migrate` | Existing proof-of-concept is not the target loopback pairing/bridge. Review and record terms in the Word phase. |
| faster-whisper | Optional user/operator Python environment | Toolkit and selected model terms not yet recorded for redistribution | Not bundled by current desktop package | `isolate` | Legacy sidecar checks for an external installation. New Conversations cannot claim availability until code and model licenses are independently approved. |
| Meetily, June, FunASR, WhisperX, pyannote, LangExtract, Graphiti, Vexa | Candidate projects only | Not yet pinned/reviewed | No | `do-not-use` | Research-only until an exact provenance and license record is approved. |
| Screenpipe and unknown-license/source-available candidates | No approved source | Not approved | No | `do-not-use` | Requires explicit written authorization identifying exact scope before any import. |

No candidate voice, graph, temporal-memory, or meeting product source was copied
as part of Phase 0. npm package lockfiles are the authoritative version graph for
ordinary dependencies; the release gate must retain/distribute dependency
licenses as required.
