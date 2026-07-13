# UI Smoke Flow

Use this flow to verify the local Aletheia workspace UI. The committed
Playwright smoke test starts an isolated local backend and production frontend,
seeds isolated synthetic matters for desktop and mobile Chromium, opens the
workspace, searches source documents, and exercises approval-gated Feedback
Dataset and Final Memo exports. It also asserts screenshot baselines for the
initial workspace render in both viewports.

## Automated Smoke

Install the Chromium browser once:

```bash
cd frontend
npm run test:aletheia:ui:install
```

Run the smoke test:

```bash
cd frontend
npm run test:aletheia:ui
```

Update screenshot baselines intentionally after a reviewed UI change:

```bash
cd frontend
npm run test:aletheia:ui -- --update-snapshots
```

Default ports:

```text
frontend: 127.0.0.1:3410
backend:  127.0.0.1:3411
data dir: backend/.data/aletheia-ui-smoke-e2e
```

Override with:

```bash
ALETHEIA_UI_SMOKE_FRONTEND_PORT=3510 \
ALETHEIA_UI_SMOKE_BACKEND_PORT=3511 \
ALETHEIA_UI_SMOKE_DATA_DIR=/tmp/aletheia-ui-smoke \
npm run test:aletheia:ui
```

## Seed Data

```bash
cd backend
ALETHEIA_AUTH_MODE=single_user \
ALETHEIA_DATA_DIR=.data/aletheia \
ALETHEIA_UI_SMOKE_FRONTEND_URL=http://localhost:3000 \
npm run seed:aletheia:ui-smoke
```

The command prints a `matterUrl`. It creates:

- one source document;
- one source-linked evidence item;
- an Issue Map;
- an Evidence Matrix;
- a Draft Memo;
- one Matter Memory item;
- one approved Matter Playbook;
- one Agent Run Trace;
- one approved Audit Pack export.

## Run Local App

Backend:

```bash
cd backend
FRONTEND_URL=http://localhost:3000 \
ALETHEIA_AUTH_MODE=single_user \
ALETHEIA_DATA_DIR=.data/aletheia \
npm run dev
```

Frontend:

```bash
cd frontend
NEXT_PUBLIC_API_BASE_URL=http://localhost:3001 \
npm run dev
```

Open the printed `matterUrl`.

## Checks

- Page title renders `Aletheia 明证 - Agent Workspace`.
- The matter title and objective render.
- Document, Evidence, Audit Events, and Agent Runs counters are nonblank.
- Run Trace shows steps, tool calls, and human checkpoints.
- Matter Memory shows the seeded confirmed fact.
- Matter Playbooks shows an approved playbook.
- Initial workspace screenshot matches the committed desktop and mobile
  Playwright baselines.
- Work Products includes Agent Plan, Issue Map, Evidence Matrix, Draft Memo,
  and Audit Pack.
- Issue Map renders the generated issue title and a representative source
  quote.
- Issue Map accepts a claim-level review tag, shows the saved confirmation, and
  echoes the saved tag on the mapped issue card.
- Document search returns the source chunk containing the termination clause and
  shows rank, the SQLite FTS5 ranking basis, and a deterministic suggested
  issue.
- Feedback Dataset export requires approval before save.
- Final Memo export requires approval before save.
- Evidence Registry loads from the local repository and shows the smoke matter
  with its mapped source-backed claim, including query and support-status
  filters, filtered JSON download, and matter-scoped snapshot save.
- Human Review loads from the local repository and shows the saved issue review
  tag for the smoke matter, including query and tag filters plus filtered JSON
  download and matter-scoped snapshot save.
- Audit Workbench loads from the local repository, shows the smoke matter in
  matter packets, and renders live audit timeline/readiness/work product panels,
  including query and audit-action filters, filtered JSON download, and
  matter-scoped snapshot save.
- Compliance Impact Review and Deal Due Diligence template pages render as
  local workflow previews, not fixture-only workflows.
- Browser console has no app errors in the smoke flow.
- Mobile Chromium runs the same approval-gated workspace flow without sharing
  matter state with desktop Chromium.
