# Vera Word Add-in Mac Host E2E — 2026-07-21

This directory records a real Microsoft Word for Mac sideload attempt. Browser
evidence and Office Host evidence are kept separate; no browser result is counted
as an Office Host pass.

## Mac host activation diagnostic — 2026-08-07

Run `node office-addin/scripts/check-word-mac-host.mjs` from the repository root
before repeating a Mac Word sideload. The read-only diagnostic compares the
committed XML manifest with Word's `Documents/wef` registration and distinguishes
manifest discovery from AppCommands ribbon activation. A non-zero exit prints
structured issue codes rather than mutating Word or its cache.

Do not keep backups, notes, or other non-manifest files inside `Documents/wef`.
Microsoft's sideload tooling enumerates every file there and may fail while
stopping or refreshing the add-in. Store recoverable copies outside the Word
container. If `manifest_parsed_but_not_in_appcommands_cache` remains after clean
registration, close Word first and clear the complete Word add-in cache according
to Microsoft's cache-clear procedure; do not delete individual cached manifests.

## Matter version round-trip Host acceptance — 2026-07-22

This acceptance uses the existing deterministic Tabular Review Word-memo export,
not a user document. Vera downloaded the generated V1 and copied it to the new
disposable file `/tmp/vera-tabular-word-roundtrip-20260722.docx`. Word 16.111
opened that file and showed its draft notice, Matter, finding, and source-note
table. The taskpane was served from this workspace and connected to the existing
Vera session and API. No user document was opened, modified, saved, or closed.

| Check | Result |
|---|---|
| Generate and download a synthetic review memo | **Pass** — the existing Tabular Review export produced the Matter V1 used for this run. |
| Open memo in real Word Host | **Pass** — Word opened the disposable `/tmp` copy and rendered the expected memo content at 150% zoom. |
| Current taskpane and session | **Pass** — Word loaded `https://localhost:3000/office/word` from this workspace and restored the existing Vera session. |
| Explicit Matter and document target | **Pass** — the taskpane selected `Vera Synthetic License Review — Work Task QA` and `Software License Key Terms Memo - Review Memo.docx`; it showed `Current Matter version: V1` before upload. |
| Save current Word file as a new version | **Pass** — the real Host compressed-file export uploaded through the existing document-version endpoint and returned `Saved ... as V2`; the taskpane then showed V2 as current and offered V3. |
| Preserve existing version | **Pass** — after refresh, Vera displayed both Version 2 and Version 1 for the same Matter document. |
| Re-download and validate V2 | **Pass** — the downloaded V2 was 15,777 bytes, `unzip -t` reported no compressed-data errors, and its document XML retained the memo title plus both citation references. |

Real Host evidence: `screenshots/word-host-matter-v2-saved-20260722.jpeg`.
Tracked-change, comment, locate-source, save/reopen, long-document, keyboard, and
125%/150% checks remain covered by their existing Host acceptance entries; this
run specifically closes the Word-to-Matter version round-trip.

## Pending tracked change → Matter V3 Host acceptance — 2026-07-22

This follow-up used the same disposable synthetic Memo at
`/tmp/vera-tabular-word-roundtrip-20260722.docx`; no client, personal, or
confidential document was opened, changed, or uploaded. It proves that a pending
native Word revision, rather than an accepted edit or a Vera-only suggestion,
survives the Word-to-Matter version path.

| Check | Result |
|---|---|
| Precise selected-text request | **Pass** — Word supplied only `DRAFT — LAWYER REVIEW REQUIRED`; DeepSeek V4 Flash returned one replacement, `DRAFT — LAWYER REVIEW REQUIRED — ROUNDTRIP QA`, with no additional suggestion. |
| Locate before write | **Pass** — **Locate in document** selected the exact source label in Word before any document mutation. |
| Native pending revision | **Pass** — **Apply as tracked change** inserted one Word deletion and one insertion. Vera reported `Inserted as a tracked change. Review it in Word; Vera did not accept it.` |
| Explicit V2 → V3 target | **Pass** — Actions showed the exact synthetic Matter and Word target at `Current Matter version: V2`; the Host saved the file and reported `Saved … as V3`. |
| Preserve version history and uploaded bytes | **Pass** — the Matter document retained active V3 plus intact V2 and V1 rows. The re-downloaded V3 was a valid 16,805-byte DOCX; its `word/document.xml` contained exactly one `<w:del>` and one `<w:ins>` and retained both the original and replacement text. |
| Local save and reopen | **Pass** — after saving, closing only the disposable `/tmp` document, and reopening that exact path in Word 16.111, the pending red deletion/insertion markup remained visible. It was not automatically accepted. |

