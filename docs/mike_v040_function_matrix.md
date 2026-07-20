# Mike v0.4.0 Function Coverage Matrix

This matrix separates source parity, build coverage, and live interaction coverage. A route compiling successfully is not counted as a tested workflow.

## Status legend

- **Verified** — exercised against the local full stack.
- **UI verified** — browser interaction exercised; no authenticated backend dependency.
- **Partially verified** — the primary path was exercised, while destructive or credential-dependent branches remain.
- **Compiled** — included in the successful production build, but not yet exercised end to end.
- **Blocked** — requires a model or external service credential.

## Product surfaces

| Surface | Primary route / entry | Key interactions to preserve from Mike | Current status | Dependency / next proof |
| --- | --- | --- | --- | --- |
| Sign in | `/login` | email/password, password visibility, validation, sign-up link, legal links | Verified | Local sign-out and authenticated return to the application exercised |
| Sign up | `/signup` | account creation, validation, sign-in link | Verified | Local user, profile and organisation created against isolated Supabase |
| MFA | `/mfa` | challenge, recovery path, return to app | Compiled | Enrol test factor and complete challenge |
| Assistant home | `/assistant` | greeting, composer, document attachment, workflow picker, model picker, quick actions | Partially verified | Authenticated home, controls and Gemini 3 Flash selector exercised; generation remains credential-blocked |
| Assistant run | `/assistant/[chatId]` | streaming, stop/retry, tool status, citations, source panel, document edits, user-input pause | Compiled | Model credential required for generation; non-model controls can be tested locally |
| Projects | `/projects` | list, search, ownership filters, create, recent projects, empty/error/loading states | Partially verified | Empty state, project creation and authenticated read exercised; edit/delete and sharing remain |
| Project workspace | `/projects/[projectId]` | project context, documents, chats, tabular reviews, sharing and deletion | Partially verified | Documents, Chats and Tabular Reviews tabs exercised with retained project context |
| Library | `/library` | folders, upload, search, preview, download, delete, selection | Compiled | Local S3 upload/download/delete pass |
| Document processing | upload surfaces | progress, text extraction, DOCX/PDF conversion, failure/retry | Partially verified | Synthetic DOCX uploaded, extracted, previewed and recorded as Version 1; PDF and explicit retry UI remain |
| Tabular review list | `/tabular` | list, create, filters, status, delete | Compiled | Local CRUD pass |
| Tabular review workspace | `/tabular/[reviewId]` | add documents/columns, run cells, citations, chat, spreadsheet export | Compiled | CRUD first; model credential for generated cells |
| Workflows | `/workflows` | list, search, create, import/export, run target selection | Partially verified | Seeded Assistant/Tabular workflow catalogue and filters rendered; CRUD/import/export remain |
| Workflow editor | `/workflows/[workflowId]` | steps, prompts, inputs, ordering, save, validation, run in Assistant/Tabular | Compiled | Local workflow round trip |
| Account | `/account` | profile, model selection, provider API keys, password/security | Compiled | Verify encrypted key persistence and masked reads |
| MCP connectors | account/settings surface | connector config, OAuth return, disconnect and failure states | Compiled | External connector credentials; keep blocked until explicitly configured |
| Case law tools | Assistant source panel | query, result list, citation detail, source handoff | Compiled | CourtListener works at limited rate without optional token; live pass pending |
| Export/download | document and tabular surfaces | filename, signed URL, pending/failure/success states | Compiled | Local S3 signed URL and browser download pass |

## Cross-cutting interaction checks

| Check | Status | Acceptance evidence |
| --- | --- | --- |
| Mike v0.4.0 frontend source lock | Verified | Upstream commit `dafac6b0a449a99c4280988e22feaf160eb6fbb9` |
| Mike v0.4.0 backend source lock | Verified | Same upstream commit and successful TypeScript build |
| Vera brand overlay does not change data contracts | Verified | Only visible brand assets/copy/font layer changed before backend import |
| Production frontend compilation | Verified | Next.js production build passed |
| Backend compilation | Verified | `npm run build` passed |
| Login to sign-up navigation | UI verified | Browser navigation and return path exercised |
| Local authentication | Verified | Sign-up, profile trigger, authenticated shell and sign-out exercised against isolated Supabase |
| Local project CRUD | Partially verified | Created and read `Project Cedar — Agent UI Baseline`; update/delete intentionally remain unexercised |
| Local object storage | Partially verified | Synthetic DOCX uploaded through Supabase S3, extracted and previewed; download/delete remain |
| Long Chinese matter/document names | Pending | Browser overflow pass at desktop width breakpoints |
| Keyboard navigation and focus | Pending | Login, sidebar, composer, dialogs and tables |
| Loading/error/empty states | Pending | Network delay/error injection per surface |
| Model streaming | Blocked | Requires a valid Gemini, Anthropic or OpenAI key; no credential is stored in source |
| Ask / Work mode switch | UI verified | Work mode creates a local prototype task without weakening Ask mode's provider-key gate |
| Thin Agent task state flow | UI verified | Queued, running, verifying and completed states exercised through five short mock steps |
| Agent artifacts and verifier | UI verified | Source, risk matrix and AI draft remain visibly distinct; completion remains `Ready for lawyer review` |

## Order of execution

1. Boot the isolated Supabase stack and apply Mike's schema.
2. Generate ignored local environment files from the running stack.
3. Verify sign-up, sign-in, profile creation, project CRUD and storage without a model key.
4. Exercise all deterministic UI controls and capture key screenshots.
5. Configure a user-scoped model key only when supplied through the product UI, then verify Assistant, Tabular and Workflow generation paths.
6. Freeze the faithful Mike baseline before introducing the thin `AgentTask` / `AgentStep` / `AgentArtifactLink` layer.

## Current browser evidence

- `docs/screenshots/mike-v040-baseline/vera-login-1280x720.png` — branded Mike v0.4 login baseline.
- `docs/screenshots/mike-v040-baseline/project-document-preview-qa.png` — authenticated project workspace with extracted DOCX preview and Version 1 metadata.
- `docs/screenshots/mike-v040-baseline/agent-work-task-prototype.png` — thin Agent Work Task plan, execution, artifacts and verifier workspace.

The QA document is synthetic and explicitly contains no client, matter, personal, confidential, or privileged information.
