const { app, BrowserWindow, dialog, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const BACKEND_PORT = Number(process.env.ALETHEIA_DESKTOP_BACKEND_PORT ?? 43761);
const FRONTEND_PORT = Number(process.env.ALETHEIA_DESKTOP_FRONTEND_PORT ?? 43760);
const HOST = "127.0.0.1";
const BACKEND_URL = `http://${HOST}:${BACKEND_PORT}`;
const FRONTEND_URL = `http://${HOST}:${FRONTEND_PORT}`;

let mainWindow = null;
const children = new Set();

function resourceRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "aletheia")
    : path.resolve(__dirname, "..");
}

function loadingHtml(message) {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Aletheia</title>
    <style>
      html, body {
        margin: 0;
        height: 100%;
        background: #f7f8f8;
        color: #111827;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      body {
        display: grid;
        place-items: center;
      }
      main {
        width: min(420px, calc(100vw - 48px));
      }
      h1 {
        margin: 0;
        font-family: Georgia, "Times New Roman", serif;
        font-size: 34px;
        font-weight: 300;
      }
      p {
        margin: 12px 0 0;
        color: #4b5563;
        font-size: 14px;
        line-height: 1.6;
      }
      .bar {
        margin-top: 22px;
        height: 6px;
        overflow: hidden;
        border-radius: 999px;
        background: #e5e7eb;
      }
      .bar::before {
        display: block;
        width: 42%;
        height: 100%;
        border-radius: inherit;
        background: #111827;
        animation: load 1.4s ease-in-out infinite;
        content: "";
      }
      @keyframes load {
        0% { transform: translateX(-110%); }
        100% { transform: translateX(260%); }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Aletheia</h1>
      <p>${message}</p>
      <div class="bar"></div>
    </main>
  </body>
</html>`;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 1060,
    minHeight: 720,
    title: "Aletheia",
    backgroundColor: "#f7f8f8",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(
      loadingHtml("Starting the local professional workspace..."),
    )}`,
  );
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHttp(url, timeoutMs) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await wait(500);
  }
  throw lastError ?? new Error(`${url} did not become ready`);
}

function assertPortFree(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", () => {
      reject(
        new Error(
          `Port ${port} is already in use. Quit the other local service or set ALETHEIA_DESKTOP_FRONTEND_PORT/ALETHEIA_DESKTOP_BACKEND_PORT before launching Aletheia.`,
        ),
      );
    });
    server.once("listening", () => {
      server.close(resolve);
    });
    server.listen(port, HOST);
  });
}

function spawnNode(label, args, options) {
  const child = spawn(process.execPath, args, {
    ...options,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      ...options.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  child.stdout.on("data", (chunk) =>
    console.log(`[${label}] ${chunk.toString().trimEnd()}`),
  );
  child.stderr.on("data", (chunk) =>
    console.error(`[${label}] ${chunk.toString().trimEnd()}`),
  );
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (code !== 0 && signal !== "SIGTERM") {
      console.error(`[${label}] exited with code=${code} signal=${signal}`);
    }
  });
  return child;
}

function assertPackagedResources(root) {
  const required = [
    path.join(root, "backend", "dist", "index.js"),
    path.join(root, "backend", "node_modules"),
    path.join(root, "frontend", ".next"),
    path.join(root, "frontend", "node_modules", "next", "dist", "bin", "next"),
  ];
  for (const item of required) {
    if (!fs.existsSync(item)) {
      throw new Error(`Missing desktop runtime resource: ${item}`);
    }
  }
}

async function startServices() {
  await assertPortFree(BACKEND_PORT);
  await assertPortFree(FRONTEND_PORT);

  const root = resourceRoot();
  assertPackagedResources(root);

  const dataDir = path.join(app.getPath("userData"), "aletheia-data");
  fs.mkdirSync(dataDir, { recursive: true });

  const backendDir = path.join(root, "backend");
  spawnNode("backend", [path.join(backendDir, "dist", "index.js")], {
    cwd: backendDir,
    env: {
      NODE_ENV: "production",
      PORT: String(BACKEND_PORT),
      FRONTEND_URL,
      DOWNLOAD_SIGNING_SECRET:
        process.env.DOWNLOAD_SIGNING_SECRET ??
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      ALETHEIA_STORAGE_DRIVER: "local",
      ALETHEIA_AUTH_MODE: process.env.ALETHEIA_AUTH_MODE ?? "single_user",
      ALETHEIA_PRIVATE_AUTH_TOKEN: process.env.ALETHEIA_PRIVATE_AUTH_TOKEN ?? "",
      ALETHEIA_DATA_DIR: dataDir,
      ALETHEIA_LOCAL_USER_ID:
        process.env.ALETHEIA_LOCAL_USER_ID ?? "desktop-local-user",
      ALETHEIA_LOCAL_USER_EMAIL:
        process.env.ALETHEIA_LOCAL_USER_EMAIL ?? "desktop@aletheia.local",
      ALETHEIA_RETRIEVAL_MODE: "keyword",
      ALETHEIA_SEMANTIC_INDEX_ENABLED: "false",
      ALETHEIA_SEMANTIC_INDEX_DRIVER: "disabled",
      ALETHEIA_SEMANTIC_INDEX_DIR: path.join(dataDir, "index", "semantic-local"),
      ALETHEIA_DEMO_SEED_ENABLED:
        process.env.ALETHEIA_DEMO_SEED_ENABLED ?? "true",
      ALETHEIA_DEMO_SEED_MODE: process.env.ALETHEIA_DEMO_SEED_MODE ?? "empty",
    },
  });
  await waitForHttp(`${BACKEND_URL}/health`, 45_000);

  const frontendDir = path.join(root, "frontend");
  spawnNode(
    "frontend",
    [
      path.join(frontendDir, "node_modules", "next", "dist", "bin", "next"),
      "start",
      "-H",
      HOST,
      "-p",
      String(FRONTEND_PORT),
    ],
    {
      cwd: frontendDir,
      env: {
        NODE_ENV: "production",
        PORT: String(FRONTEND_PORT),
        HOSTNAME: HOST,
        NEXT_PUBLIC_API_BASE_URL: BACKEND_URL,
        NEXT_PUBLIC_ALETHEIA_PRIVATE_AUTH_TOKEN:
          process.env.NEXT_PUBLIC_ALETHEIA_PRIVATE_AUTH_TOKEN ?? "",
        NEXT_PUBLIC_SUPABASE_URL:
          process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321",
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY:
          process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY ??
          "demo-anon-key",
      },
    },
  );
  await waitForHttp(`${FRONTEND_URL}/aletheia`, 45_000);
}

function stopServices() {
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
}

async function boot() {
  createWindow();
  try {
    await startServices();
    await mainWindow.loadURL(`${FRONTEND_URL}/aletheia`);
  } catch (error) {
    console.error("[desktop] startup failed", error);
    dialog.showErrorBox(
      "Aletheia could not start",
      error instanceof Error ? error.message : String(error),
    );
    app.quit();
  }
}

app.whenReady().then(boot);

app.on("before-quit", stopServices);
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) boot();
});
