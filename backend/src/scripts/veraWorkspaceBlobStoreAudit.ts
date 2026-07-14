import assert from "node:assert/strict";
import {
  createHash,
  randomBytes,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  linkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LocalWorkspaceBlobStore,
  WorkspaceBlobAlreadyExistsError,
  WorkspaceBlobConfigurationError,
  WorkspaceBlobIntegrityError,
  WorkspaceBlobUnsafePathError,
  type LocalWorkspaceBlobStoreOptions,
} from "../lib/workspace/localWorkspaceBlobStore";
import type {
  WorkspaceBlobCodec,
  WorkspaceBlobLocator,
} from "../lib/workspace/blobStore";

class IdentityCodec implements WorkspaceBlobCodec {
  readonly encrypted = false;
  encode(args: Parameters<WorkspaceBlobCodec["encode"]>[0]) {
    return Buffer.from(args.plaintext);
  }
  decode(args: Parameters<WorkspaceBlobCodec["decode"]>[0]) {
    return Buffer.from(args.envelope);
  }
}

class FailingCodec implements WorkspaceBlobCodec {
  readonly encrypted = false;
  encode(
    args: Parameters<WorkspaceBlobCodec["encode"]>[0],
  ): ReturnType<WorkspaceBlobCodec["encode"]> {
    void args;
    throw new Error("intentional codec failure");
  }
  decode(args: Parameters<WorkspaceBlobCodec["decode"]>[0]) {
    return Buffer.from(args.envelope);
  }
}

function integrity(value: Buffer) {
  return { sha256: createHash("sha256").update(value).digest("hex"), size: value.length };
}

function expectThrow(type: new (...args: any[]) => Error, fn: () => unknown) {
  assert.throws(fn, (error: unknown) => error instanceof type);
}

function makeStore(root: string, codec: WorkspaceBlobCodec = new IdentityCodec(), extra?: Partial<LocalWorkspaceBlobStoreOptions>) {
  return new LocalWorkspaceBlobStore({
    root,
    codec,
    allowUnencryptedCodec: true,
    ...extra,
  });
}

function original(documentId: string, versionId: string): WorkspaceBlobLocator {
  return { kind: "original", documentId, versionId };
}

function tempFiles(directory: string) {
  return readdirSync(directory).filter((entry) => entry.includes(".tmp-"));
}

