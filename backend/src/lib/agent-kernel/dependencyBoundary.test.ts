import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const kernelRoot = path.dirname(fileURLToPath(import.meta.url));

async function productionFiles(directory = kernelRoot): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) return productionFiles(absolutePath);
      if (
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts")
      ) {
        return [absolutePath];
      }
      return [];
    }),
  );
  return files.flat().sort();
}

function relative(file: string) {
  return path.relative(kernelRoot, file).split(path.sep).join("/");
}

function imports(source: string) {
  return [...source.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map(
    (match) => match[1],
  );
}

function executableSource(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

test("Kernel production code does not depend on routes, UI, or domain Packs", async () => {
  const violations: string[] = [];
  for (const file of await productionFiles()) {
    const source = await readFile(file, "utf8");
    for (const specifier of imports(source)) {
      if (
        /(?:^|\/)routes(?:\/|$)/.test(specifier) ||
        /(?:^|\/)packs(?:\/|$)/.test(specifier) ||
        /(?:^|\/)frontend(?:\/|$)/.test(specifier)
      ) {
        violations.push(`${relative(file)} -> ${specifier}`);
      }
    }
    if (/\b(?:litigation|patent|playbook)\b/i.test(executableSource(source))) {
      violations.push(
        `${relative(file)} contains Pack-specific domain behavior`,
      );
    }
  }
  assert.deepEqual(violations, []);
});

test("direct Supabase coupling is frozen to the current extraction adapters", async () => {
  const coupled: string[] = [];
  for (const file of await productionFiles()) {
    const source = await readFile(file, "utf8");
    if (
      imports(source).some((specifier) => /(?:^|\/)supabase$/.test(specifier))
    ) {
      coupled.push(relative(file));
    }
  }
  assert.deepEqual(coupled, [
    "context/matterContextRepository.ts",
    "effects/stepEffect.ts",
    "execution/taskLease.ts",
    "execution/taskTransition.ts",
    "verification/artifactReverification.ts",
  ]);
});
