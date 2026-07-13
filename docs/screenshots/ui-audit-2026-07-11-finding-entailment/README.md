# Finding semantic check UI audit

## Sol verdict

**PASS.** The per-finding local semantic-support advisory is visually accepted for the tested desktop, narrow desktop, and mobile Chromium viewports. It is distinct from counsel review, preserves immutable succeeded/failed/stale history, and has no observed horizontal overflow, clipping, or header overlap.

This verdict is limited to the UI and test evidence below. It is not approval of any machine finding or counsel review.

## Screenshot evidence

| File | Viewport | State reviewed |
| --- | --- | --- |
| `01-supported-desktop-1440.png` | 1440 x 1000 | Succeeded partial machine verdict, exact per-source assessment, rationale and uncertainty, compact provenance, empty counsel assessment/reason. |
| `02-failed-history-narrow-900.png` | 900 x 1000 | Immutable failed attempt above the prior succeeded attempt; counsel controls remain independent and usable. |
| `03-stale-history-mobile-393.png` | 393 x 852 | Failed and succeeded history marked stale after counsel rejects the output review; rerun action disabled. |

Playwright measurements for all three captures reported `documentScrollWidth === viewportWidth`, horizontal overflow `0`, and header overlap `0`. At 393 px, the mobile header bottom and content scroller top both measured 94 px.

## Functional evidence

- The deterministic loopback fixture parses the current `<UNTRUSTED_EVIDENCE_JSON>` semantic prompt protocol.
- The selected litigation model is started, calibrated, and run through the accepted diagnostic benchmark before the semantic route is called.
- The backend supplies the verdict and immutable model revision, calibration, benchmark, prompt/output, finding, citation, snapshot, and review bindings.
- Refresh preserves semantic history while `agent_finding_reviews` remains empty until counsel acts.
- A strict-JSON model failure persists as a failed attempt without changing counsel inputs.
- Closing the output review makes prior checks stale and makes new semantic writes fail closed.
- Malformed finding indices and semantic writes without a current open output review fail closed.
- The visible copy states: "Model advisory, not independent verification." It also warns that the same local model may grade its own output.

## Commands and results

Run from `frontend/` unless noted:

```sh
npm run lint
# PASS

npx tsc --noEmit --pretty false
# PASS

npm run build
# PASS: Next.js production build, 17 routes

ALETHEIA_FINDING_ENTAILMENT_FIXTURE=1 \
ALETHEIA_FINDING_ENTAILMENT_FIXTURE_PORT=3413 \
ALETHEIA_LOCAL_MODEL_ID=finding-entailment-fixture \
ALETHEIA_LOCAL_MODEL_NAME=fixture-finding-entailment \
ALETHEIA_LOCAL_MODEL_ADAPTER=openai-compatible \
ALETHEIA_LOCAL_MODEL_ENDPOINT=http://127.0.0.1:3413 \
ALETHEIA_LOCAL_MODEL_REVISION=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
npx playwright test tests/aletheia-litigation-workspace.spec.ts \
  --project=desktop-chromium --project=mobile-chromium
# PASS: 18 passed in 1.1m

git diff --check -- \
  frontend/src/app/lib/aletheiaApi.ts \
  frontend/src/aletheia/litigation/LitigationWorkspace.tsx \
  frontend/tests/aletheia-litigation-workspace.spec.ts \
  docs/screenshots/ui-audit-2026-07-11-finding-entailment
# PASS
```

## Residual risks

- The loopback fixture proves protocol handling and fail-closed behavior, not the legal quality of a production local model.
- The same model can assess its own output; calibration and the diagnostic benchmark do not make that assessment independent.
- Visual evidence is Chromium on macOS only. Full provenance values are intentionally shortened in the default view and remain available under "Technical bindings."
