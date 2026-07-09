# Aletheia V1 Risk Register

Updated: 2026-07-09

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Schema drift across feature windows | High | Architecture owns shared V1 contracts before feature work expands. |
| Feature windows launch before Architecture / Contracts baseline | High | Treat Architecture / Contracts as a hard launch gate; feature windows may only do discovery/planning until shared schemas, fixtures, boundaries, and status schema are published. |
| README/docs overclaim production readiness | High | Deployment docs must mark V1 as private pilot and distinguish working/partial/planned. |
| Broken local-first privacy boundary | High | External model calls remain off by default and logged when enabled. |
| OCR/table parsing unreliable | Medium | Mark `needs_ocr`, add adapter boundaries, document limitations. |
| Model output unreliable | High | Schema guards, deterministic defaults, repair/retry, human review. |
| Final export bypasses gates | Critical | Gate Engine and Export owners must preserve fail-closed final export. |
| Unsafe final legal advice language | Critical | Product copy must say expert-support system, not replacement advice. |
| Large refactors destabilize P0 | Medium | Prefer additive V1 modules and integration glue. |
| UI smoke/test instability | Medium | Keep deterministic fixtures and isolate V1 tests where practical. |
| Parallel windows edit same files | High | Supervisor assigns ownership and stops conflicting edits. |