Real Host evidence:
`screenshots/word-host-matter-v3-saved-20260722.jpeg` records the taskpane
after V3 became current; `screenshots/word-host-matter-v3-pending-reopen-20260722.jpeg`
records the same disposable document after Word close/reopen.

## 2026-07-22 status update

The user completed the distinct Office Add-ins gallery sign-in on 2026-07-22.
After reinstalling the XML compatibility manifest, Word 16.111 activated
`Vera Word Review`; the taskpane and `Review selected text` ribbon command both
loaded. This supersedes the acquisition blocker described in the historical
2026-07-21 record below.

The real Host run then passed Vera credential sign-in, taskpane session recovery
after close/reopen, Matter loading, selected-text read, DeepSeek V4 Flash review,
saved Matter chat creation, native Word comment insertion, and native tracked
replacement. Word displayed the deletion/insertion review markup and Vera stated
that it had not accepted the change. The synthetic test used no client or
confidential content.

Implementation faults found and fixed during the run:

- Office.js host methods (`displayDialogAsync`, `messageParent`, and `onReady`)
  must retain their Office object receiver in Word for Mac.
- The HTTPS taskpane must use an HTTPS local Supabase proxy plus the real
  publishable key; the backend must retain its existing
  `USER_API_KEYS_ENCRYPTION_SECRET` to decrypt saved model keys.
- Chat persistence must omit the optional `workflow` field when a normal Word
  request has no workflow. The previous unconditional null field targeted a
  column absent from the current schema, silently dropping the user turn while
  still saving the assistant turn; the routes now fail explicitly if the user
  message cannot be saved.
- Word exact-search anchors must be at most 255 characters. Vera now asks for
  short verbatim one-paragraph anchors, rejects only an overlong item when other
  items remain valid, and never truncates or paraphrases an anchor.
- `Word.ParagraphCollection` does not expose `getItemAt` in the real Mac host.
  Long-document anchors now load the documented `items` collection, validate the
  saved paragraph text, and search only inside that paragraph before any write.
  This fixed the real-host `The Word host does not support locate` failure without
  weakening stale-anchor or ambiguous-match blocking.
- Tool-loop progress text emitted before a tool call must not become Word
  replacement text. The stream reader now keeps only the final post-tool content,
  and saved-chat recovery restores the last assistant content event.
- The global MFA gate now renders the same loader on the server and the first
  client render. This removed a recoverable React hydration error that exposed a
  Next.js development issue badge over the narrow taskpane controls.

Current Host evidence:

- `screenshots/word-host-taskpane-auth-gate-20260722.png`: activated taskpane
  before Vera authentication.
- `screenshots/word-host-vera-dialog-20260722.png`: real Word Office Dialog.
- `screenshots/word-host-deepseek-tracked-change-20260722.png`: 768 × 926 real
  Word Host result after DeepSeek generation, comment insertion, and tracked
  replacement; Word exposes the pending deletion and Vera's non-acceptance
  confirmation.
- `screenshots/word-host-review-restored-20260722.png`: real Word 16.111 result
  after closing and reopening the taskpane; Vera restored the pending suggestion
  from its existing Matter chat without changing the document.
- `screenshots/word-host-stale-anchor-rejected-20260722.png`: a moved selection
  disabled both write actions and left the document unchanged.
- `screenshots/word-host-tracked-change-applied-20260722.jpeg`: the final
  post-tool replacement was inserted as a pending native tracked change.
