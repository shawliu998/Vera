# Sol visual review: research case context

Reviewed the case-context request form at desktop and 393px narrow widths against the local litigation fixture and real local backend.

## Visual finding and decision

- The existing research rail remains the right location for request setup. Compact bordered sections, native checkboxes, and document/page hints keep the selection workflow scannable without introducing a separate card or modal.
- At 393px, labels wrap cleanly, checkbox targets remain usable, the two metadata fields fit without overflow, and the page has no horizontal scroll. At desktop, the form stays dense enough for the 260px rail while the research workspace remains visible.
- Kept the restrained gray border/type system and native form language. No context IDs, hashes, source quotes, gradients, pills, or decorative states are exposed in the request list.
- The empty procedural section points directly to “程序时钟”; the corresponding fact state points to “事实与证据”. This is more actionable than a generic empty state.

Screenshots:

- `docs/screenshots/ui-audit-2026-07-12-research-case-context/research-request-case-context-desktop.png`
- `docs/screenshots/ui-audit-2026-07-12-research-case-context/research-request-case-context-narrow-393.png`

## Integration notes

- Request creation was exercised against the local backend and persisted a v2 request with “案卷输入已绑定”. The frontend sends selected ID arrays and omits an empty category because the current route rejects an explicit empty array, despite the intended body contract allowing it.
- The current issue-tree GET router rejects v2 requests through its older request validator. The workbench falls back to the same persisted issue-tree work product already returned in matter detail, while v2 issue-tree POST and the remaining research workflow continue against the backend.
