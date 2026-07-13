# Aletheia Tool Adapter

The Aletheia Tool Adapter is a narrow, local-first tool surface for agents that
need to operate Aletheia without receiving broad automation permissions.

It is exposed in two forms:

- HTTP endpoints under `/aletheia/tool-adapter`;
- a local stdio MCP server at `backend/src/mcp/aletheiaServer.ts`.

## Manifest

```text
GET /aletheia/tool-adapter/tools
```

The manifest returns enabled tools, disabled high-risk tools, and policy flags.

Enabled tools:

- `list_matters`
- `read_matter`
- `search_matter_documents`
- `read_evidence_item`
- `create_work_product`
- `add_review_tag`
- `append_audit_event`
- `export_audit_pack`

Disabled by default:

- `browser`
- `terminal`
- `external_web_search`
- `email`
- `destructive_file_operations`

## Tool Calls

```text
POST /aletheia/tool-adapter/tools/:toolName/call
```

Request body:

```json
{
  "args": {
    "matterId": "matter-id"
  }
}
```

The adapter reuses Aletheia authentication, single-user local mode, repository
methods, schema validation, and audit behavior. It does not bypass approval
gates. For example, `export_audit_pack` returns `409 approval_required` unless
an approved human checkpoint is provided.

## Security Posture

The adapter is designed for least privilege:

- no terminal execution;
- no browser automation;
- no external web search;
- no email sending;
- no destructive file operations;
- matter IDs are explicit;
- matter memory stays matter-scoped;
- high-risk exports remain approval-gated.

## MCP Server

Run the local MCP wrapper from the backend directory:

```bash
ALETHEIA_AUTH_MODE=single_user \
ALETHEIA_DATA_DIR=.data/aletheia \
npm run mcp:aletheia
```

Example MCP client config:

```json
{
  "mcpServers": {
    "aletheia": {
      "command": "npm",
      "args": ["run", "mcp:aletheia"],
      "cwd": "/absolute/path/to/backend",
      "env": {
        "ALETHEIA_AUTH_MODE": "single_user",
        "ALETHEIA_DATA_DIR": ".data/aletheia",
        "ALETHEIA_LOCAL_USER_ID": "local-user",
        "ALETHEIA_LOCAL_USER_EMAIL": "local@aletheia.internal"
      }
    }
  }
}
```

The MCP wrapper talks directly to the Aletheia repository. It does not require
the HTTP backend to be running for local SQLite mode.
