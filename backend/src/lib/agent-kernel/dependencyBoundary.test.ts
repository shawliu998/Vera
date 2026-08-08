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
    "effects/tabularEffect.ts",
    "execution/taskLease.ts",
    "execution/taskTransition.ts",
    "verification/artifactReverification.ts",
  ]);
});

test("read-only connector Kernel code remains provider-neutral", async () => {
  const connectorRoot = path.join(kernelRoot, "connectors");
  const violations: string[] = [];
  for (const file of await productionFiles(connectorRoot)) {
    const source = executableSource(await readFile(file, "utf8"));
    const providerTerms = source.match(
      /\b(?:courtlistener|epo|patsnap|pkulaw|yuandian|wolters)\b/gi,
    );
    if (providerTerms?.length) {
      violations.push(
        `${relative(file)} contains provider-specific terms: ${[
          ...new Set(providerTerms.map((term) => term.toLowerCase())),
        ].join(", ")}`,
      );
    }
  }
  assert.deepEqual(violations, []);
});

test("Patent Packs stay outside persistence, routes, and the retired parallel subsystem", async () => {
  const patentRoot = path.resolve(kernelRoot, "../agent-packs/patent");
  const violations: string[] = [];
  for (const file of await productionFiles(patentRoot)) {
    const source = await readFile(file, "utf8");
    for (const specifier of imports(source)) {
      if (
        /(?:^|\/)routes(?:\/|$)/.test(specifier) ||
        /(?:^|\/)supabase$/.test(specifier) ||
        /(?:^|\/)providerSourceImport$/.test(specifier) ||
        /(?:^|\/)patentSources(?:\/|$)/.test(specifier)
      ) {
        violations.push(`${path.basename(file)} -> ${specifier}`);
      }
    }
    const lines = source.split(/\r?\n/).length;
    if (lines > 500) {
      violations.push(`${path.basename(file)} has ${lines} lines`);
    }
  }
  assert.deepEqual(violations, []);
});

test("Contract Packs remain pure domain contracts without persistence, routes, or providers", async () => {
  const contractRoot = path.resolve(kernelRoot, "../agent-packs/contract");
  const violations: string[] = [];
  for (const file of await productionFiles(contractRoot)) {
    const source = await readFile(file, "utf8");
    for (const specifier of imports(source)) {
      if (
        /(?:^|\/)routes(?:\/|$)/.test(specifier) ||
        /(?:^|\/)supabase$/.test(specifier) ||
        /(?:^|\/)llm(?:\/|$)/.test(specifier) ||
        /(?:^|\/)userSettings$/.test(specifier) ||
        /(?:^|\/)storage$/.test(specifier)
      ) {
        violations.push(`${path.basename(file)} -> ${specifier}`);
      }
    }
    const lines = source.split(/\r?\n/).length;
    if (lines > 600) {
      violations.push(`${path.basename(file)} has ${lines} lines`);
    }
  }
  assert.deepEqual(violations, []);
});

test("Litigation Packs remain pure contracts without persistence, routes, providers, or legacy stores", async () => {
  const litigationRoot = path.resolve(kernelRoot, "../agent-packs/litigation");
  const violations: string[] = [];
  for (const file of await productionFiles(litigationRoot)) {
    const source = await readFile(file, "utf8");
    for (const specifier of imports(source)) {
      if (
        /(?:^|\/)routes(?:\/|$)/.test(specifier) ||
        /(?:^|\/)supabase$/.test(specifier) ||
        /(?:^|\/)llm(?:\/|$)/.test(specifier) ||
        /(?:^|\/)userSettings$/.test(specifier) ||
        /(?:^|\/)storage$/.test(specifier) ||
        /^\.\.\/\.\.\/litigationEvidenceInventory/.test(specifier)
      ) {
        violations.push(`${path.basename(file)} -> ${specifier}`);
      }
    }
    const lines = source.split(/\r?\n/).length;
    if (lines > 600) {
      violations.push(`${path.basename(file)} has ${lines} lines`);
    }
  }
  assert.deepEqual(violations, []);
});
