> Historical implementation snapshot. The current P3 target contract is
> [Vera Kernel v1](./architecture/vera-kernel-v1.md). Where this document's
> fixed five-step plan, provider fallback, verification or failure language
> conflicts with that contract, the v1 contract controls implementation.

# Vera thin Agent kernel

## Implemented scope

The first Agent release adds only three persistence tables:

1. `agent_tasks` — goal, Matter, seven-state task status, deliverables, current step, and latest checkpoint.
2. `agent_steps` — ordered plan steps with five-state execution status, attempt count, expected output, and result summary.
3. `agent_artifact_links` — typed links back to existing Mike objects.

Chats, project documents, generated Word/Excel files, workflows, citations, and tabular reviews remain owned by their existing Mike data contracts. The Agent layer coordinates them; it does not duplicate them.

## API

- `POST /agent-tasks`
- `GET /agent-tasks`
- `GET /agent-tasks/:taskId`
- `POST /agent-tasks/:taskId/advance`
- `POST /agent-tasks/:taskId/retry`
- `POST /agent-tasks/:taskId/documents`
- `POST /agent-tasks/:taskId/pause`
- `POST /agent-tasks/:taskId/resume`

All endpoints require the existing Supabase JWT middleware. Task reads and state changes are limited to the task creator. Creation additionally checks existing Matter access, and every attached document must belong to that Matter.

## Execution

Each Work task is five bounded steps:

1. Read Matter documents.
2. Extract facts and contract positions.
3. Build a risk matrix.
4. Draft a review memo.
5. Verify required outputs and source boundaries.

Every running step enters Mike's existing `runLLMStream` tool loop with its existing ten-iteration ceiling, document tools, workflow tools, generated-document tools, citation handling, API-key loading, and chat persistence. Each step saves a checkpoint before the next step starts.

The deterministic controller prevents false completion:

- no source documents → `waiting_input`;
- transient 429/503/model queue → bounded retry on Gemini 3 Flash, then one Gemini 3.5 Flash fallback, then `paused` without losing completed work;
- non-transient model/tool failure → `failed` with an explicit retry action;
- missing risk matrix or review memo at verification → verification is blocked;
- a verification gap permits one repair pass and one recheck only;
- completion never implies lawyer approval; the UI remains “Ready for lawyer review.”

## Verified states

- `queued` creation through the real API and local database.
- automatic plan progression control.
- `waiting_input` when the task has no Matter documents.
- `failed` and a recovery link when Gemini is not configured.
- Matter/document ownership validation.
- supplemental Matter documents can be attached to a waiting task and execution resumes from the blocked step.
- pause/resume preserves prior steps and artifact links.
- a task left in `verifying` survives backend restart and resumes from its saved checkpoint.
- a real synthetic contract completed all five steps with Gemini: one source DOCX, 36/36 relocatable citations, a valid 10-row Excel risk matrix, a valid 7,166-character Word review memo, and a four-check PASS result that remains pending lawyer review.
- provider queue behavior was exercised: the risk-matrix step completed on attempt 3 after transient 503 responses without rerunning earlier steps.
- responsive task workspace at 1440, 1024, 760, and 390 CSS pixels with no horizontal overflow.
- keyboard traversal reaches the desktop navigation, Matter history, task breadcrumb, activity links, and artifact actions.
- frontend and backend production builds.

## Boundaries unchanged

This implementation does not change Electron privileges, Express authentication, Supabase/S3 access rules, document ownership, workflow permissions, citation storage, model-key encryption, legal disclaimers, or export approval rules. Browser roles still have no direct access to backend-owned Agent tables; only the authenticated Express backend uses the service role.
