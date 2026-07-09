# Agent Runtime Roadmap

This roadmap keeps external agent ideas focused on Aletheia's main product line:
a governed legal agent runtime.

```text
matter context -> plan -> bounded tool loop -> evidence -> work product
-> human decision -> audit trail -> feedback / playbook improvement
```

## External Lessons To Adapt

- Hermes Agent: learning loops, skills from experience, scoped session search,
  scheduled automations, subagents, and trajectory compression are useful, but
  Aletheia should adapt them as matter-scoped memory, human-approved playbook
  proposals, bounded run traces, and feedback exports rather than global
  autonomous self-modification. Source: https://github.com/nousresearch/hermes-agent
- AgentLoop: the useful lesson is a small visible loop with bounded steps, tool
  results fed back into the model, and operator control. Aletheia should keep
  budgets, metrics, and checkpoint decisions visible in Run Trace. Sources:
  https://www.agentloop.run/ and https://github.com/mnifzied-create/agentloop
- Legora and Harvey: legal agents win when they are matter-aware execution
  systems, not generic chatbots. Their public product direction reinforces
  lawyer-readable workflows, firm playbooks, document context, audit trails,
  human checkpoints, and legal-specific tools such as review tables, citation
  verification, multi-document editing, and DMS-style organization. Sources:
  https://legora.com/product/workflows,
  https://legora.com/blog/2026-the-year-of-agents-in-legal-ai,
  https://legora.com/blog/legora-workflows-the-orchestration-layer-for-legal-work,
  https://www.harvey.ai/blog/introducing-harvey-agents
- LangGraph, OpenAI Agents SDK, CrewAI, and AutoGen: durable execution,
  checkpointing, human-in-the-loop decisions, sessions, tracing, guardrails,
  handoffs, and multi-agent message passing are the transferable ideas. AutoGen
  itself is now maintenance-oriented, so we should borrow patterns rather than
  adding it as a dependency. Sources: https://docs.langchain.com/oss/python/langgraph/overview,
  https://developers.openai.com/api/docs/guides/agents,
  https://docs.crewai.com/, https://github.com/microsoft/autogen

## Implementation Slices

1. Governed Loop Controls - started

   Persist run budgets, step metrics, tool metrics, and approval decisions
   beyond approve/reject. Show the controls in Run Trace so an operator can see
   how far the agent was allowed to go and what actually happened.

2. Resumable Checkpoints - started

   Local mode supports `resumeAgentRun(runId, checkpointId)` for edited/responded
   checkpoints. Resume appends a trace step, creates a revised Draft Memo, and
   writes an `agent_run_resumed` audit event. Supabase-backed resume
   intentionally fails closed until the production schema and policies are
   explicitly added.

3. Playbook Improvement Proposals - started

   Local mode converts reviewer feedback and review tags into draft playbook
   changes. Proposals remain separate from approved playbooks until a human
   approves the update. Supabase-backed proposals intentionally fail closed
   until the production schema and policies are explicitly added.

4. Specialist Roles - started

   The local run trace now labels bounded roles such as Evidence Mapper, Risk
   Reviewer, Memo Drafter, Export Controller, and Intake Parser. These are
   inspectable role labels with explicit allowed tool lists, not autonomous
   multi-agent delegation. Regression tests assert that trace tool calls stay
   within each role's allowlist.

5. Workflow Graph - started

   Agent runs now persist a typed `workflowGraph` in run metadata. The graph
   exposes ordered nodes, directed edges, approval-gated transitions,
   specialist roles, and allowed tools so the UI can show topology without
   adding a broad workflow builder. Local resume appends a revision branch that
   returns to human review.

## Non-Goals

- No global legal memory by default.
- No autonomous terminal, browser, email, or external web access in the default
  legal workflow.
- No agent-written playbook updates without human approval.
- No generic no-code workflow builder before the core legal workflows are
  reliable, testable, and auditable.
