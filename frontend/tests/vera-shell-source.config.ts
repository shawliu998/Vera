import { defineConfig } from "@playwright/test";

export default defineConfig({
    testDir: ".",
    testMatch: ["vera-shell-foundation.spec.ts"],
    fullyParallel: false,
    workers: 1,
    reporter: [["list"]],
});