- `screenshots/word-host-save-reopen-restored-20260722.jpeg`: after save, close,
  and reopen, Word retained the pending insertion/deletion and comment while Vera
  restored the completed review decision.
- `screenshots/word-host-125-percent-20260722.jpeg` and
  `screenshots/word-host-150-percent-20260722.jpeg`: the real synthetic Word
  document and narrow taskpane remained readable at both required zoom levels.
  These two development captures still show Next's small `N` badge; the badge
  was subsequently disabled because it overlapped a secondary action. The clean
  authenticated completed-state recaptures listed below supersede them.
- `screenshots/word-host-60k-normal-20260722.jpeg`,
  `screenshots/word-host-60k-125-percent-20260722.jpeg`, and
  `screenshots/word-host-60k-150-percent-20260722.jpeg`: clean authenticated
  Word 16.111 captures of the completed 74k-character run after save/reopen.
  The restored Review pane shows the late English suggestion as applied while
  Word retains the pending native review markup.
- `screenshots/word-host-60k-keyboard-focus-150-percent-20260722.jpeg`: real
  Host keyboard traversal reached the main `Generate review` action at 150%; its
  blue focus indicator remains fully visible in the narrow taskpane.

A final disposable-copy confirmation run on 2026-07-22 is recorded in
`word-host-final-normal-20260722.png`,
`word-host-final-tracked-comment-20260722.png`,
`word-host-final-125-percent-20260722.png`, and
`word-host-final-150-percent-20260722.png`. It again loaded all 74,458
characters, located both late clauses, added the Chinese suggestion as a native
comment, and applied the English suggestion as an unaccepted tracked change.
`word-host-final-keyboard-focus-150-percent-20260722.png` records the 150%
keyboard traversal, but its focus outline is less legible than the earlier
`word-host-60k-keyboard-focus-150-percent-20260722.jpeg`; the earlier capture
remains the decisive keyboard evidence. The reusable fixture was not opened or
modified during this confirmation run.

Unified-package acquisition was not completed. Repository validation and the
official manifest validator accepted `manifest.json`, and a package containing
only the manifest plus its 32 px and 192 px icons passed ZIP integrity. The
Agents Toolkit login then rejected the available personal Microsoft account
because unified registration requests tenant-scoped `AppDefinitions.ReadWrite`
permission and requires a work or school identity. No authentication or tenant
boundary was bypassed. This remains a deployment-path condition and does not
invalidate the successful XML compatibility run.

## Environment

- Host: Microsoft Word for Mac 16.111 (`16.111.713.1000`), Chinese UI.
- Manifest: add-in-only XML, `office-addin/word-manifest.xml`, id
  `6bf488ac-2916-4f3e-bdc0-8d7f66e7ab2e`.
- Frontend: Next.js taskpane served over trusted localhost HTTPS on port 3000.
- API: repository backend on HTTP 3001, exposed to the HTTPS taskpane through
  `https-backend-proxy.mjs` on HTTPS 3002. The proxy uses only Node built-ins.
- Test content: synthetic DOCX files in this directory. They contain no client,
  personal, or confidential information.

The official manifest validator reported `The manifest is valid.` The taskpane URL
returned HTTP 200 over the Microsoft development certificate, and the HTTPS API
health endpoint returned `{"ok":true}`.

## Visual truth and evidence labels

The Mike visual truth remains the committed 340 x 851 reference at
`docs/screenshots/word-addin-mvp-2026-07-21/01-mike-assistant-reference-340x851.png`.
The same-size Vera screenshot at
`docs/screenshots/word-addin-mvp-2026-07-21/02-vera-browser-taskpane-340x851.png`
is browser-only evidence from the first MVP pass. It is not Word Host evidence.
Figma was not used because those saved Mike/Vera references already supplied the
required visual truth and generating another mock would not unblock the Host run.

Real Word Host evidence captured in this pass:

- `screenshots/word-host-synthetic-fixture-133pct.jpg`: Word opened the synthetic
  DOCX and visibly rendered the long Chinese paragraph at 133% zoom.
- `screenshots/word-host-addins-signin-blocked.jpg`: Word's **My Add-ins** view
  explicitly requires account sign-in and contains no installed add-ins.
