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
- Aletheia local SQLite schema maintained by the application runtime;
- audit pack and feedback eval exports;
- repository abstraction and local SQLite adapter;
- durable local agent runtime state;
- local-first deployment documentation.
- matter-scoped Matter Memory and human-approved Matter Playbooks;
- Aletheia Tool Adapter HTTP surface.

## SQLCipher binding

Optional encrypted database mode uses `@signalapp/sqlcipher`, version 3.3.9,
under AGPL-3.0-only. Its license is distributed in the installed package. The
adapter reports the linked SQLCipher version and provider at runtime; Aletheia
does not describe the default `node:sqlite` mode as encrypted.

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