function runAudit() {
  const root = mkdtempSync(path.join(os.tmpdir(), "vera-blob-store-"));
  chmodSync(root, 0o700);
  const docId = "11111111-1111-4111-8111-111111111111";
  const versionId = "22222222-2222-4222-8222-222222222222";
  const locator = original(docId, versionId);
  const bytes = Buffer.from("original bytes\n");
  const target = path.join(root, "documents", docId, "versions", versionId, "original");

  try {
    const store = makeStore(root);
    const record = store.putSync(locator, bytes);
    assert.deepEqual(store.readSync(locator, record), bytes);
    assert.equal(record.sha256, integrity(bytes).sha256);
    assert.equal(record.size, bytes.length);
    assert.equal(lstatSync(target).mode & 0o777, 0o600);
    assert.equal(lstatSync(path.dirname(target)).mode & 0o777, 0o700);
    expectThrow(WorkspaceBlobAlreadyExistsError, () => store.putSync(locator, Buffer.from("replacement")));
    assert.deepEqual(readFileSync(target), bytes);

    expectThrow(WorkspaceBlobUnsafePathError, () => store.putSync(original("../outside", versionId), bytes));
    expectThrow(WorkspaceBlobUnsafePathError, () => store.putSync(original("doc/escape", versionId), bytes));
    expectThrow(WorkspaceBlobUnsafePathError, () => store.putSync(original(".", versionId), bytes));
    expectThrow(WorkspaceBlobUnsafePathError, () => store.putSync(original("ordinary-word", versionId), bytes));
    expectThrow(WorkspaceBlobUnsafePathError, () => store.putSync(original("document.pdf", versionId), bytes));
    expectThrow(WorkspaceBlobUnsafePathError, () => store.putSync(original("a".repeat(129), versionId), bytes));
    expectThrow(
      WorkspaceBlobUnsafePathError,
      () => store.putSync({ kind: "preview", documentId: docId, versionId, previewId: "ordinary-word" }, bytes),
    );
    expectThrow(
      WorkspaceBlobUnsafePathError,
      () => store.putSync({ kind: "export", exportId: "export.pdf" }, bytes),
    );
    expectThrow(WorkspaceBlobUnsafePathError, () => store.putSync({ kind: "not-a-kind" } as never, bytes));
    const uppercaseLocator = original(
      "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
      "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB",
    );
    const uppercaseRecord = store.putSync(uppercaseLocator, bytes);
    assert.deepEqual(store.readSync(uppercaseLocator, uppercaseRecord), bytes);

    expectThrow(WorkspaceBlobIntegrityError, () => store.readSync(locator, { sha256: "0".repeat(64), size: bytes.length }));
    writeFileSync(target, Buffer.from("tampered"), { mode: 0o600 });
    expectThrow(WorkspaceBlobIntegrityError, () => store.readSync(locator, record));
    rmSync(target);
    const rewritten = store.putSync(locator, bytes);

    const outside = path.join(root, "outside");
    writeFileSync(outside, Buffer.from("outside"), { mode: 0o600 });
    const symlinkDoc = "33333333-3333-4333-8333-333333333333";
    mkdirSync(path.join(root, "documents"), { recursive: true, mode: 0o700 });
    symlinkSync(outside, path.join(root, "documents", symlinkDoc));
    expectThrow(WorkspaceBlobUnsafePathError, () => store.putSync(original(symlinkDoc, versionId), bytes));
    const hardlinkTarget = path.join(root, "hardlink-copy");
    linkSync(target, hardlinkTarget);
    expectThrow(WorkspaceBlobUnsafePathError, () => store.readSync(locator, rewritten));
    rmSync(hardlinkTarget);

    const failedDoc = "44444444-4444-4444-8444-444444444444";
    const failedStore = makeStore(root, new FailingCodec());
    expectThrow(Error, () => failedStore.putSync(original(failedDoc, versionId), bytes));
    const failedDir = path.join(root, "documents", failedDoc, "versions", versionId);
    assert.equal(existsSync(path.join(failedDir, "original")), false);
    assert.deepEqual(tempFiles(failedDir), []);

    const restarted = makeStore(root);
    assert.deepEqual(restarted.readSync(locator, rewritten), bytes);
    const staged = restarted.stageDeleteSync(locator);
    assert.equal(existsSync(target), false);
    assert.equal(existsSync(path.join(root, ".quarantine", staged.quarantineId)), true);
    restarted.restoreDeleteSync(staged);
    assert.deepEqual(restarted.readSync(locator, rewritten), bytes);
    const stagedAgain = restarted.stageDeleteSync(locator);
    restarted.finalizeDeleteSync(stagedAgain);
    assert.equal(existsSync(target), false);
    assert.equal(existsSync(path.join(root, ".quarantine", stagedAgain.quarantineId)), false);

    const parseFailureStore = makeStore(root);
    const parseRecord = parseFailureStore.putSync(original(docId, versionId), Buffer.from("parse-safe"));
    assert.throws(() => {
      parseFailureStore.readSync(locator, { sha256: "f".repeat(64), size: parseRecord.size });
    });
    assert.equal(existsSync(target), true);
    assert.deepEqual(parseFailureStore.readSync(locator, parseRecord), Buffer.from("parse-safe"));

    const forgedReceipt = {
      status: "staged",
      locator,
      quarantineId: "../../outside",
    } as never;
    expectThrow(WorkspaceBlobUnsafePathError, () => restarted.finalizeDeleteSync(forgedReceipt));

    const productionRoot = mkdtempSync(path.join(os.tmpdir(), "vera-blob-store-encrypted-"));
    const previous = {
      mode: process.env.ALETHEIA_APPLICATION_ENCRYPTION,
      keySource: process.env.ALETHEIA_MASTER_KEY_SOURCE,
      key: process.env.ALETHEIA_MASTER_KEY_BASE64,
      dataDir: process.env.ALETHEIA_DATA_DIR,
    };
    try {
      process.env.ALETHEIA_APPLICATION_ENCRYPTION = "disabled";
      expectThrow(WorkspaceBlobConfigurationError, () => new LocalWorkspaceBlobStore({ root: productionRoot }));
      process.env.ALETHEIA_APPLICATION_ENCRYPTION = "required";
      process.env.ALETHEIA_MASTER_KEY_SOURCE = "env";
      process.env.ALETHEIA_MASTER_KEY_BASE64 = randomBytes(32).toString("base64");
      process.env.ALETHEIA_DATA_DIR = productionRoot;
      const encryptedStore = new LocalWorkspaceBlobStore({ root: productionRoot });
      const encryptedLocator = original(docId, versionId);
      const encryptedRecord = encryptedStore.putSync(encryptedLocator, bytes);
      assert.notDeepEqual(readFileSync(path.join(productionRoot, "documents", docId, "versions", versionId, "original")), bytes);
      assert.deepEqual(encryptedStore.readSync(encryptedLocator, encryptedRecord), bytes);
    } finally {
      if (previous.mode === undefined) delete process.env.ALETHEIA_APPLICATION_ENCRYPTION;
      else process.env.ALETHEIA_APPLICATION_ENCRYPTION = previous.mode;
      if (previous.keySource === undefined) delete process.env.ALETHEIA_MASTER_KEY_SOURCE;
      else process.env.ALETHEIA_MASTER_KEY_SOURCE = previous.keySource;
      if (previous.key === undefined) delete process.env.ALETHEIA_MASTER_KEY_BASE64;
      else process.env.ALETHEIA_MASTER_KEY_BASE64 = previous.key;
      if (previous.dataDir === undefined) delete process.env.ALETHEIA_DATA_DIR;
      else process.env.ALETHEIA_DATA_DIR = previous.dataDir;
      rmSync(productionRoot, { recursive: true, force: true });
    }

    return {
      ok: true,
      suite: "vera-workspace-blob-store-audit-v1",
      checks: [
        "controlled ID/kind path generation",
        "same-name no-overwrite publication",
        "atomic fsync/link publication and owner-only modes",
        "plaintext hash/size verification and tamper rejection",
        "symlink and hardlink rejection",
        "failed-write temporary cleanup",
        "restart read",
        "quarantine, restore, and staged cleanup",
        "parse failure preserves original",
        "root-bounded delete receipt",
        "encrypted production default with no plaintext fallback",
      ],
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

try {
  console.log(JSON.stringify(runAudit(), null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
}
