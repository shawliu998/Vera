import { spawn } from "node:child_process";
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { promises as dns } from "node:dns";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import path from "node:path";
import { LocalDatabase } from "./localDatabase";

export type CapabilityKind = "filesystem" | "terminal" | "network" | "plugin";

export type CapabilityExecutionContext = {
  matterId: string;
  agentId: string;
  runId: string;
};

export type FilesystemGrantScope = {
  kind: "filesystem";
  operations: Array<"read" | "write">;
  roots: string[];
};

export type TerminalGrantScope = {
  kind: "terminal";
  executablePaths: string[];
  executableHashes?: Record<string, string>;
  cwdRoots: string[];
  environmentKeys?: string[];
};

export type NetworkGrantDestination = {
  host: string;
  protocols: Array<"http:" | "https:">;
  ports: number[];
  methods: Array<"GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE">;
};

export type NetworkGrantScope = {
  kind: "network";
  destinations: NetworkGrantDestination[];
};

export type PluginGrantScope = {
  kind: "plugin";
  pluginId: string;
  action: string;
  version: string;
  sha256: string;
};

export type CapabilityGrantScope =
  | FilesystemGrantScope
  | TerminalGrantScope
  | NetworkGrantScope
  | PluginGrantScope;

export type CapabilityGrantHandle = {
  grantId: string;
  token: string;
};

export type IssueCapabilityGrantInput = CapabilityExecutionContext & {
  scope: CapabilityGrantScope;
  expiresAt: string;
  usageLimit?: number;
  singleUse?: boolean;
  issuedBy: string;
  reason: string;
};

export type CapabilityGrantSnapshot = CapabilityExecutionContext & {
  id: string;
  scope: CapabilityGrantScope;
  expiresAt: string;
  usageLimit: number;
  usageCount: number;
  issuedBy: string;
  reason: string;
  createdAt: string;
  revokedAt?: string;
  revokedBy?: string;
  revocationReason?: string;
};

export type CapabilityAuditRecord = CapabilityExecutionContext & {
  id: string;
  grantId?: string;
  sequence: number;
  event:
    | "grant.issued"
    | "grant.revoked"
    | "decision.allowed"
    | "decision.denied"
    | "use.succeeded"
    | "use.failed";
  capability: CapabilityKind;
  operation: string;
  resourceHash: string;
  details: Record<string, unknown>;
  previousHash?: string;
  eventHash: string;
  createdAt: string;
};

export type PersistentCapabilityGrantStoreOptions = {
  databasePath: string;
  auditHmacKey?: Buffer;
  auditHmacKeyPath?: string;
  auditSink?: (record: CapabilityAuditRecord) => void;
};

type StoredGrantRow = {
  id: string;
  token_hash: string;
  capability: CapabilityKind;
  matter_id: string;
  agent_id: string;
  run_id: string;
  scope_json: string;
  expires_at: string;
  usage_limit: number;
  usage_count: number;
  issued_by: string;
  reason: string;
  created_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
  revocation_reason: string | null;
};

type StoredAuditRow = {
  id: string;
  grant_id: string | null;
  sequence: number;
  event: CapabilityAuditRecord["event"];
  capability: CapabilityKind;
  operation: string;
  matter_id: string;
  agent_id: string;
  run_id: string;
  resource_hash: string;
  details_json: string;
  previous_hash: string | null;
  event_hash: string;
  created_at: string;
};

type Authorization = {
  grant: CapabilityGrantSnapshot;
  authorizationAuditId: string;
};

export type MatterFilesystemRoots = {
  readOnly?: string[];
  readWrite: string[];
};

export type RegisteredLocalPlugin = {
  id: string;
  version: string;
  sha256: string;
  actions: Record<
    string,
    (
      input: Record<string, unknown>,
      context: CapabilityExecutionContext,
      signal?: AbortSignal,
    ) => Promise<unknown>
  >;
};

export type LocalCapabilityBrokerOptions = {
  store: PersistentCapabilityGrantStore;
  resolveMatterFilesystemRoots: (matterId: string) => MatterFilesystemRoots;
  terminalExecutableAllowlist?: readonly string[];
  terminalEnvironmentAllowlist?: readonly string[];
  approvedNetworkHosts?: readonly string[];
  resolveHost?: (
    host: string,
  ) => Promise<Array<{ address: string; family: 4 | 6 }>>;
  resolvePlugin?: (pluginId: string) => RegisteredLocalPlugin | undefined;
  maxFileReadBytes?: number;
  maxFileWriteBytes?: number;
  maxTerminalInputBytes?: number;
  maxTerminalOutputBytes?: number;
  maxNetworkRequestBytes?: number;
  maxNetworkResponseBytes?: number;
};

export type TerminalExecutionRequest = {
  executable: string;
  args?: string[];
  cwd: string;
  env?: Record<string, string>;
  stdin?: Buffer | string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type TerminalExecutionResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
  durationMs: number;
};

export type NetworkExecutionRequest = {
  url: string;
  method?: NetworkGrantDestination["methods"][number];
  headers?: Record<string, string>;
  body?: Buffer | string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type NetworkExecutionResult = {
  status: number;
  headers: Record<string, string | string[]>;
  body: Buffer;
  durationMs: number;
  connectedAddress: string;
};

export class CapabilityBrokerError extends Error {
  constructor(
    message: string,
    readonly code:
      | "INVALID_GRANT"
      | "CAPABILITY_DENIED"
      | "GRANT_EXPIRED"
      | "GRANT_REVOKED"
      | "GRANT_EXHAUSTED"
      | "RESOURCE_ESCAPE"
      | "SYMLINK_DENIED"
      | "EXECUTION_TIMEOUT"
      | "EXECUTION_ABORTED"
      | "OUTPUT_LIMIT_EXCEEDED"
      | "NETWORK_DENIED"
      | "PLUGIN_MISMATCH"
      | "EXECUTION_FAILED",
  ) {
    super(message);
    this.name = "CapabilityBrokerError";
  }
}

const DEFAULT_FILE_LIMIT = 32 * 1024 * 1024;
const DEFAULT_TERMINAL_INPUT_LIMIT = 1024 * 1024;
const DEFAULT_TERMINAL_OUTPUT_LIMIT = 8 * 1024 * 1024;
const DEFAULT_NETWORK_REQUEST_LIMIT = 2 * 1024 * 1024;
const DEFAULT_NETWORK_RESPONSE_LIMIT = 16 * 1024 * 1024;
const SAFE_NETWORK_HEADERS = new Set([
  "accept",
  "accept-language",
  "content-type",
  "if-modified-since",
  "if-none-match",
  "user-agent",
]);

function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function sha256(value: Buffer | string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function hashFile(value: string): string {
  const fd = openSync(
    value,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const hash = createHash("sha256");
    while (true) {
      const chunk = Buffer.allocUnsafe(64 * 1024);
      const count = readSync(fd, chunk, 0, chunk.byteLength, null);
      if (!count) break;
      hash.update(chunk.subarray(0, count));
    }
    return `sha256:${hash.digest("hex")}`;
  } finally {
    closeSync(fd);
  }
}

function timestamp(): string {
  return new Date().toISOString();
}

function safeMessage(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 500)
    : String(error).slice(0, 500);
}

function auditFailure(error: unknown): Record<string, unknown> {
  return {
    errorCode:
      error instanceof CapabilityBrokerError ? error.code : "EXECUTION_FAILED",
    errorType: error instanceof Error ? error.name.slice(0, 100) : "unknown",
  };
}

function positiveInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new CapabilityBrokerError(
      `${name} must be between 1 and ${maximum}.`,
      "INVALID_GRANT",
    );
  }
  return value;
}

