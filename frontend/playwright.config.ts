import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const frontendPort = Number(process.env.ALETHEIA_UI_SMOKE_FRONTEND_PORT ?? 3410);
const backendPort = Number(process.env.ALETHEIA_UI_SMOKE_BACKEND_PORT ?? 3411);
const frontendUrl = `http://127.0.0.1:${frontendPort}`;
const backendUrl = `http://127.0.0.1:${backendPort}`;
const repoRoot = path.resolve(__dirname, "..");
const smokeDistDir = ".next-ui-smoke";
const dataDir =
  process.env.ALETHEIA_UI_SMOKE_DATA_DIR ??
  path.join(repoRoot, "backend", ".data", "aletheia-ui-smoke-e2e");

export default defineConfig({
  testDir: "./tests",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  globalSetup: "./tests/aletheia-ui-smoke.global-setup.ts",
  use: {
    baseURL: frontendUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: `node -e 'require("fs").rmSync(${JSON.stringify(dataDir)}, { recursive: true, force: true })' && npm run dev`,
      cwd: path.join(repoRoot, "backend"),
      url: `${backendUrl}/health`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        ...process.env,
        PORT: String(backendPort),
        FRONTEND_URL: frontendUrl,
        ALETHEIA_STORAGE_DRIVER: "local",
        ALETHEIA_AUTH_MODE: "single_user",
        ALETHEIA_DATA_DIR: dataDir,
        ALETHEIA_LOCAL_USER_ID: "local-user",
        ALETHEIA_LOCAL_USER_EMAIL: "local@aletheia.internal",
      },
    },
    {
      command: `node -e "require('fs').rmSync('${smokeDistDir}', { recursive: true, force: true })" && npm run build && npm run start -- -H 127.0.0.1 -p ${frontendPort}`,
      cwd: __dirname,
      url: frontendUrl,
      timeout: 180_000,
      reuseExistingServer: false,
      env: {
        ...process.env,
        NEXT_DIST_DIR: smokeDistDir,
        NEXT_PUBLIC_API_BASE_URL: backendUrl,
      },
    },
  ],
  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 5"] },
    },
  ],
});
