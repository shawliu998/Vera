"use strict";

const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  session,
  shell,
} = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const {
  isExternalBrowserUrl,
  isSameConnectedOrigin,
  normalizeConnectedAppUrl,
} = require("./connectedConfig");

const PRODUCT_NAME = "Vera";
const DEFAULT_DEVELOPMENT_URL = "http://localhost:3002/assistant";
const TEST_AUTO_QUIT_MS = Number(process.env.VERA_TEST_AUTO_QUIT_MS ?? 0);
let mainWindow = null;
let applicationUrl = null;

app.setName(PRODUCT_NAME);
const explicitProfile = String(
  process.env.VERA_DESKTOP_PROFILE_DIR ?? "",
).trim();
if (explicitProfile) {
  if (!path.isAbsolute(explicitProfile)) {
    throw new Error("VERA_DESKTOP_PROFILE_DIR must be an absolute path.");
  }
  fs.mkdirSync(explicitProfile, { recursive: true, mode: 0o700 });
  const profileInfo = fs.lstatSync(explicitProfile);
  if (!profileInfo.isDirectory() || profileInfo.isSymbolicLink()) {
    throw new Error("VERA_DESKTOP_PROFILE_DIR must be a real directory.");
  }
  app.setPath("userData", explicitProfile);
  app.setPath("sessionData", explicitProfile);
}

function configuredApplicationUrl() {
  const configured = process.env.VERA_APP_URL;
  const fallback = app.isPackaged ? "" : DEFAULT_DEVELOPMENT_URL;
  return normalizeConnectedAppUrl(configured || fallback);
}

function statusDocument(title, message) {
  const escapedTitle = String(title).replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );
  const escapedMessage = String(message).replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapedTitle}</title><style>
html,body{height:100%;margin:0;background:#f6f7f9;color:#171b25;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif}body{display:grid;place-items:center}main{width:min(430px,calc(100vw - 64px));padding:28px;border:1px solid rgba(17,24,39,.08);border-radius:20px;background:rgba(255,255,255,.82);box-shadow:0 18px 55px rgba(15,23,42,.08)}h1{margin:0;font:400 29px/1.2 Georgia,serif}p{margin:13px 0 0;color:#667085;font-size:14px;line-height:1.65}.mark{width:28px;height:3px;margin-bottom:20px;border-radius:2px;background:#4169a8}
</style></head><body><main><div class="mark"></div><h1>${escapedTitle}</h1><p>${escapedMessage}</p></main></body></html>`)}`;
}

async function openExternal(candidate) {
  if (isExternalBrowserUrl(candidate)) await shell.openExternal(candidate);
}

function installNavigationBoundary(window) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (applicationUrl && isSameConnectedOrigin(url, applicationUrl)) {
      void window.loadURL(url);
    } else {
      void openExternal(url);
    }
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (applicationUrl && isSameConnectedOrigin(url, applicationUrl)) return;
    event.preventDefault();
    void openExternal(url);
  });
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1380,
    height: 920,
    minWidth: 760,
    minHeight: 560,
    show: false,
    title: PRODUCT_NAME,
    backgroundColor: "#f6f7f9",
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 15, y: 15 } }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, "connectedPreload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      navigateOnDragDrop: false,
    },
  });
  installNavigationBoundary(window);
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  window.webContents.on("did-finish-load", () => {
    console.log(
      `[vera-connected] renderer-ready origin=${applicationUrl?.origin ?? "status"}`,
    );
    if (TEST_AUTO_QUIT_MS > 0) setTimeout(() => app.quit(), TEST_AUTO_QUIT_MS);
  });
  return window;
}

function installSessionBoundary() {
  const activeSession = session.defaultSession;
  activeSession.setPermissionCheckHandler(() => false);
  activeSession.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  activeSession.on("will-download", async (_event, item, contents) => {
    item.pause();
    const owner = BrowserWindow.fromWebContents(contents) ?? mainWindow;
    const result = await dialog.showSaveDialog(owner, {
      title: "Save Vera document",
      defaultPath: path.basename(item.getFilename()),
    });
    if (result.canceled || !result.filePath) {
      item.cancel();
      return;
    }
    item.setSavePath(result.filePath);
    item.resume();
  });
}

function installMenu() {
  const template = [
    ...(process.platform === "darwin"
      ? [
          {
            label: PRODUCT_NAME,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ]
      : []),
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        {
          label: "Reload Vera",
          accelerator: "CmdOrCtrl+R",
          click: () => void mainWindow?.reload(),
        },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle("vera:get-desktop-info", () => ({
  connected: true,
  platform: process.platform,
  version: app.getVersion(),
}));

const lockAcquired = app.requestSingleInstanceLock();
if (!lockAcquired) app.quit();

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.whenReady().then(async () => {
  installSessionBoundary();
  installMenu();
  mainWindow = createWindow();
  try {
    applicationUrl = configuredApplicationUrl();
    await mainWindow.loadURL(applicationUrl.toString());
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "The Vera workspace could not be opened.";
    await mainWindow.loadURL(
      statusDocument("Vera connection required", message),
    );
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createWindow();
    void mainWindow.loadURL(
      applicationUrl
        ? applicationUrl.toString()
        : statusDocument(
            "Vera connection required",
            "Set VERA_APP_URL to the HTTPS address of your Vera workspace.",
          ),
    );
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
