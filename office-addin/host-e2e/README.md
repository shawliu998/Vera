# Vera Word Add-in Mac Host E2E — 2026-07-21

This directory records a real Microsoft Word for Mac sideload attempt. Browser
evidence and Office Host evidence are kept separate; no browser result is counted
as an Office Host pass.

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

There is intentionally no 340 px Word taskpane screenshot: Word never activated
the taskpane, so creating one would mislabel browser evidence as Host evidence.

## Acceptance matrix

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

## Exact blockers and resume conditions

1. In this Word installation, activate a Microsoft 365 identity for Office Add-ins
   and confirm that tenant/device policy permits developer add-ins. Word currently
   says: `使用你的帐户登录，以使用 Office 应用商店中的外接程序。`
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
- `vera-word-host-e2e-read-only.docx` was derived with enforced WordprocessingML
  document protection for the read-only case.
- `https-backend-proxy.mjs` avoids HTTPS-to-HTTP mixed content without modifying
  the backend, frontend build configuration, API contracts, or database schema.
- ZIP integrity was checked for both DOCX files. Word itself supplied the decisive
  Chinese rendering proof; the headless LibreOffice renderer in the document QA
  workflow omitted CJK glyphs despite the text and `w:eastAsia` font metadata being
  present, so its render was not counted as a Chinese-layout pass.

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
npx tsc --noEmit                                            PASS
npm run build                                               COMPILE + TYPESCRIPT PASS;
                                                            prerender blocked by
                                                            missing Supabase URL
unzip -t editable and read-only fixtures                    PASS
Word save -> close -> reopen -> marker and Chinese present  PARTIAL HOST PASS
```

The production build reached successful compilation and finished TypeScript, then
failed while prerendering the unrelated `/account/api-keys` page with
`supabaseUrl is required`. No build configuration or unrelated page was changed.