- `screenshots/word-host-read-only-fixture.jpg`: Word opened the protected fixture
  with editing controls disabled, confirming the host honors the read-only fixture.
- Word accessibility state also exposed **Developer Add-ins > Vera Word Review**
  as a disabled button. The popup is a transient native surface and is not present
  in the window-only screenshot, so this fact is recorded as Host accessibility
  evidence rather than presented as a screenshot pass.

The historical pre-activation run did not produce a Word taskpane screenshot.
The 2026-07-22 captures above supersede that limitation and are real Host
evidence; browser-only 340 px reflow evidence remains labelled separately.

## 2026-07-22 successful Host acceptance

| Check | Result |
|---|---|
| XML activation, ribbon, taskpane | **Pass** — Word 16.111 loaded both command and pane. |
| Vera sign-in and taskpane reopen | **Pass** — Supabase session restored after closing/reopening the pane. |
| Matter selection | **Pass** — existing Matter list loaded through the authenticated API. |
| Read current selection | **Pass** — synthetic selected text was returned exactly. |
| Review request | **Pass** — DeepSeek V4 Flash produced a replacement and a saved Matter-chat link. |
| Review queue restore | **Pass** — closing and reopening the taskpane restored the instruction, suggestion, source link, active item, and `Skipped` disposition from the existing Matter chat plus a metadata-only local pointer. |
| Insert comment | **Pass** — native Word comment contained the suggestion and instruction; document text was unchanged. |
| Apply tracked change | **Pass** — native pending deletion/insertion appeared; Vera did not accept it. |
| Selection drift protection | **Pass** — changing the Word selection disabled Apply/Comment and a write attempt was rejected without changing text. |
| Save and reopen after mutations | **Pass** — ZIP integrity passed; `document.xml` retained native `w:ins`/`w:del`, `comments.xml` retained the Vera comment, and the marker/Chinese paragraph remained present. |
| 125% / 150% zoom | **Pass** — clean authenticated real Word Host captures show no content overflow at normal, 125%, or 150% zoom. The development badge is absent, and keyboard traversal at 150% keeps the main action's focus indicator fully visible. |
| Read-only document | **Host platform pass** — Word opened the mode-0444 synthetic copy as `只读` and disabled both Add-ins and the Vera ribbon command before the taskpane could load. The XML manifest correctly retains `ReadWriteDocument`, because editable documents need tracked changes/comments. Runtime write-error handling remains covered by bridge tests for the case where a loaded document later becomes non-writable. |
| 60k document review | **Pass** — Word loaded 74,458 characters in six paragraph-boundary sections. DeepSeek V4 Flash returned exactly the late English fee-change and Chinese processing-purpose suggestions. The English anchor accepted a native tracked replacement and the Chinese anchor accepted a native comment. After save/close/reopen, ZIP integrity passed, `document.xml` retained one `w:ins` and one `w:del`, `comments.xml` retained one comment, Vera restored both decisions, and clean normal/125%/150% plus keyboard-focus captures showed no taskpane overflow. |
| Unified manifest | **Static/package pass; acquisition externally blocked** — repository checks and the official validator accepted the 1.29 manifest, and the package ZIP contained exactly the manifest plus both required icons. Real registration requires a Microsoft 365 work/school tenant; the available personal account was rejected before authorization. The XML compatibility path remains active and fully Host-tested. |
| MFA-on-login | **Remaining** — needs an enrolled non-production test account; it is not bypassed. |

## 2026-07-21 historical acceptance matrix

