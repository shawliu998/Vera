# Demo Evidence

This file records the current local Aletheia demo evidence.

## Screenshots

- `docs/screenshots/aletheia-home-desktop.jpg`
- `docs/screenshots/aletheia-matter-overview-desktop.jpg`
- `docs/screenshots/aletheia-run-trace-desktop.jpg`
- `docs/screenshots/aletheia-matter-mobile.jpg`

## Release Evidence Manifest

Generate a machine-readable evidence manifest for handoff:

```bash
cd backend
ALETHEIA_RELEASE_EVIDENCE_OUT=../release-evidence.json npm run check:aletheia:evidence
```

The manifest records the current git commit, validation command list,
deployment and attribution docs, screenshot sizes and sha256 hashes, privacy
defaults, and high-risk approval posture.

## Capture Flow

1. Seed a local UI smoke matter:

   ```bash
   cd backend
   ALETHEIA_AUTH_MODE=single_user \
   ALETHEIA_DATA_DIR=/tmp/aletheia-screenshot-data \
   ALETHEIA_UI_SMOKE_FRONTEND_URL=http://127.0.0.1:3014 \
   npm run seed:aletheia:ui-smoke
   ```

2. Start backend:

   ```bash
   cd backend
   FRONTEND_URL=http://127.0.0.1:3014 \
   ALETHEIA_AUTH_MODE=single_user \
   ALETHEIA_DATA_DIR=/tmp/aletheia-screenshot-data \
   PORT=3114 \
   npm run dev
   ```

3. Build and start frontend:

   ```bash
   cd frontend
   NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:3114 npm run build
   npm run start -- -p 3014
   ```

4. Open the seeded matter URL and capture:

   - Matter Queue;
   - Local Matter Workspace;
   - Agent Run Trace;
   - Mobile Workspace.

## Verified Signals

- Page title: `Aletheia 明证 - Agent Workspace`.
- Matter title renders.
- Run Trace renders with steps, tool calls, and human checkpoints.
- Matter Memory and approved Matter Playbook render.
- Issue Map, Evidence Matrix, and Draft Memo work products are present.
- Issue Map panel renders the generated issue group and representative quote.
- Issue Map review actions can write claim-level review tags for feedback and
  audit review, then show the saved tag on the mapped issue card.
- Evidence Registry and Human Review pages render live local source evidence
  and saved review tags for the smoke matter with reviewer-facing filters and
  filtered JSON export, then save the filtered views as matter-scoped registry
  snapshots.
- Audit Workbench renders live local audit events, matter readiness, approval
  gate counts, review burden, and work products for the smoke matter with
  audit-action filtering, filtered JSON export, and a persisted audit snapshot.
- Compliance Impact Review and Deal Due Diligence template pages present local
  workflow previews aligned with the source-linked Compliance Register and Red
  Flag Memo backend paths.
- Browser console had no warning or error logs during capture.
- Mobile viewport renders the matter workspace without framework overlay.
