import { defineConfig } from "@playwright/test";

export default defineConfig({
    testDir: ".",
    testMatch: ["vera-shell-foundation.spec.ts", "vera-i18n-brand.spec.ts"],
    fullyParallel: false,
    workers: 1,
    reporter: [["list"]],
});