| # | Check | Real Mac Word result |
|---|---|---|
| 1 | Taskpane load and authentication | **Blocked.** Word discovered `Vera Word Review` under Developer Add-ins but exposed it as disabled. **My Add-ins** required sign-in. The repository also has no usable Supabase environment, so application authentication could not proceed even if the pane opened. |
| 2 | Matter selection | **Blocked by #1 and missing authenticated API environment.** No mock Matter or auth bypass was introduced. |
| 3 | Read current selection | **Blocked by #1.** No Office.js context was available. |
| 4 | Review/rewrite request | **Blocked by #1 and missing Supabase/model credentials.** No API or security boundary was changed. |
| 5 | Selection drift protection | **Blocked by #1.** The existing browser/TypeScript path is not counted as Host proof. |
| 6 | Apply as tracked change | **Blocked by #1.** No document mutation was attempted and no final modification was auto-accepted. |
| 7 | Insert comment | **Blocked by #1.** No document mutation was attempted. |
| 8 | Read-only / low WordApi degradation | **Partial Host pass.** `vera-word-host-e2e-read-only.docx` contains enforced `w:documentProtection edit="readOnly"`; Word opened it with paste, font, and editing controls disabled. The add-in's own degradation message and a low-WordApi host remain blocked by #1. |
| 9 | Save and reopen | **Partial Host pass.** Word saved, closed, and reopened `vera-word-host-e2e-fixture.docx`; `E2E-SAVE-MARKER-2026-07-21` and the Chinese paragraph remained readable. This does not prove integrity after tracked/comment mutations because #6/#7 were blocked. |
| 10 | 340 px pane, long Chinese, keyboard focus | **Partial Host pass.** Long Chinese rendered correctly in Word at 133%. The 340 px taskpane and keyboard focus were not Host-tested because the pane did not activate. Browser-only 340 px, 125%, 150%, focus, and Chinese evidence remains in the first-pass screenshot directory. |

## Historical blockers and resume conditions

1. Diagnose why the signed-in Word 16.111 host still exposes `Vera Word Review`
   as disabled. Re-run acquisition with the unified package and keep the XML
   manifest as the compatibility path; confirm tenant/device policy permits
   developer add-ins.
2. Provide an authorized non-production Vera environment: frontend Supabase URL
   and public key, backend Supabase URL and service secret, plus the configured
   model credentials needed by the existing review/rewrite API. No credentials
   were discovered, copied, or bypassed during this run.
3. Restart Word after the manifest is present in
   `~/Library/Containers/com.microsoft.Word/Data/Documents/wef`, start the HTTPS
   services, and repeat checks 1–10. A current Microsoft Q&A report documents a
   2026 Word for Mac sideload regression with the new add-ins UI, so this host
   behavior may also require an Office update or Microsoft resolution:
   <https://learn.microsoft.com/en-us/answers/questions/5765302/word-add-in-sideload-no-longer-works-on-mac>.

The supported manual Mac sideload procedure is documented by Microsoft at
<https://learn.microsoft.com/en-us/office/dev/add-ins/testing/sideload-an-office-add-in-on-mac>.

## Fixtures and reproducibility

- `build_fixture.py` creates the editable synthetic fixture using `python-docx`.
- `build_long_fixture.py` creates the disposable 60k+ character fixture used for
  the real-Host long-document run. It keeps two leading visually empty
  paragraphs, puts the unique English fee clause after 20k characters and the
  unique Chinese processing-purpose clause after 45k characters, and fails if a
  paragraph reaches the add-in's 16k-character segmentation guardrail. It writes
  outside the repository by default:

  ```bash
  PYTHONPATH="/Users/a1-6/.cache/codex-runtimes/codex-primary-runtime/dependencies/python" \
    "/Users/a1-6/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3" \
    office-addin/host-e2e/build_long_fixture.py
  ```

  This checks DOCX ZIP integrity and prints the character count, paragraph count,
  target offsets, and longest paragraph length. It is the reproducible input
  check; the authenticated Word Host result recorded above is the acceptance
  proof.
- `vera-word-host-e2e-read-only.docx` was derived with enforced WordprocessingML
  document protection for the read-only case.
- `https-backend-proxy.mjs` avoids HTTPS-to-HTTP mixed content without modifying
  the backend, frontend build configuration, API contracts, or database schema.
- ZIP integrity was checked for both DOCX files. Word itself supplied the decisive
  Chinese rendering proof; the headless LibreOffice renderer in the document QA
  workflow omitted CJK glyphs despite the text and `w:eastAsia` font metadata being
  present, so its render was not counted as a Chinese-layout pass.

