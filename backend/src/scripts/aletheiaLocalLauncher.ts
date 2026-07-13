import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";

type ManagedProcess = {
  name: string;
  child: ChildProcess;
};

function portOpen(port: number, host = "127.0.0.1") {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ port, host });
    socket.once("connect", () => {
      socket.end();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function nextDevLockExists(frontendDir: string) {
  return existsSync(path.join(frontendDir, ".next", "dev", "lock"));
}

function prefixLines(name: string, chunk: Buffer) {
  const text = chunk.toString("utf8");
  for (const line of text.split(/\r?\n/)) {
    if (line.trim()) process.stdout.write(`[${name}] ${line}\n`);
  }
}

function spawnManaged(args: {
  name: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  script: string;
  extraArgs?: string[];
}) {
  const child = spawn(npmCommand(), ["run", args.script, ...(args.extraArgs ?? [])], {
    cwd: args.cwd,
    env: args.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk: Buffer) => prefixLines(args.name, chunk));
  child.stderr.on("data", (chunk: Buffer) => prefixLines(args.name, chunk));
  child.on("exit", (code, signal) => {
    if (signal) {
      process.stdout.write(`[${args.name}] exited by ${signal}\n`);
    } else if (code !== 0) {
      process.stdout.write(`[${args.name}] exited with code ${code}\n`);
    }
  });
  return { name: args.name, child };
}

async function main() {
  const backendDir = process.cwd();
  const frontendDir = path.resolve(backendDir, "..", "frontend");
  const backendPort = Number(process.env.PORT ?? "3001");
  const requestedFrontendPort = Number(
    process.env.ALETHEIA_FRONTEND_PORT ?? "3000",
  );
  const frontendLocked = nextDevLockExists(frontendDir);
  const frontendPort =
    frontendLocked && requestedFrontendPort !== 3000
      ? 3000
      : requestedFrontendPort;
  const dataDir = process.env.ALETHEIA_DATA_DIR ?? ".data/aletheia";
  const frontendUrl = `http://localhost:${frontendPort}`;
  const apiBaseUrl = `http://localhost:${backendPort}`;
  const children: ManagedProcess[] = [];

  const backendEnv = {
    ...process.env,
    PORT: String(backendPort),
    FRONTEND_URL: frontendUrl,
    ALETHEIA_AUTH_MODE: process.env.ALETHEIA_AUTH_MODE ?? "single_user",
    ALETHEIA_DATA_DIR: dataDir,
    ALETHEIA_LOCAL_USER_ID: process.env.ALETHEIA_LOCAL_USER_ID ?? "local-user",
    ALETHEIA_LOCAL_USER_EMAIL:
      process.env.ALETHEIA_LOCAL_USER_EMAIL ?? "local@aletheia.internal",
  };
  const frontendEnv = {
    ...process.env,
    NEXT_PUBLIC_API_BASE_URL: apiBaseUrl,
  };

  if (await portOpen(backendPort)) {
    process.stdout.write(
      `[launcher] backend port ${backendPort} is already in use; leaving it untouched.\n`,
    );
  } else {
    children.push(
      spawnManaged({
        name: "backend",
        cwd: backendDir,
        env: backendEnv,
        script: "dev",
      }),
    );
  }

  if (frontendLocked) {
    process.stdout.write(
      "[launcher] a Next dev server is already running for this frontend; leaving it untouched.\n",
    );
    if (requestedFrontendPort !== frontendPort) {
      process.stdout.write(
        `[launcher] using ${frontendUrl} for backend CORS because Next dev lock exists.\n`,
      );
    }
  } else if (await portOpen(frontendPort)) {
    process.stdout.write(
      `[launcher] frontend port ${frontendPort} is already in use; leaving it untouched.\n`,
    );
  } else {
    children.push(
      spawnManaged({
        name: "frontend",
        cwd: frontendDir,
        env: frontendEnv,
        script: "dev",
        extraArgs: ["--", "-p", String(frontendPort)],
      }),
    );
  }

  process.stdout.write(
    [
      "[launcher] Aletheia local workspace",
      `  frontend: ${frontendUrl}/aletheia`,
      `  backend:  ${apiBaseUrl}/health`,
      `  dataDir:  ${dataDir}`,
      "  MCP:      cd backend && npm run mcp:aletheia",
      "  seed UI:  cd backend && npm run seed:aletheia:ui-smoke",
      "Press Ctrl-C to stop processes started by this launcher.",
      "",
    ].join("\n"),
  );

  if (children.length === 0) return;

  const stop = () => {
    for (const item of children) item.child.kill("SIGINT");
    setTimeout(() => process.exit(0), 500);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((error) => {
  console.error("[aletheia-local-launcher] failed", error);
  process.exit(1);
});
