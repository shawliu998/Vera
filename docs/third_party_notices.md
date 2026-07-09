# Third-Party Notices

## Base Project

Aletheia is built from an AGPL-3.0 open-source legal AI base. The original
license is retained in `LICENSE`, and attribution is recorded in
`docs/license_attribution.md`.

Because the base is AGPL-3.0, network deployments should preserve source
availability obligations for modified versions.

## Aletheia Work

Aletheia-specific additions include:

- matter workspace routes and UI;
- Aletheia database schema and migrations;
- audit pack and feedback eval exports;
- repository abstraction and local SQLite adapter;
- agent runtime schema skeleton;
- local-first deployment documentation.
- matter-scoped Matter Memory and human-approved Matter Playbooks;
- Aletheia Tool Adapter HTTP surface.

## Hermes-Inspired Design

Current Hermes references are design inspiration only:

- procedural memory maps to Matter Playbooks;
- bounded memory maps to Matter Memory;
- MCP maps to the Aletheia Tool Adapter concept;
- the current Tool Adapter is an Aletheia-native HTTP adapter, not imported
  Hermes code;
- dangerous action approval maps to high-risk professional approval gates;
- run traces map to Aletheia AgentRun, AgentStep, ToolCall, and HumanCheckpoint.

No Hermes package or source code is currently embedded in this repository.

If Hermes code is later imported or vendored, add its MIT license notice here
and document exactly which files or packages were included.