function requiredIdentifier(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200 || normalized.includes("\0")) {
    throw new CapabilityBrokerError(`${name} is invalid.`, "INVALID_GRANT");
  }
  return normalized;
}

function parseScope(value: string): CapabilityGrantScope {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || !("kind" in parsed)) {
    throw new CapabilityBrokerError(
      "Stored capability scope is invalid.",
      "INVALID_GRANT",
    );
  }
  return parsed as CapabilityGrantScope;
}

function scopeKind(scope: CapabilityGrantScope): CapabilityKind {
  return scope.kind;
}

function equalTokenHash(stored: string, token: string): boolean {
  const supplied = sha256(token);
  const left = Buffer.from(stored, "utf8");
  const right = Buffer.from(supplied, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function canonicalExistingDirectory(value: string): string {
  if (
    !path.isAbsolute(value) ||
    !existsSync(value) ||
    !statSync(value).isDirectory()
  ) {
    throw new CapabilityBrokerError(
      "Capability root must be an existing absolute directory.",
      "INVALID_GRANT",
    );
  }
  if (lstatSync(value).isSymbolicLink()) {
    throw new CapabilityBrokerError(
      "Symbolic-link roots are not allowed.",
      "SYMLINK_DENIED",
    );
  }
  return realpathSync(value);
}

function canonicalExecutable(value: string): string {
  if (
    !path.isAbsolute(value) ||
    !existsSync(value) ||
    !statSync(value).isFile()
  ) {
    throw new CapabilityBrokerError(
      "Executable must be an existing absolute file.",
      "INVALID_GRANT",
    );
  }
  if (lstatSync(value).isSymbolicLink()) {
    throw new CapabilityBrokerError(
      "Symbolic-link executables are not allowed.",
      "SYMLINK_DENIED",
    );
  }
  return realpathSync(value);
}

function normalizeHostname(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (
    !normalized ||
    normalized.includes("\0") ||
    normalized.includes("/") ||
    normalized.includes("@")
  ) {
    throw new CapabilityBrokerError(
      "Network host is invalid.",
      "INVALID_GRANT",
    );
  }
  return normalized;
}

function isLoopbackAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::1") return true;
  if (normalized.startsWith("::ffff:"))
    return isLoopbackAddress(normalized.slice(7));
  return isIP(normalized) === 4 && normalized.startsWith("127.");
}

function ipv4Number(address: string): number {
  return address
    .split(".")
    .map(Number)
    .reduce((result, item) => ((result << 8) | item) >>> 0, 0);
}

function ipv4InCidr(address: string, base: string, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4Number(address) & mask) === (ipv4Number(base) & mask);
}

function isNonPublicAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (isLoopbackAddress(normalized)) return true;
  if (normalized.startsWith("::ffff:"))
    return isNonPublicAddress(normalized.slice(7));
  if (isIP(normalized) === 4) {
    return [
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.0.0", 24],
      ["192.0.2.0", 24],
      ["192.168.0.0", 16],
      ["198.18.0.0", 15],
      ["198.51.100.0", 24],
      ["203.0.113.0", 24],
      ["224.0.0.0", 4],
      ["240.0.0.0", 4],
    ].some(([base, prefix]) =>
      ipv4InCidr(normalized, String(base), Number(prefix)),
    );
  }
  if (isIP(normalized) === 6) {
    return (
      normalized === "::" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      /^fe[89ab]/.test(normalized) ||
      normalized.startsWith("ff") ||
      normalized.startsWith("2001:db8:")
    );
  }
  return true;
}

export class PersistentCapabilityGrantStore {
  private readonly database: LocalDatabase;
  private readonly auditKey: Buffer;
  private readonly auditSink?: (record: CapabilityAuditRecord) => void;

  constructor(options: PersistentCapabilityGrantStoreOptions) {
    const databasePath = path.resolve(options.databasePath);
    mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    chmodSync(path.dirname(databasePath), 0o700);
    this.auditKey =
      options.auditHmacKey ??
      this.loadOrCreateAuditKey(
        options.auditHmacKeyPath ?? `${databasePath}.audit-key`,
      );
    if (this.auditKey.byteLength < 32) {
      throw new CapabilityBrokerError(
        "Capability audit HMAC key must contain at least 32 bytes.",
        "INVALID_GRANT",
      );
    }
    this.auditSink = options.auditSink;
    this.database = new LocalDatabase(databasePath);
    this.database.exec(
      "pragma journal_mode = delete; pragma synchronous = full; pragma foreign_keys = on; pragma busy_timeout = 5000;",
    );
    this.database.exec(`
      create table if not exists capability_grants (
        id text primary key,
        token_hash text not null,
        capability text not null,
        matter_id text not null,
        agent_id text not null,
        run_id text not null,
        scope_json text not null,
        expires_at text not null,
        usage_limit integer not null,
        usage_count integer not null default 0,
        issued_by text not null,
        reason text not null,
        created_at text not null,
        revoked_at text,
        revoked_by text,
        revocation_reason text
      );
      create index if not exists idx_capability_grants_binding
        on capability_grants(matter_id, agent_id, run_id, capability);
      create table if not exists capability_audit_events (
        id text primary key,
        grant_id text,
        sequence integer not null unique,
        event text not null,
        capability text not null,
        operation text not null,
        matter_id text not null,
        agent_id text not null,
        run_id text not null,
        resource_hash text not null,
        details_json text not null,
        previous_hash text,
        event_hash text not null,
        created_at text not null
      );
    `);
    chmodSync(databasePath, 0o600);
  }

