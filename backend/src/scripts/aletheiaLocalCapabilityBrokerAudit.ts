import assert from "node:assert/strict";
import { once } from "node:events";
import {
  chmodSync,
  copyFileSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CapabilityBrokerError,
  LocalCapabilityBroker,
  PersistentCapabilityGrantStore,
  type CapabilityExecutionContext,
  type CapabilityGrantScope,
  type RegisteredLocalPlugin,
} from "../lib/aletheia/localCapabilityBroker";

const context: CapabilityExecutionContext = {
  matterId: "matter-a",
  agentId: "agent-a",
  runId: "run-a",
};

function expectCode(
  code: CapabilityBrokerError["code"],
): (error: unknown) => boolean {
  return (error: unknown): boolean =>
    error instanceof CapabilityBrokerError && error.code === code;
}

function futureExpiry(milliseconds = 60_000): string {
  return new Date(Date.now() + milliseconds).toISOString();
}

async function main(): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "aletheia-capability-audit-"));
  chmodSync(root, 0o700);
  const matterA = path.join(root, "matter-a");
  const matterB = path.join(root, "matter-b");
  const outside = path.join(root, "outside");
  for (const directory of [matterA, matterB, outside])
    mkdirSync(directory, { mode: 0o700 });
  writeFileSync(path.join(matterA, "inside.txt"), "inside", { mode: 0o600 });
  writeFileSync(path.join(outside, "secret.txt"), "outside-secret", {
    mode: 0o600,
  });
  symlinkSync(
    path.join(outside, "secret.txt"),
    path.join(matterA, "escape-link"),
  );
  linkSync(
    path.join(outside, "secret.txt"),
    path.join(matterA, "escape-hardlink"),
  );

  const server = createServer((request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "http://example.com/cloud" });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("local-network-ok");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Audit HTTP server did not bind.");
  const port = address.port;

  const databasePath = path.join(root, "capabilities.db");
  const store = new PersistentCapabilityGrantStore({ databasePath });
  const echoExecutable = "/bin/echo";
  assert.equal(
    lstatSync(echoExecutable).isSymbolicLink(),
    false,
    "audit requires a non-symlink /bin/echo",
  );
  const mutableExecutable = path.join(root, "mutable-echo");
  copyFileSync(echoExecutable, mutableExecutable);
  chmodSync(mutableExecutable, 0o700);
  const pluginHash = `sha256:${"a".repeat(64)}`;
  let plugin: RegisteredLocalPlugin = {
    id: "local.redactor",
    version: "1.0.0",
    sha256: pluginHash,
    actions: {
      redact: async (input) => ({
        redacted: String(input.text ?? "").replace(/secret/gi, "[redacted]"),
      }),
    },
  };
  const broker = new LocalCapabilityBroker({
    store,
    resolveMatterFilesystemRoots: (matterId) => ({
      readWrite: [matterId === "matter-a" ? matterA : matterB],
    }),
    terminalExecutableAllowlist: [echoExecutable, mutableExecutable],
    approvedNetworkHosts: ["rebind.invalid"],
    resolveHost: async (host) => {
      if (host === "rebind.invalid")
        return [{ address: "127.0.0.1", family: 4 }];
      if (host === "localhost") return [{ address: "127.0.0.1", family: 4 }];
      throw new Error(`Unexpected audit DNS lookup for ${host}`);
    },
    resolvePlugin: (pluginId) => (pluginId === plugin.id ? plugin : undefined),
    maxTerminalOutputBytes: 4_096,
    maxNetworkResponseBytes: 4_096,
  });

  const issue = (
    scope: CapabilityGrantScope,
    options: {
      usageLimit?: number;
      singleUse?: boolean;
      expiresAt?: string;
    } = {},
  ) =>
    broker.issueGrant({
      ...context,
      scope,
      expiresAt: options.expiresAt ?? futureExpiry(),
      usageLimit: options.usageLimit,
      singleUse: options.singleUse,
      issuedBy: "human-reviewer",
      reason: "bounded audit capability",
    });

  const fileScope: CapabilityGrantScope = {
    kind: "filesystem",
    operations: ["read", "write"],
    roots: [matterA],
  };
  const fileGrant = issue(fileScope, { usageLimit: 8 });
  assert.equal(
    (
      await broker.readFile(context, fileGrant, {
        root: matterA,
        relativePath: "inside.txt",
      })
    ).toString("utf8"),
    "inside",
  );
  await assert.rejects(
    broker.readFile(context, fileGrant, {
      root: matterA,
      relativePath: "../outside/secret.txt",
    }),
    expectCode("RESOURCE_ESCAPE"),
  );
  await assert.rejects(
    broker.readFile(context, fileGrant, {
      root: matterA,
      relativePath: "escape-link",
    }),
    expectCode("SYMLINK_DENIED"),
  );
  await assert.rejects(
    broker.readFile(context, fileGrant, {
      root: matterA,
      relativePath: "escape-hardlink",
    }),
    expectCode("RESOURCE_ESCAPE"),
  );
  await broker.writeFile(context, fileGrant, {
    root: matterA,
    relativePath: "written.txt",
    data: "bounded",
  });
  assert.equal(
    readFileSync(path.join(matterA, "written.txt"), "utf8"),
    "bounded",
  );

  const crossMatterGrant = issue(
    { kind: "filesystem", operations: ["read"], roots: [matterA] },
    { singleUse: true },
  );
  await assert.rejects(
    broker.readFile({ ...context, matterId: "matter-b" }, crossMatterGrant, {
      root: matterA,
      relativePath: "inside.txt",
    }),
    expectCode("CAPABILITY_DENIED"),
  );
  assert.equal(
    (
      await broker.readFile(context, crossMatterGrant, {
        root: matterA,
        relativePath: "inside.txt",
      })
    ).toString(),
    "inside",
    "cross-matter denial must not consume the valid context's use",
  );
  await assert.rejects(
    broker.readFile(context, crossMatterGrant, {
      root: matterA,
      relativePath: "inside.txt",
    }),
    expectCode("GRANT_EXHAUSTED"),
  );

  const expiringGrant = issue(
    { kind: "filesystem", operations: ["read"], roots: [matterA] },
    { singleUse: true, expiresAt: futureExpiry(25) },
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  await assert.rejects(
    broker.readFile(context, expiringGrant, {
      root: matterA,
      relativePath: "inside.txt",
    }),
    expectCode("GRANT_EXPIRED"),
  );

  const revokedGrant = issue(
    { kind: "filesystem", operations: ["read"], roots: [matterA] },
    { singleUse: true },
  );
  broker.revokeGrant(
    revokedGrant.grantId,
    "human-reviewer",
    "no longer required",
  );
  await assert.rejects(
    broker.readFile(context, revokedGrant, {
      root: matterA,
      relativePath: "inside.txt",
    }),
    expectCode("GRANT_REVOKED"),
  );

  const terminalGrant = issue(
    {
      kind: "terminal",
      executablePaths: [echoExecutable],
      cwdRoots: [matterA],
    },
    { usageLimit: 3 },
  );
  const injectionMarker = path.join(matterA, "must-not-exist");
  const terminal = await broker.executeTerminal(context, terminalGrant, {
    executable: echoExecutable,
    args: ["safe;", "touch", injectionMarker, "$(uname)"],
    cwd: matterA,
  });
  assert.equal(terminal.exitCode, 0);
  assert.match(terminal.stdout.toString("utf8"), /safe; touch/);
  assert.equal(
    (() => {
      try {
        readFileSync(injectionMarker);
        return true;
      } catch {
        return false;
      }
    })(),
    false,
    "terminal arguments were interpreted by a shell",
  );
  await assert.rejects(
    broker.executeTerminal(context, terminalGrant, {
      executable: echoExecutable,
      args: ["outside cwd"],
      cwd: outside,
    }),
    expectCode("RESOURCE_ESCAPE"),
  );

  const mutableTerminalGrant = issue(
    {
      kind: "terminal",
      executablePaths: [mutableExecutable],
      cwdRoots: [matterA],
    },
    { singleUse: true },
  );
  writeFileSync(mutableExecutable, "tampered executable", { mode: 0o700 });
  await assert.rejects(
    broker.executeTerminal(context, mutableTerminalGrant, {
      executable: mutableExecutable,
      args: ["must not run"],
      cwd: matterA,
    }),
    expectCode("CAPABILITY_DENIED"),
  );

  assert.throws(
    () =>
      issue({
        kind: "network",
        destinations: [
          {
            host: "192.168.1.5",
            protocols: ["http:"],
            ports: [80],
            methods: ["GET"],
          },
        ],
      }),
    expectCode("NETWORK_DENIED"),
  );
  assert.throws(
    () =>
      issue({
        kind: "network",
        destinations: [
          {
            host: "0.0.0.0",
            protocols: ["http:"],
            ports: [80],
            methods: ["GET"],
          },
        ],
      }),
    expectCode("NETWORK_DENIED"),
  );

  const networkGrant = issue(
    {
      kind: "network",
      destinations: [
        {
          host: "127.0.0.1",
          protocols: ["http:"],
          ports: [port],
          methods: ["GET"],
        },
      ],
    },
    { usageLimit: 3 },
  );
  const localResponse = await broker.fetchNetwork(context, networkGrant, {
    url: `http://127.0.0.1:${port}/ok`,
  });
  assert.equal(localResponse.body.toString(), "local-network-ok");
  assert.equal(localResponse.connectedAddress, "127.0.0.1");
  await assert.rejects(
    broker.fetchNetwork(context, networkGrant, {
      url: `http://127.0.0.1:${port}/redirect`,
    }),
    expectCode("NETWORK_DENIED"),
  );

  const rebindingGrant = issue(
    {
      kind: "network",
      destinations: [
        {
          host: "rebind.invalid",
          protocols: ["http:"],
          ports: [port],
          methods: ["GET"],
        },
      ],
    },
    { singleUse: true },
  );
  await assert.rejects(
    broker.fetchNetwork(context, rebindingGrant, {
      url: `http://rebind.invalid:${port}/ok`,
    }),
    expectCode("NETWORK_DENIED"),
  );

  const pluginGrant = issue(
    {
      kind: "plugin",
      pluginId: plugin.id,
      action: "redact",
      version: plugin.version,
      sha256: plugin.sha256,
    },
    { singleUse: true },
  );
  assert.deepEqual(
    await broker.executePlugin(context, pluginGrant, {
      pluginId: plugin.id,
      action: "redact",
      input: { text: "secret" },
    }),
    {
      redacted: "[redacted]",
    },
  );

  const changedPluginGrant = issue(
    {
      kind: "plugin",
      pluginId: plugin.id,
      action: "redact",
      version: plugin.version,
      sha256: plugin.sha256,
    },
    { singleUse: true },
  );
  plugin = { ...plugin, version: "1.0.1", sha256: `sha256:${"b".repeat(64)}` };
  await assert.rejects(
    broker.executePlugin(context, changedPluginGrant, {
      pluginId: "local.redactor",
      action: "redact",
      input: { text: "secret" },
    }),
    expectCode("PLUGIN_MISMATCH"),
  );

  const integrity = store.verifyAuditIntegrity();
  assert.equal(integrity.ok, true, integrity.error);
  const audits = store.listAuditEvents();
  assert.ok(audits.some((event) => event.event === "decision.denied"));
  assert.ok(audits.some((event) => event.event === "use.succeeded"));
  assert.ok(audits.some((event) => event.event === "use.failed"));
  assert.ok(
    audits.every((event) => event.eventHash.startsWith("hmac-sha256:")),
  );

  const persistedUsage = store.getGrant(crossMatterGrant.grantId)?.usageCount;
  store.close();
  const reopened = new PersistentCapabilityGrantStore({ databasePath });
  assert.equal(
    reopened.getGrant(crossMatterGrant.grantId)?.usageCount,
    persistedUsage,
  );
  assert.equal(reopened.verifyAuditIntegrity().ok, true);
  reopened.close();

  server.close();
  await once(server, "close");
  rmSync(root, { recursive: true, force: true });

  console.log("Aletheia local capability broker audit passed.");
  console.log(
    JSON.stringify(
      {
        persistentBoundGrants: true,
        expiryRevocationAndReplay: true,
        matterAgentRunIsolation: true,
        traversalAndSymlinkDenied: true,
        terminalWithoutShell: true,
        cwdAndEnvironmentContained: true,
        networkDefaultDeny: true,
        dnsRebindingAndRedirectDenied: true,
        pluginArtifactBound: true,
        hmacAuditChain: true,
      },
      null,
      2,
    ),
  );
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
