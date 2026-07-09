# Safe Local Testing

Aletheia should be tested with isolated local resources.

Use separate development credentials, buckets, databases, and model keys. Do not point local experiments at production data.

Recommended local checks:

- run the deterministic `/aletheia` demo without external API keys;
- use synthetic documents for upload testing;
- run `cd backend && npm run test:aletheia:local` for the local-first
  regression covering TXT/DOCX/PDF source upload, parsing, FTS search, evidence
  mapping, evidence matrix, draft memo, Matter Memory, Matter Playbooks, run
  trace, approval gates, local export files, and the stdio MCP wrapper;
- run `cd backend && npm run test:aletheia:retrieval-eval` before retrieval
  ranking or adapter changes; it checks fail-closed policy, local-json
  semantic/hybrid retrieval, and cross-matter isolation;
- run `cd backend && npm run test:aletheia:completion` before claiming the
  local-first MVP is complete; it checks repository evidence for the requested
  product scope;
- run `cd backend && npm run seed:aletheia:ui-smoke` to create a
  screenshot-ready local matter; see `docs/ui_smoke.md`;
- keep model provider keys in local environment files only;
- never commit `.env` files or production credentials.
