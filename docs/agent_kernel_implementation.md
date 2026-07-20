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
- model/tool failure → `failed`;
- missing risk matrix or review memo at verification → verification is blocked;
- completion never implies lawyer approval; the UI remains “Ready for lawyer review.”

## Verified states

- `queued` creation through the real API and local database.
- automatic plan progression control.
- `waiting_input` when the task has no Matter documents.
- `failed` and a recovery link when Gemini is not configured.
- Matter/document ownership validation.
- responsive task workspace at 1280, 1024, 760, and 390 CSS pixels.
- frontend and backend production builds.

Full successful model execution requires a configured Gemini key. The local QA database was intentionally left without a provider key, so no key or model response was fabricated during verification.

## Boundaries unchanged

This implementation does not change Electron privileges, Express authentication, Supabase/S3 access rules, document ownership, workflow permissions, citation storage, model-key encryption, legal disclaimers, or export approval rules. Browser roles still have no direct access to backend-owned Agent tables; only the authenticated Express backend uses the service role.