  issueGrant(input: IssueCapabilityGrantInput): CapabilityGrantHandle {
    const context = this.validateContext(input);
    const expiresAtMs = Date.parse(input.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      throw new CapabilityBrokerError(
        "Grant expiry must be in the future.",
        "INVALID_GRANT",
      );
    }
    const usageLimit = input.singleUse
      ? 1
      : positiveInteger(input.usageLimit ?? 1, "usageLimit", 100_000);
    const issuedBy = requiredIdentifier(input.issuedBy, "issuedBy");
    const reason = input.reason.trim().slice(0, 2_000);
    if (!reason)
      throw new CapabilityBrokerError(
        "Grant reason is required.",
        "INVALID_GRANT",
      );
    const id = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const createdAt = timestamp();
    this.transaction(() => {
      this.database
        .prepare(
          `insert into capability_grants(
            id, token_hash, capability, matter_id, agent_id, run_id, scope_json,
            expires_at, usage_limit, usage_count, issued_by, reason, created_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        )
        .run(
          id,
          sha256(token),
          scopeKind(input.scope),
          context.matterId,
          context.agentId,
          context.runId,
          stableJson(input.scope),
          new Date(expiresAtMs).toISOString(),
          usageLimit,
          issuedBy,
          reason,
          createdAt,
        );
      this.appendAudit({
        grantId: id,
        context,
        event: "grant.issued",
        capability: scopeKind(input.scope),
        operation: "issue",
        resourceHash: sha256(stableJson(input.scope)),
        details: {
          expiresAt: new Date(expiresAtMs).toISOString(),
          usageLimit,
          issuedBy,
          reason,
        },
      });
    });
    return { grantId: id, token };
  }

  revokeGrant(
    grantId: string,
    revokedBy: string,
    reason: string,
  ): CapabilityGrantSnapshot {
    const revokedAt = timestamp();
    return this.transaction(() => {
      const row = this.getGrantRow(grantId);
      if (!row)
        throw new CapabilityBrokerError(
          "Capability grant was not found.",
          "INVALID_GRANT",
        );
      if (!row.revoked_at) {
        this.database
          .prepare(
            "update capability_grants set revoked_at = ?, revoked_by = ?, revocation_reason = ? where id = ?",
          )
          .run(
            revokedAt,
            requiredIdentifier(revokedBy, "revokedBy"),
            reason.trim().slice(0, 2_000),
            grantId,
          );
        this.appendAudit({
          grantId,
          context: {
            matterId: row.matter_id,
            agentId: row.agent_id,
            runId: row.run_id,
          },
          event: "grant.revoked",
          capability: row.capability,
          operation: "revoke",
          resourceHash: sha256(grantId),
          details: { revokedBy, reason: reason.trim().slice(0, 2_000) },
        });
      }
      return this.snapshot(this.getGrantRow(grantId)!);
    });
  }

  authorizeAndConsume(
    handle: CapabilityGrantHandle,
    context: CapabilityExecutionContext,
    capability: CapabilityKind,
    operation: string,
    resourceDescriptor: unknown,
    validateScope: (scope: CapabilityGrantScope) => void,
  ): Authorization {
    const normalizedContext = this.validateContext(context);
    const resourceHash = sha256(stableJson(resourceDescriptor));
    let rowForDeniedAudit: StoredGrantRow | undefined;
    try {
      return this.transaction(() => {
        const row = this.getGrantRow(handle.grantId);
        rowForDeniedAudit = row;
        if (!row || !equalTokenHash(row.token_hash, handle.token)) {
          throw new CapabilityBrokerError(
            "Capability grant credential is invalid.",
            "CAPABILITY_DENIED",
          );
        }
        if (
          row.matter_id !== normalizedContext.matterId ||
          row.agent_id !== normalizedContext.agentId ||
          row.run_id !== normalizedContext.runId
        ) {
          throw new CapabilityBrokerError(
            "Capability grant is bound to a different execution context.",
            "CAPABILITY_DENIED",
          );
        }
        if (row.capability !== capability) {
          throw new CapabilityBrokerError(
            "Capability type does not match this operation.",
            "CAPABILITY_DENIED",
          );
        }
        if (row.revoked_at)
          throw new CapabilityBrokerError(
            "Capability grant has been revoked.",
            "GRANT_REVOKED",
          );
        if (Date.parse(row.expires_at) <= Date.now()) {
          throw new CapabilityBrokerError(
            "Capability grant has expired.",
            "GRANT_EXPIRED",
          );
        }
        if (row.usage_count >= row.usage_limit) {
          throw new CapabilityBrokerError(
            "Capability grant usage limit is exhausted.",
            "GRANT_EXHAUSTED",
          );
        }
        const scope = parseScope(row.scope_json);
        validateScope(scope);
        const updated = this.database
          .prepare(
            "update capability_grants set usage_count = usage_count + 1 where id = ? and usage_count < usage_limit and revoked_at is null",
          )
          .run(row.id);
        if (Number(updated.changes) !== 1) {
          throw new CapabilityBrokerError(
            "Capability grant could not be consumed atomically.",
            "GRANT_EXHAUSTED",
          );
        }
        const audit = this.appendAudit({
          grantId: row.id,
          context: normalizedContext,
          event: "decision.allowed",
          capability,
          operation,
          resourceHash,
          details: { usage: row.usage_count + 1, usageLimit: row.usage_limit },
        });
        return {
          grant: this.snapshot({ ...row, usage_count: row.usage_count + 1 }),
          authorizationAuditId: audit.id,
        };
      });
    } catch (error) {
      const deniedContext = rowForDeniedAudit
        ? {
            matterId: rowForDeniedAudit.matter_id,
            agentId: rowForDeniedAudit.agent_id,
            runId: rowForDeniedAudit.run_id,
          }
        : normalizedContext;
      const deniedCapability = rowForDeniedAudit?.capability ?? capability;
      this.transaction(() => {
        this.appendAudit({
          grantId: handle.grantId,
          context: deniedContext,
          event: "decision.denied",
          capability: deniedCapability,
          operation,
          resourceHash,
          details: {
            reason: safeMessage(error),
            requestedContextHash: sha256(stableJson(normalizedContext)),
          },
        });
      });
      throw error;
    }
  }

  recordUse(
    authorization: Authorization,
    operation: string,
    resourceDescriptor: unknown,
    succeeded: boolean,
    details: Record<string, unknown> = {},
  ): CapabilityAuditRecord {
    return this.transaction(() =>
      this.appendAudit({
        grantId: authorization.grant.id,
        context: authorization.grant,
        event: succeeded ? "use.succeeded" : "use.failed",
        capability: authorization.grant.scope.kind,
        operation,
        resourceHash: sha256(stableJson(resourceDescriptor)),
        details: {
          authorizationAuditId: authorization.authorizationAuditId,
          ...details,
        },
      }),
    );
  }

  getGrant(grantId: string): CapabilityGrantSnapshot | undefined {
    const row = this.getGrantRow(grantId);
    return row ? this.snapshot(row) : undefined;
  }

  listAuditEvents(): CapabilityAuditRecord[] {
    return (
      this.database
        .prepare("select * from capability_audit_events order by sequence")
        .all() as StoredAuditRow[]
    ).map((row) => this.auditRecord(row));
  }

  verifyAuditIntegrity(): { ok: boolean; checked: number; error?: string } {
    const rows = this.database
      .prepare("select * from capability_audit_events order by sequence")
      .all() as StoredAuditRow[];
    let previousHash: string | undefined;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (
        row.sequence !== index + 1 ||
        (row.previous_hash ?? undefined) !== previousHash
      ) {
        return {
          ok: false,
          checked: index,
          error: `Audit chain linkage failed at sequence ${row.sequence}.`,
        };
      }
      const expected = this.auditHash({
        id: row.id,
        grantId: row.grant_id ?? undefined,
        sequence: row.sequence,
        event: row.event,
        capability: row.capability,
        operation: row.operation,
        matterId: row.matter_id,
        agentId: row.agent_id,
        runId: row.run_id,
        resourceHash: row.resource_hash,
        details: JSON.parse(row.details_json) as Record<string, unknown>,
        previousHash: row.previous_hash ?? undefined,
        createdAt: row.created_at,
      });
      if (expected !== row.event_hash) {
        return {
          ok: false,
          checked: index,
          error: `Audit event HMAC failed at sequence ${row.sequence}.`,
        };
      }
      previousHash = row.event_hash;
    }
    return { ok: true, checked: rows.length };
  }

  close(): void {
    this.database.close();
  }

  private loadOrCreateAuditKey(keyPath: string): Buffer {
    const resolved = path.resolve(keyPath);
    mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
    chmodSync(path.dirname(resolved), 0o700);
    if (!existsSync(resolved))
      writeFileSync(resolved, randomBytes(32), { mode: 0o600, flag: "wx" });
    chmodSync(resolved, 0o600);
    return readFileSync(resolved);
  }

  private validateContext(
    context: CapabilityExecutionContext,
  ): CapabilityExecutionContext {
    return {
      matterId: requiredIdentifier(context.matterId, "matterId"),
      agentId: requiredIdentifier(context.agentId, "agentId"),
      runId: requiredIdentifier(context.runId, "runId"),
    };
  }

  private transaction<T>(callback: () => T): T {
    this.database.exec("begin immediate");
    try {
      const result = callback();
      this.database.exec("commit");
      return result;
    } catch (error) {
      this.database.exec("rollback");
      throw error;
    }
  }

  private getGrantRow(grantId: string): StoredGrantRow | undefined {
    return this.database
      .prepare("select * from capability_grants where id = ?")
      .get(grantId) as StoredGrantRow | undefined;
  }

  private snapshot(row: StoredGrantRow): CapabilityGrantSnapshot {
    return {
      id: row.id,
      matterId: row.matter_id,
      agentId: row.agent_id,
      runId: row.run_id,
      scope: parseScope(row.scope_json),
      expiresAt: row.expires_at,
      usageLimit: row.usage_limit,
      usageCount: row.usage_count,
      issuedBy: row.issued_by,
      reason: row.reason,
      createdAt: row.created_at,
      revokedAt: row.revoked_at ?? undefined,
      revokedBy: row.revoked_by ?? undefined,
      revocationReason: row.revocation_reason ?? undefined,
    };
  }

  private appendAudit(input: {
    grantId?: string;
    context: CapabilityExecutionContext;
    event: CapabilityAuditRecord["event"];
    capability: CapabilityKind;
    operation: string;
    resourceHash: string;
    details: Record<string, unknown>;
  }): CapabilityAuditRecord {
    const previous = this.database
      .prepare(
        "select sequence, event_hash from capability_audit_events order by sequence desc limit 1",
      )
      .get() as { sequence: number; event_hash: string } | undefined;
    const base = {
      id: randomUUID(),
      grantId: input.grantId,
      sequence: (previous?.sequence ?? 0) + 1,
      event: input.event,
      capability: input.capability,
      operation: input.operation.slice(0, 200),
      matterId: input.context.matterId,
      agentId: input.context.agentId,
      runId: input.context.runId,
      resourceHash: input.resourceHash,
      details: input.details,
      previousHash: previous?.event_hash,
      createdAt: timestamp(),
    };
    const record: CapabilityAuditRecord = {
      ...base,
      eventHash: this.auditHash(base),
    };
    this.database
      .prepare(
        `insert into capability_audit_events(
          id, grant_id, sequence, event, capability, operation, matter_id, agent_id,
          run_id, resource_hash, details_json, previous_hash, event_hash, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.grantId ?? null,
        record.sequence,
        record.event,
        record.capability,
        record.operation,
        record.matterId,
        record.agentId,
        record.runId,
        record.resourceHash,
        stableJson(record.details),
        record.previousHash ?? null,
        record.eventHash,
        record.createdAt,
      );
    this.auditSink?.(record);
    return record;
  }

  private auditHash(value: Omit<CapabilityAuditRecord, "eventHash">): string {
    return `hmac-sha256:${createHmac("sha256", this.auditKey).update(stableJson(value)).digest("hex")}`;
  }

  private auditRecord(row: StoredAuditRow): CapabilityAuditRecord {
    return {
      id: row.id,
      grantId: row.grant_id ?? undefined,
      sequence: row.sequence,
      event: row.event,
      capability: row.capability,
      operation: row.operation,
      matterId: row.matter_id,
      agentId: row.agent_id,
      runId: row.run_id,
      resourceHash: row.resource_hash,
      details: JSON.parse(row.details_json) as Record<string, unknown>,
      previousHash: row.previous_hash ?? undefined,
      eventHash: row.event_hash,
      createdAt: row.created_at,
    };
  }
}

export class LocalCapabilityBroker {
  private readonly terminalExecutableAllowlist: Set<string>;
  private readonly terminalEnvironmentAllowlist: Set<string>;
  private readonly approvedNetworkHosts: Set<string>;
  private readonly maxFileReadBytes: number;
  private readonly maxFileWriteBytes: number;
  private readonly maxTerminalInputBytes: number;
  private readonly maxTerminalOutputBytes: number;
  private readonly maxNetworkRequestBytes: number;
  private readonly maxNetworkResponseBytes: number;

  constructor(private readonly options: LocalCapabilityBrokerOptions) {
    this.terminalExecutableAllowlist = new Set(
      (options.terminalExecutableAllowlist ?? []).map(canonicalExecutable),
    );
    this.terminalEnvironmentAllowlist = new Set(
      options.terminalEnvironmentAllowlist ?? [],
    );
    this.approvedNetworkHosts = new Set(
      (options.approvedNetworkHosts ?? []).map(normalizeHostname),
    );
    this.maxFileReadBytes = positiveInteger(
      options.maxFileReadBytes ?? DEFAULT_FILE_LIMIT,
      "maxFileReadBytes",
      1024 ** 3,
    );
    this.maxFileWriteBytes = positiveInteger(
      options.maxFileWriteBytes ?? DEFAULT_FILE_LIMIT,
      "maxFileWriteBytes",
      1024 ** 3,
    );
    this.maxTerminalInputBytes = positiveInteger(
      options.maxTerminalInputBytes ?? DEFAULT_TERMINAL_INPUT_LIMIT,
      "maxTerminalInputBytes",
      1024 ** 3,
    );
    this.maxTerminalOutputBytes = positiveInteger(
      options.maxTerminalOutputBytes ?? DEFAULT_TERMINAL_OUTPUT_LIMIT,
      "maxTerminalOutputBytes",
      1024 ** 3,
    );
    this.maxNetworkRequestBytes = positiveInteger(
      options.maxNetworkRequestBytes ?? DEFAULT_NETWORK_REQUEST_LIMIT,
      "maxNetworkRequestBytes",
      1024 ** 3,
    );
    this.maxNetworkResponseBytes = positiveInteger(
      options.maxNetworkResponseBytes ?? DEFAULT_NETWORK_RESPONSE_LIMIT,
      "maxNetworkResponseBytes",
      1024 ** 3,
    );
  }

  issueGrant(input: IssueCapabilityGrantInput): CapabilityGrantHandle {
    const normalized = {
      ...input,
      scope: this.normalizeGrantScope(input.matterId, input.scope),
    };
    return this.options.store.issueGrant(normalized);
  }

  revokeGrant(
    grantId: string,
    revokedBy: string,
    reason: string,
  ): CapabilityGrantSnapshot {
    return this.options.store.revokeGrant(grantId, revokedBy, reason);
  }

  async readFile(
    context: CapabilityExecutionContext,
    handle: CapabilityGrantHandle,
    request: { root: string; relativePath: string },
  ): Promise<Buffer> {
    const descriptor = {
      rootHash: sha256(request.root),
      relativePathHash: sha256(request.relativePath),
    };
    let resolved = { root: "", target: "" };
    const authorization = this.options.store.authorizeAndConsume(
      handle,
      context,
      "filesystem",
      "read",
      descriptor,
      (scope) => {
        const filesystem = this.requireScope(scope, "filesystem");
        if (!filesystem.operations.includes("read"))
          this.deny("Grant does not permit file reads.");
        resolved = this.resolveFilesystemTarget(
          filesystem,
          request.root,
          request.relativePath,
          false,
        );
      },
    );
    try {
      const fd = openSync(
        resolved.target,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
      );
      try {
        const stats = fstatSync(fd);
        if (!stats.isFile()) this.deny("Only regular files may be read.");
        this.verifyOpenedFile(fd, resolved.root, resolved.target);
        const result = this.readBoundedFile(fd, this.maxFileReadBytes);
        this.options.store.recordUse(authorization, "read", descriptor, true, {
          bytes: result.byteLength,
        });
        return result;
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      this.options.store.recordUse(
        authorization,
        "read",
        descriptor,
        false,
        auditFailure(error),
      );
      throw error;
    }
  }

  async writeFile(
    context: CapabilityExecutionContext,
    handle: CapabilityGrantHandle,
    request: { root: string; relativePath: string; data: Buffer | string },
  ): Promise<{ bytesWritten: number }> {
    const data = Buffer.isBuffer(request.data)
      ? request.data
      : Buffer.from(request.data, "utf8");
    if (data.byteLength > this.maxFileWriteBytes) {
      throw new CapabilityBrokerError(
        "File write exceeds the configured byte limit.",
        "OUTPUT_LIMIT_EXCEEDED",
      );
    }
    const descriptor = {
      rootHash: sha256(request.root),
      relativePathHash: sha256(request.relativePath),
      contentHash: sha256(data),
    };
    let resolved = { root: "", target: "" };
    const authorization = this.options.store.authorizeAndConsume(
      handle,
      context,
      "filesystem",
      "write",
      descriptor,
      (scope) => {
        const filesystem = this.requireScope(scope, "filesystem");
        if (!filesystem.operations.includes("write"))
          this.deny("Grant does not permit file writes.");
        resolved = this.resolveFilesystemTarget(
          filesystem,
          request.root,
          request.relativePath,
          true,
        );
      },
    );
    try {
      const fd = openSync(
        resolved.target,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_TRUNC |
          (fsConstants.O_NOFOLLOW ?? 0),
        0o600,
      );
      try {
        const stats = fstatSync(fd);
        if (!stats.isFile()) this.deny("Only regular files may be written.");
        this.verifyOpenedFile(fd, resolved.root, resolved.target);
        let offset = 0;
        while (offset < data.byteLength)
          offset += writeSync(fd, data, offset, data.byteLength - offset);
      } finally {
        closeSync(fd);
      }
      this.options.store.recordUse(authorization, "write", descriptor, true, {
        bytes: data.byteLength,
      });
      return { bytesWritten: data.byteLength };
    } catch (error) {
      this.options.store.recordUse(
        authorization,
        "write",
        descriptor,
        false,
        auditFailure(error),
      );
      throw error;
    }
  }

  async executeTerminal(
    context: CapabilityExecutionContext,
    handle: CapabilityGrantHandle,
    request: TerminalExecutionRequest,
  ): Promise<TerminalExecutionResult> {
    const executable = canonicalExecutable(request.executable);
    const args = request.args ?? [];
    const env = request.env ?? {};
    const stdin = Buffer.isBuffer(request.stdin)
      ? request.stdin
      : Buffer.from(request.stdin ?? "", "utf8");
    if (
      args.length > 128 ||
      args.some(
        (argument) => argument.includes("\0") || argument.length > 16_384,
      )
    ) {
      throw new CapabilityBrokerError(
        "Terminal arguments exceed safety limits.",
        "CAPABILITY_DENIED",
      );
    }
    if (stdin.byteLength > this.maxTerminalInputBytes) {
      throw new CapabilityBrokerError(
        "Terminal stdin exceeds the configured limit.",
        "OUTPUT_LIMIT_EXCEEDED",
      );
    }
    const descriptor = {
      executableHash: sha256(executable),
      argsHash: sha256(stableJson(args)),
      cwdHash: sha256(request.cwd),
      stdinHash: sha256(stdin),
    };
    let cwd = "";
    const authorization = this.options.store.authorizeAndConsume(
      handle,
      context,
      "terminal",
      "execute",
      descriptor,
      (scope) => {
        const terminal = this.requireScope(scope, "terminal");
        if (
          !this.terminalExecutableAllowlist.has(executable) ||
          !terminal.executablePaths.includes(executable) ||
          terminal.executableHashes?.[executable] !== hashFile(executable)
        ) {
          this.deny(
            "Executable is not allowed by operator policy, grant and artifact hash.",
          );
        }
        cwd = this.resolveTerminalCwd(terminal, request.cwd);
        for (const [key, value] of Object.entries(env)) {
          if (
            !this.terminalEnvironmentAllowlist.has(key) ||
            !(terminal.environmentKeys ?? []).includes(key) ||
            !/^[A-Z_][A-Z0-9_]*$/.test(key) ||
            value.includes("\0")
          ) {
            this.deny(`Terminal environment key '${key}' is not allowed.`);
          }
        }
      },
    );
    try {
      const result = await this.spawnTerminal(
        executable,
        args,
        cwd,
        env,
        stdin,
        request.timeoutMs,
        request.signal,
      );
      this.options.store.recordUse(authorization, "execute", descriptor, true, {
        exitCode: result.exitCode,
        signal: result.signal,
        stdoutBytes: result.stdout.byteLength,
        stderrBytes: result.stderr.byteLength,
      });
      return result;
    } catch (error) {
      this.options.store.recordUse(
        authorization,
        "execute",
        descriptor,
        false,
        auditFailure(error),
      );
      throw error;
    }
  }

  async fetchNetwork(
    context: CapabilityExecutionContext,
    handle: CapabilityGrantHandle,
    request: NetworkExecutionRequest,
  ): Promise<NetworkExecutionResult> {
    const url = this.parseNetworkUrl(request.url);
    const method = request.method ?? "GET";
    const body = Buffer.isBuffer(request.body)
      ? request.body
      : Buffer.from(request.body ?? "", "utf8");
    if (body.byteLength > this.maxNetworkRequestBytes) {
      throw new CapabilityBrokerError(
        "Network request body exceeds the configured limit.",
        "OUTPUT_LIMIT_EXCEEDED",
      );
    }
    const headers = this.validateNetworkHeaders(request.headers ?? {});
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    const host = normalizeHostname(url.hostname);
    const descriptor = {
      scheme: url.protocol,
      hostHash: sha256(host),
      port,
      method,
      pathHash: sha256(`${url.pathname}${url.search}`),
      bodyHash: sha256(body),
    };
    const authorization = this.options.store.authorizeAndConsume(
      handle,
      context,
      "network",
      method,
      descriptor,
      (scope) => {
        const network = this.requireScope(scope, "network");
        const allowed = network.destinations.some(
          (destination) =>
            destination.host === host &&
            destination.protocols.includes(
              url.protocol as "http:" | "https:",
            ) &&
            destination.ports.includes(port) &&
            destination.methods.includes(method),
        );
        if (!allowed)
          throw new CapabilityBrokerError(
            "Network destination is outside the grant.",
            "NETWORK_DENIED",
          );
      },
    );
    try {
      const address = await this.resolvePinnedAddress(host);
      const result = await this.requestPinned(
        url,
        address.address,
        address.family,
        method,
        headers,
        body,
        request,
      );
      this.options.store.recordUse(authorization, method, descriptor, true, {
        status: result.status,
        responseBytes: result.body.byteLength,
        connectedAddressHash: sha256(result.connectedAddress),
      });
      return result;
    } catch (error) {
      this.options.store.recordUse(
        authorization,
        method,
        descriptor,
        false,
        auditFailure(error),
      );
      throw error;
    }
  }

  async executePlugin(
    context: CapabilityExecutionContext,
    handle: CapabilityGrantHandle,
    request: {
      pluginId: string;
      action: string;
      input: Record<string, unknown>;
      signal?: AbortSignal;
    },
  ): Promise<unknown> {
    const plugin = this.options.resolvePlugin?.(request.pluginId);
    const descriptor = {
      pluginIdHash: sha256(request.pluginId),
      action: request.action,
      inputHash: sha256(stableJson(request.input)),
    };
    let handler: RegisteredLocalPlugin["actions"][string] | undefined;
    const authorization = this.options.store.authorizeAndConsume(
      handle,
      context,
      "plugin",
      request.action,
      descriptor,
      (scope) => {
        const pluginScope = this.requireScope(scope, "plugin");
        if (
          !plugin ||
          plugin.id !== pluginScope.pluginId ||
          plugin.version !== pluginScope.version ||
          plugin.sha256 !== pluginScope.sha256 ||
          request.pluginId !== pluginScope.pluginId ||
          request.action !== pluginScope.action
        ) {
          throw new CapabilityBrokerError(
            "Plugin identity, version, hash or action changed.",
            "PLUGIN_MISMATCH",
          );
        }
        handler = plugin.actions[request.action];
        if (!handler)
          throw new CapabilityBrokerError(
            "Plugin action is not registered.",
            "PLUGIN_MISMATCH",
          );
      },
    );
    try {
      const result = await handler!(request.input, context, request.signal);
      this.options.store.recordUse(
        authorization,
        request.action,
        descriptor,
        true,
      );
      return result;
    } catch (error) {
      this.options.store.recordUse(
        authorization,
        request.action,
        descriptor,
        false,
        auditFailure(error),
      );
      throw error;
    }
  }

  private normalizeGrantScope(
    matterId: string,
    scope: CapabilityGrantScope,
  ): CapabilityGrantScope {
    if (scope.kind === "filesystem") {
      const operations = [...new Set(scope.operations)];
      if (
        !operations.length ||
        operations.some((item) => item !== "read" && item !== "write")
      ) {
        throw new CapabilityBrokerError(
          "Filesystem grant operations are invalid.",
          "INVALID_GRANT",
        );
      }
      const matterRoots = this.canonicalMatterRoots(matterId);
      const roots = [...new Set(scope.roots.map(canonicalExistingDirectory))];
      if (!roots.length)
        throw new CapabilityBrokerError(
          "Filesystem grant requires at least one root.",
          "INVALID_GRANT",
        );
      for (const root of roots) {
        const allowedRoots = operations.includes("write")
          ? matterRoots.readWrite
          : [...matterRoots.readOnly, ...matterRoots.readWrite];
        if (!allowedRoots.some((allowed) => isContained(allowed, root))) {
          throw new CapabilityBrokerError(
            "Filesystem grant root is outside the matter roots.",
            "RESOURCE_ESCAPE",
          );
        }
      }
      return { kind: "filesystem", operations, roots };
    }
    if (scope.kind === "terminal") {
      const executables = [
        ...new Set(scope.executablePaths.map(canonicalExecutable)),
      ];
      if (
        !executables.length ||
        executables.some((item) => !this.terminalExecutableAllowlist.has(item))
      ) {
        throw new CapabilityBrokerError(
          "Terminal grant executable is not operator-approved.",
          "INVALID_GRANT",
        );
      }
      const matterRoots = this.canonicalMatterRoots(matterId);
      const cwdRoots = [
        ...new Set(scope.cwdRoots.map(canonicalExistingDirectory)),
      ];
      if (
        !cwdRoots.length ||
        cwdRoots.some(
          (root) =>
            !matterRoots.readWrite.some((allowed) =>
              isContained(allowed, root),
            ),
        )
      ) {
        throw new CapabilityBrokerError(
          "Terminal cwd root is outside writable matter roots.",
          "RESOURCE_ESCAPE",
        );
      }
      const environmentKeys = [...new Set(scope.environmentKeys ?? [])];
      if (
        environmentKeys.some(
          (key) => !this.terminalEnvironmentAllowlist.has(key),
        )
      ) {
        throw new CapabilityBrokerError(
          "Terminal grant requests an unapproved environment key.",
          "INVALID_GRANT",
        );
      }
      return {
        kind: "terminal",
        executablePaths: executables,
        executableHashes: Object.fromEntries(
          executables.map((executable) => [executable, hashFile(executable)]),
        ),
        cwdRoots,
        environmentKeys,
      };
    }
    if (scope.kind === "network") {
      if (!scope.destinations.length || scope.destinations.length > 100) {
        throw new CapabilityBrokerError(
          "Network grant destinations are invalid.",
          "INVALID_GRANT",
        );
      }
      return {
        kind: "network",
        destinations: scope.destinations.map((destination) => {
          const host = normalizeHostname(destination.host);
          if (
            !this.isLoopbackHost(host) &&
            !this.approvedNetworkHosts.has(host)
          ) {
            throw new CapabilityBrokerError(
              "Network host is not operator-approved.",
              "NETWORK_DENIED",
            );
          }
          const protocols = [...new Set(destination.protocols)];
          const ports = [...new Set(destination.ports)];
          const methods = [
            ...new Set(
              destination.methods.map(
                (method) =>
                  method.toUpperCase() as NetworkGrantDestination["methods"][number],
              ),
            ),
          ];
          if (
            !protocols.length ||
            protocols.some(
              (protocol) => protocol !== "http:" && protocol !== "https:",
            ) ||
            !ports.length ||
            ports.some(
              (port) => !Number.isInteger(port) || port < 1 || port > 65_535,
            ) ||
            !methods.length ||
            methods.some(
              (method) =>
                !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(
                  method,
                ),
            )
          ) {
            throw new CapabilityBrokerError(
              "Network destination policy is invalid.",
              "INVALID_GRANT",
            );
          }
          return { host, protocols, ports, methods };
        }),
      };
    }
    const plugin = this.options.resolvePlugin?.(scope.pluginId);
    if (
      !plugin ||
      plugin.id !== scope.pluginId ||
      plugin.version !== scope.version ||
      plugin.sha256 !== scope.sha256 ||
      !plugin.actions[scope.action] ||
      !/^sha256:[a-f0-9]{64}$/i.test(scope.sha256)
    ) {
      throw new CapabilityBrokerError(
        "Plugin grant does not match an installed plugin artifact.",
        "PLUGIN_MISMATCH",
      );
    }
    return { ...scope };
  }

  private canonicalMatterRoots(matterId: string): {
    readOnly: string[];
    readWrite: string[];
  } {
    const roots = this.options.resolveMatterFilesystemRoots(matterId);
    return {
      readOnly: [
        ...new Set((roots.readOnly ?? []).map(canonicalExistingDirectory)),
      ],
      readWrite: [...new Set(roots.readWrite.map(canonicalExistingDirectory))],
    };
  }

  private resolveFilesystemTarget(
    scope: FilesystemGrantScope,
    requestedRoot: string,
    relativePath: string,
    allowMissingLeaf: boolean,
  ): { root: string; target: string } {
    const root = canonicalExistingDirectory(requestedRoot);
    if (!scope.roots.includes(root))
      throw new CapabilityBrokerError(
        "Requested root is outside the grant.",
        "RESOURCE_ESCAPE",
      );
    if (
      !relativePath ||
      path.isAbsolute(relativePath) ||
      relativePath.includes("\0")
    ) {
      throw new CapabilityBrokerError(
        "File path must be a non-empty relative path.",
        "RESOURCE_ESCAPE",
      );
    }
    const segments = relativePath.split(/[\\/]+/);
    if (
      segments.some(
        (segment) => !segment || segment === "." || segment === "..",
      )
    ) {
      throw new CapabilityBrokerError(
        "File path traversal is not allowed.",
        "RESOURCE_ESCAPE",
      );
    }
    const target = path.resolve(root, ...segments);
    if (!isContained(root, target))
      throw new CapabilityBrokerError(
        "File path escaped its granted root.",
        "RESOURCE_ESCAPE",
      );
    let current = root;
    for (let index = 0; index < segments.length; index += 1) {
      current = path.join(current, segments[index]);
      if (!existsSync(current)) {
        if (!allowMissingLeaf || index !== segments.length - 1) {
          throw new CapabilityBrokerError(
            "File path does not exist inside the granted root.",
            "CAPABILITY_DENIED",
          );
        }
        break;
      }
      if (lstatSync(current).isSymbolicLink()) {
        throw new CapabilityBrokerError(
          "Symbolic links are not allowed in capability paths.",
          "SYMLINK_DENIED",
        );
      }
    }
    const parent = realpathSync(path.dirname(target));
    if (!isContained(root, parent))
      throw new CapabilityBrokerError(
        "File parent escaped its granted root.",
        "RESOURCE_ESCAPE",
      );
    if (existsSync(target)) {
      if (!lstatSync(target).isFile()) {
        throw new CapabilityBrokerError(
          "Capability file target must be a regular file.",
          "CAPABILITY_DENIED",
        );
      }
      if (!isContained(root, realpathSync(target))) {
        throw new CapabilityBrokerError(
          "File target escaped its granted root.",
          "RESOURCE_ESCAPE",
        );
      }
    }
    return { root, target };
  }

  private verifyOpenedFile(fd: number, root: string, target: string): void {
    const opened = fstatSync(fd);
    const current = statSync(target);
    if (
      !isContained(root, realpathSync(target)) ||
      opened.dev !== current.dev ||
      opened.ino !== current.ino ||
      opened.nlink !== 1
    ) {
      throw new CapabilityBrokerError(
        "Opened file descriptor escaped, changed, or is hard-linked outside its granted root.",
        "RESOURCE_ESCAPE",
      );
    }
  }

  private resolveTerminalCwd(
    scope: TerminalGrantScope,
    requestedCwd: string,
  ): string {
    const cwd = canonicalExistingDirectory(requestedCwd);
    if (!scope.cwdRoots.some((root) => isContained(root, cwd))) {
      throw new CapabilityBrokerError(
        "Terminal cwd is outside its granted roots.",
        "RESOURCE_ESCAPE",
      );
    }
    return cwd;
  }

  private readBoundedFile(fd: number, maximum: number): Buffer {
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(
        Math.min(64 * 1024, maximum - total + 1),
      );
      const count = readSync(fd, chunk, 0, chunk.byteLength, null);
      if (!count) break;
      total += count;
      if (total > maximum)
        throw new CapabilityBrokerError(
          "File exceeds the read limit.",
          "OUTPUT_LIMIT_EXCEEDED",
        );
      chunks.push(chunk.subarray(0, count));
    }
    return Buffer.concat(chunks, total);
  }

  private spawnTerminal(
    executable: string,
    args: string[],
    cwd: string,
    configuredEnv: Record<string, string>,
    stdin: Buffer,
    requestedTimeoutMs?: number,
    callerSignal?: AbortSignal,
  ): Promise<TerminalExecutionResult> {
    const timeoutMs = positiveInteger(
      requestedTimeoutMs ?? 60_000,
      "terminal timeout",
      15 * 60_000,
    );
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      const environment = [
        "LANG",
        "LC_ALL",
        "TMPDIR",
      ].reduce<NodeJS.ProcessEnv>((result, key) => {
        if (process.env[key] !== undefined) result[key] = process.env[key];
        return result;
      }, {});
      Object.assign(environment, configuredEnv);
      const child = spawn(executable, args, {
        cwd,
        env: environment,
        shell: false,
        detached: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      let failure: CapabilityBrokerError | undefined;
      const terminate = (error: CapabilityBrokerError) => {
        failure ??= error;
        child.kill("SIGTERM");
        const killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
        killTimer.unref();
      };
      const collect = (destination: Buffer[], chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > this.maxTerminalOutputBytes) {
          terminate(
            new CapabilityBrokerError(
              "Terminal output exceeded its limit.",
              "OUTPUT_LIMIT_EXCEEDED",
            ),
          );
          return;
        }
        destination.push(Buffer.from(chunk));
      };
      child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
      child.once("error", (error) => {
        failure ??= new CapabilityBrokerError(
          safeMessage(error),
          "EXECUTION_FAILED",
        );
      });
      const timeout = setTimeout(
        () =>
          terminate(
            new CapabilityBrokerError(
              "Terminal execution timed out.",
              "EXECUTION_TIMEOUT",
            ),
          ),
        timeoutMs,
      );
      timeout.unref();
      const abort = () =>
        terminate(
          new CapabilityBrokerError(
            "Terminal execution was cancelled.",
            "EXECUTION_ABORTED",
          ),
        );
      callerSignal?.addEventListener("abort", abort, { once: true });
      if (callerSignal?.aborted) abort();
      child.once("close", (exitCode, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        callerSignal?.removeEventListener("abort", abort);
        if (failure) reject(failure);
        else
          resolve({
            exitCode,
            signal,
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderr),
            durationMs: Date.now() - startedAt,
          });
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(stdin);
    });
  }

  private parseNetworkUrl(value: string): URL {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new CapabilityBrokerError(
        "Network URL is invalid.",
        "NETWORK_DENIED",
      );
    }
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.hash
    ) {
      throw new CapabilityBrokerError(
        "Network URL scheme, credentials or fragment is not allowed.",
        "NETWORK_DENIED",
      );
    }
    return url;
  }

  private validateNetworkHeaders(
    headers: Record<string, string>,
  ): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [rawKey, value] of Object.entries(headers)) {
      const key = rawKey.toLowerCase();
      if (
        !SAFE_NETWORK_HEADERS.has(key) ||
        value.includes("\r") ||
        value.includes("\n") ||
        value.length > 8_192
      ) {
        throw new CapabilityBrokerError(
          `Network header '${rawKey}' is not allowed.`,
          "NETWORK_DENIED",
        );
      }
      result[key] = value;
    }
    return result;
  }

  private isLoopbackHost(host: string): boolean {
    return host === "localhost" || isLoopbackAddress(host);
  }

  private async resolvePinnedAddress(
    host: string,
  ): Promise<{ address: string; family: 4 | 6 }> {
    const literalFamily = isIP(host);
    const addresses = literalFamily
      ? [{ address: host, family: literalFamily as 4 | 6 }]
      : this.options.resolveHost
        ? await this.options.resolveHost(host)
        : await dns.lookup(host, { all: true, verbatim: true });
    if (!addresses.length)
      throw new CapabilityBrokerError(
        "Network host did not resolve.",
        "NETWORK_DENIED",
      );
    if (this.isLoopbackHost(host)) {
      if (addresses.some((entry) => !isLoopbackAddress(entry.address))) {
        throw new CapabilityBrokerError(
          "Loopback hostname resolved outside loopback.",
          "NETWORK_DENIED",
        );
      }
    } else if (literalFamily) {
      if (isNonPublicAddress(host) && !this.approvedNetworkHosts.has(host)) {
        throw new CapabilityBrokerError(
          "Private address is not explicitly approved.",
          "NETWORK_DENIED",
        );
      }
    } else if (addresses.some((entry) => isNonPublicAddress(entry.address))) {
      throw new CapabilityBrokerError(
        "Approved hostname resolved to a non-public address.",
        "NETWORK_DENIED",
      );
    }
    return addresses[0] as { address: string; family: 4 | 6 };
  }

  private requestPinned(
    url: URL,
    address: string,
    family: 4 | 6,
    method: NetworkGrantDestination["methods"][number],
    headers: Record<string, string>,
    body: Buffer,
    source: NetworkExecutionRequest,
  ): Promise<NetworkExecutionResult> {
    const startedAt = Date.now();
    const timeoutMs = positiveInteger(
      source.timeoutMs ?? 30_000,
      "network timeout",
      5 * 60_000,
    );
    return new Promise((resolve, reject) => {
      let settled = false;
      let totalTimer: NodeJS.Timeout | undefined;
      const finishReject = (error: unknown) => {
        if (settled) return;
        settled = true;
        if (totalTimer) clearTimeout(totalTimer);
        reject(error);
      };
      const client = url.protocol === "https:" ? https : http;
      const request = client.request(
        {
          protocol: url.protocol,
          hostname: address,
          family,
          port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
          path: `${url.pathname}${url.search}`,
          method,
          headers: {
            ...headers,
            host: url.host,
            ...(body.byteLength
              ? { "content-length": String(body.byteLength) }
              : {}),
          },
          servername: isIP(normalizeHostname(url.hostname))
            ? undefined
            : normalizeHostname(url.hostname),
        },
        (response) => {
          if (
            (response.statusCode ?? 0) >= 300 &&
            (response.statusCode ?? 0) < 400
          ) {
            response.resume();
            finishReject(
              new CapabilityBrokerError(
                "Network redirects are not allowed.",
                "NETWORK_DENIED",
              ),
            );
            request.destroy();
            return;
          }
          const contentLength = Number(
            response.headers["content-length"] ?? "0",
          );
          if (
            Number.isFinite(contentLength) &&
            contentLength > this.maxNetworkResponseBytes
          ) {
            response.resume();
            finishReject(
              new CapabilityBrokerError(
                "Network response exceeded the configured limit.",
                "OUTPUT_LIMIT_EXCEEDED",
              ),
            );
            request.destroy();
            return;
          }
          const chunks: Buffer[] = [];
          let total = 0;
          response.on("data", (chunk: Buffer) => {
            total += chunk.byteLength;
            if (total > this.maxNetworkResponseBytes) {
              finishReject(
                new CapabilityBrokerError(
                  "Network response exceeded the configured limit.",
                  "OUTPUT_LIMIT_EXCEEDED",
                ),
              );
              request.destroy();
              response.destroy();
              return;
            }
            chunks.push(Buffer.from(chunk));
          });
          response.once("end", () => {
            if (settled) return;
            settled = true;
            if (totalTimer) clearTimeout(totalTimer);
            const normalizedHeaders: Record<string, string | string[]> = {};
            for (const [key, value] of Object.entries(response.headers)) {
              if (typeof value === "string" || Array.isArray(value))
                normalizedHeaders[key] = value;
            }
            resolve({
              status: response.statusCode ?? 0,
              headers: normalizedHeaders,
              body: Buffer.concat(chunks, total),
              durationMs: Date.now() - startedAt,
              connectedAddress: address,
            });
          });
        },
      );
      const timeout = () => {
        finishReject(
          new CapabilityBrokerError(
            "Network request timed out.",
            "EXECUTION_TIMEOUT",
          ),
        );
        request.destroy();
      };
      totalTimer = setTimeout(timeout, timeoutMs);
      totalTimer.unref();
      request.once("error", (error) => {
        if (!settled)
          finishReject(
            new CapabilityBrokerError(safeMessage(error), "EXECUTION_FAILED"),
          );
      });
      const abort = () => {
        finishReject(
          new CapabilityBrokerError(
            "Network request was cancelled.",
            "EXECUTION_ABORTED",
          ),
        );
        request.destroy();
      };
      source.signal?.addEventListener("abort", abort, { once: true });
      request.once("close", () =>
        source.signal?.removeEventListener("abort", abort),
      );
      if (source.signal?.aborted) abort();
      if (body.byteLength) request.write(body);
      request.end();
    });
  }

  private requireScope<T extends CapabilityKind>(
    scope: CapabilityGrantScope,
    expected: T,
  ): Extract<CapabilityGrantScope, { kind: T }> {
    if (scope.kind !== expected)
      this.deny("Capability grant scope has the wrong type.");
    return scope as Extract<CapabilityGrantScope, { kind: T }>;
  }

  private deny(message: string): never {
    throw new CapabilityBrokerError(message, "CAPABILITY_DENIED");
  }
}
