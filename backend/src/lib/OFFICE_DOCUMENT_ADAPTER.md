# OfficeDocumentAdapter feasibility boundary

Status: isolated feasibility prototype, not production enabled. It does not replace the Vera Word Add-in or Document Studio and is not wired to an API route.

## Upstream and license record

- Official repository: <https://github.com/iOfficeAI/OfficeCLI>
- Pinned release: [`v1.0.139`](https://github.com/iOfficeAI/OfficeCLI/releases/tag/v1.0.139), published 2026-07-19; tag commit `0b3557bbec29f073f5df6b92b4b8dcefa7e3c160`.
- License: [Apache-2.0](https://github.com/iOfficeAI/OfficeCLI/blob/v1.0.139/LICENSE).
- Upstream [NOTICE](https://github.com/iOfficeAI/OfficeCLI/blob/v1.0.139/NOTICE) identifies OfficeCLI copyright 2026, created and maintained by goworm, and requires retention of the notice when redistributed under Apache License section 4.
- This repository neither copies upstream implementation code nor redistributes a binary. The adapter invokes a separately provisioned executable. If Vera later redistributes OfficeCLI, legal review must preserve LICENSE, NOTICE, and applicable third-party notices.

The optional macOS arm64 binary used for the integration smoke was downloaded from the official v1.0.139 GitHub release to a private temporary directory and was not committed:

| Asset | Version | SHA-256 | Size |
| --- | --- | --- | ---: |
| `officecli-mac-arm64` | `1.0.139` | `393874f79db58222bdbede7f4f942f2536580386923857d1b5ad9754efe80c19` | 33,641,808 bytes |

`officeDocumentAdapter.ts` also records the official v1.0.139 checksums for the supported macOS, Linux, and Windows release assets. Alpine assets are not selected automatically. There is no downloader or updater.

## Prototype contract

The adapter exposes only four document operations:

1. inspect `.docx` or `.xlsx` text;
2. create `.docx` from a `.docx` placeholder template;
3. create a blank `.xlsx`;
4. render page 1 to PNG and validate `.docx` or `.xlsx`.

Safety properties are enforced in the adapter rather than delegated to OfficeCLI:

- the executable path is explicit, must be a regular executable file, and must match the pinned version and SHA-256;
- command construction is private and restricted to `create`, `merge`, `validate`, and `view`; `shell` is disabled;
- each invocation uses a private temporary working directory and isolated HOME/XDG directories;
- `OFFICECLI_SKIP_UPDATE=1`, `OFFICECLI_NO_AUTO_INSTALL=1`, and `OFFICECLI_NO_AUTO_RESIDENT=1` are mandatory child-process environment values;
- all inputs, including inspect/validate inputs, are copied before OfficeCLI sees them;
- generated files remain temporary until OOXML/PNG structure and OfficeCLI validation pass, then publish with exclusive-create semantics;
- existing outputs and source paths are rejected, so the adapter never intentionally overwrites an original;
- commands have bounded output capture and a hard timeout (45 seconds by default, 120 seconds maximum).

The generated `OfficeDocumentVersionCandidate` is deliberately a storage-neutral handoff. The caller must upload it through the existing generated-document path and create the existing `document_versions` row. After that existing path returns a document id, `toArtifactLink()` produces the existing `AgentArtifactLinkInput` for `agent_artifact_links`. The adapter does not access the database and adds no table, route, permission, or persistence model.

## Upstream risks checked

The open upstream issues materially constrain this prototype:

- [#231: read-only commands can modify files](https://github.com/iOfficeAI/OfficeCLI/issues/231) — all reads operate on copies and the source hash is checked afterward.
- [#244: XLSX batch writes can be non-atomic](https://github.com/iOfficeAI/OfficeCLI/issues/244) — no batch or in-place mutation is allowlisted; publish occurs only from a temp output.
- [#243: `validate` can miss an Excel-corrupting relationship](https://github.com/iOfficeAI/OfficeCLI/issues/243) — validation is not treated as proof; required OOXML parts are checked separately.
- [#246: Excel screenshots can omit or clip floating charts](https://github.com/iOfficeAI/OfficeCLI/issues/246) and [#249: rotated merged-cell text can render incorrectly](https://github.com/iOfficeAI/OfficeCLI/issues/249) — PNG output is a preview, not an authoritative Microsoft Office rendering.
- [#181: headless screenshot may hang on external resources](https://github.com/iOfficeAI/OfficeCLI/issues/181) — the adapter applies a hard timeout and callers must handle render failure.
- [#250: documented SDK quick starts reference missing APIs](https://github.com/iOfficeAI/OfficeCLI/issues/250) — the prototype does not use or copy the SDK.

## Verification and production-disabled functions

`backend/scripts/officeDocumentAdapterSmoke.ts` covers binary absent, command failure, corrupt output, successful inspect/create Word/create Excel/render/validate, input mutation isolation, exclusive output, and existing ArtifactLink shape. Set `OFFICECLI_INTEGRATION_BINARY` to run the same paths against the pinned official binary; otherwise it uses disposable fake executables and creates no binary fixture.

On the 2026-07-21 macOS arm64 feasibility run, the official v1.0.139 binary passed all of those integration paths with an explicit 120-second command cap. The first cold, fully isolated HTML render exceeded the 45-second default and was terminated; the bounded 120-second run then passed. This is evidence that timeout handling works, not evidence that rendering has production latency or reliability.

This is still not production-ready:

- no route or job owns authorization, Matter membership, storage upload, or the final `DocumentVersion` transaction;
- the OOXML check is deliberately shallow and cannot prove Microsoft Word/Excel compatibility or detect every semantic corruption;
- HTML screenshots are not Word/Excel layout truth, may omit unsupported features, and can time out;
- Word creation only merges a caller-supplied `.docx` template; Excel creation is blank; formulas, charts, complex styles, comments, tracked changes, and macros are outside the prototype;
- there is no OS/container sandbox around the third-party process beyond its restricted environment, working directory, command allowlist, copy-on-write inputs, and timeout;
- no automated binary acquisition, update, rollback, vulnerability response, or cross-platform host acceptance exists;
- Word Host E2E remains separately blocked at Microsoft 365 login and was not retried for this work.