## Manual 60k Host acceptance (completed run and safe reproduction)

The 2026-07-22 Host run completed this acceptance. Any reproduction must run
against a **new copy of the synthetic fixture**, never a user document and never
the reusable fixture itself. The copy is intentionally placed outside the
repository so its native Word comments, tracked changes, and save/reopen state
cannot be confused with source material.

1. Leave the already-configured HTTPS taskpane, HTTPS API proxy, backend, and
   HTTPS Supabase proxy running. Before opening Word, confirm only availability
   (the `-k` flag is for this local diagnostic; Word still requires the trusted
   Office development certificate):

   ```bash
   curl -skS https://localhost:3000/office/word >/dev/null && \
     curl -skS https://127.0.0.1:3002/health >/dev/null && \
     curl -skS https://127.0.0.1:54322/auth/v1/health >/dev/null
   ```

2. Make the one-time synthetic copy and open **that exact copy** in Word:

   ```bash
   VERA_RUN_ID="$(date +%Y%m%d-%H%M%S)"
   VERA_FIXTURE="/tmp/vera-word-60k-host-e2e.docx"
   VERA_RUN_COPY="/tmp/vera-word-60k-host-e2e-run-${VERA_RUN_ID}.docx"
   cp -p "$VERA_FIXTURE" "$VERA_RUN_COPY"
   open -a "Microsoft Word" "$VERA_RUN_COPY"
   ```

   Do not substitute a client, personal, confidential, or previously edited
   document for `VERA_FIXTURE`; do not save over it.

3. In Word, open **Vera → Review selected text**, complete the existing Vera
   sign-in only through the Office dialog, select the test Matter, then choose
   **Whole document**. Use this narrowly scoped instruction so the run proves
   both late-document anchors rather than asking the model for an open-ended
   review:

   > Review only the fee-adjustment clause and the Chinese processing-purpose
   > clause. Require 30 days' prior written notice and a termination right for
   > the fee change; require the customer's prior written consent for the
   > processing-purpose change. Do not suggest any other changes.

4. Wait for every displayed document section to finish. The fixture must produce
   a run over text after 36,392 characters and after 48,741 characters. In the
   Review tab, confirm that the late English and Chinese suggestions each show
   their exact source text. Add a native Word comment to one of those late
   suggestions and apply the other as a **tracked** change. Do not accept the
   change in Word or through Vera.

5. Save `VERA_RUN_COPY`, close only that disposable document, reopen the same
   path, and verify the pending tracked change, the comment, and the restored
   Vera review state. Capture the taskpane plus Word markup at normal, 125%, and
   150% zoom; at each narrow taskpane size, use `Tab` to reach the main action
   and confirm its focus indicator remains visible. If generation returns no
   locatable late suggestion, or any write action is enabled after a source
   mismatch, record the failure and do not mark this acceptance row as passed.

Official tools used from temporary installs only (not added to project dependencies):

| Package | Version | License | Purpose |
|---|---:|---|---|
| `office-addin-dev-certs` | 2.0.10 | MIT | Create and trust the localhost development certificate. |
| `office-addin-manifest` | 2.1.6 | MIT | Validate the add-in-only XML manifest. |
| `office-addin-debugging` | 6.1.2 | MIT | Attempt automatic Mac registration/launch. Its registration did not complete under the local Word container privacy boundary, so the manifest was copied with Finder following Microsoft's manual procedure. |

No open-source package was added to the repository. The temporary official
debugging install required `semver` to work around a missing transitive package in
the published CLI; this did not change either lockfile.

## Validation performed

```text
office-addin-manifest validate office-addin/word-manifest.xml  PASS
npx tsc --noEmit                                             PASS
frontend npm run test:word (49)                             PASS
targeted ESLint                                              PASS
frontend npm run build                                       PASS (26 routes)
backend npm run build                                        PASS
check-manifests.mjs                                          PASS
git diff --check                                             PASS
unzip -t mutation fixture                                    PASS
Word comment + tracked change save/reopen                    REAL HOST PASS
Word 60k sectioned review                                    REAL HOST PASS
```
