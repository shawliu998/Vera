import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { WorkspaceDatabase } from "../lib/workspace/database";
import { WorkspaceApiError } from "../lib/workspace/errors";
import { ModelProfilesRepository } from "../lib/workspace/repositories/modelProfiles";
import {
  CREDENTIAL_STORE_OPERATION_MODE,
  CredentialStoreCollisionError,
  MAX_MODEL_CREDENTIAL_STORE_SECRET_BYTES,
  type CredentialDeletionInput,
  type CredentialResolutionInput,
  type CredentialStorageInput,
  type CredentialStorePort,
} from "../lib/workspace/services/credentialStore";
import {
  buildEndpointBindingSnapshot,
  ModelGateway,
} from "../lib/workspace/services/modelGateway";
import { ModelProfilesService } from "../lib/workspace/services/modelProfiles";

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(error: unknown): void;
};

function deferred<T = void>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function nextTurn() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

class AuditAsyncCredentialStore implements CredentialStorePort {
  readonly [CREDENTIAL_STORE_OPERATION_MODE] = "asynchronous" as const;
  available = true;
  storeGate: Deferred<void> | null = null;
  deleteGate: Deferred<void> | null = null;
  collideNextStore = false;
  failAfterNextStore = false;
  failNextDelete = false;
  readonly stored = new Map<string, string>();
  readonly storeCalls: CredentialStorageInput[] = [];
  readonly deleteCalls: CredentialDeletionInput[] = [];

  isAvailable() {
    return this.available;
  }

  async store(input: CredentialStorageInput) {
    this.storeCalls.push(input);
    if (this.storeGate) await this.storeGate.promise;
    if (this.collideNextStore) {
      this.collideNextStore = false;
      throw new CredentialStoreCollisionError();
    }
    this.stored.set(input.reference, input.secret);
    if (this.failAfterNextStore) {
      this.failAfterNextStore = false;
      throw new Error("indeterminate worker write");
    }
  }

  async resolve(input: CredentialResolutionInput) {
    const secret = this.stored.get(input.reference);
    if (!secret) throw new Error("credential unavailable");
    return secret;
  }

  async delete(input: CredentialDeletionInput) {
    this.deleteCalls.push(input);
    if (this.deleteGate) await this.deleteGate.promise;
    if (this.failNextDelete) {
      this.failNextDelete = false;
      throw new Error("worker delete failed");
    }
    this.stored.delete(input.reference);
  }
}

function assertSafeFailure(error: unknown, secret: string, reference = "") {
  assert.ok(error instanceof WorkspaceApiError);
  assert.equal(error.message.includes(secret), false);
  if (reference) assert.equal(error.message.includes(reference), false);
  return true;
}

async function main() {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "vera-async-credential-service-audit-"),
  );
  const database = new WorkspaceDatabase(path.join(root, "workspace.db"));
  try {
    const repository = new ModelProfilesRepository(database);
    const store = new AuditAsyncCredentialStore();
    let sequence = 1;
    const nextId = () =>
      `00000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`;
    const nextLocator = () => `locator${String(sequence++).padStart(57, "0")}`;
    const service = new ModelProfilesService(repository, {
      credentialStore: store,
      runtimeWired: true,
      nextId,
      nextCredentialLocatorId: nextLocator,
      clock: () => new Date("2026-07-15T10:00:00.000Z"),
    });

    const profile = service.create({
      name: "Async OpenAI",
      provider: "openai",
      model: "gpt-5.4",
    });
    assert.deepEqual(service.capabilities(), {
      schemaVersion: "vera-workspace-model-settings-v1",
      localOnly: true,
      loopbackHttpAllowed: false,
      credentialWriteEnabled: true,
      secretReadbackSupported: false,
      runtimeWired: true,
    });

    const callsBeforeOversizedSecrets = store.storeCalls.length;
    for (const oversizedSecret of [
      "x".repeat(MAX_MODEL_CREDENTIAL_STORE_SECRET_BYTES + 1),
      "😀".repeat(257),
    ]) {
      await assert.rejects(
        service.configureCredentialAsync(profile.id, {
          secret: oversizedSecret,
        }),
        (error: unknown) => assertSafeFailure(error, oversizedSecret),
      );
    }
    assert.equal(store.storeCalls.length, callsBeforeOversizedSecrets);

    const firstSecret = "x".repeat(MAX_MODEL_CREDENTIAL_STORE_SECRET_BYTES);
    assert.equal(Buffer.byteLength(firstSecret, "utf8"), 1024);
    assert.throws(
      () => service.configureCredential(profile.id, { secret: firstSecret }),
      (error: unknown) => {
        assert.ok(error instanceof WorkspaceApiError);
        assert.equal(error.status, 409);
        return true;
      },
    );
    assert.equal(
      store.storeCalls.length,
      0,
      "sync call started an async write",
    );

    const firstStoreGate = deferred();
    store.storeGate = firstStoreGate;
    let firstSettled = false;
    const firstConfigure = service
      .configureCredentialAsync(profile.id, { secret: firstSecret })
      .then((result) => {
        firstSettled = true;
        return result;
      });
    await nextTurn();
    assert.equal(store.storeCalls.length, 1);
    assert.equal(firstSettled, false);
    assert.equal(service.getView(profile.id).credential.status, "missing");
    assert.equal(repository.listCredentialOrphanCleanups().length, 1);
    firstStoreGate.resolve();
    const firstConfigured = await firstConfigure;
    store.storeGate = null;
    assert.equal(firstConfigured.credential.status, "configured");
    assert.equal(repository.listCredentialOrphanCleanups().length, 0);
    const firstReference = store.storeCalls[0].reference;
    assert.equal(store.stored.get(firstReference), firstSecret);

    const resolverGate = deferred<string>();
    let providerFetchStarted = false;
    const gateway = new ModelGateway(
      {
        resolve: async () => resolverGate.promise,
      },
      {
        fetchImpl: async (_input, init) => {
          providerFetchStarted = true;
          const headers = new Headers(init?.headers);
          assert.equal(headers.get("authorization"), `Bearer ${firstSecret}`);
          return new Response('{"data":[]}', {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      },
    );
    const configuredRecord = repository.requireStored(profile.id);
    const gatewayProfile = { ...configuredRecord, enabled: true };
    const gatewayRequest = gateway.request(gatewayProfile, {
      method: "GET",
      pathOrUrl: "models",
      expectedBinding: buildEndpointBindingSnapshot(gatewayProfile),
    });
    await nextTurn();
    assert.equal(providerFetchStarted, false);
    resolverGate.resolve(firstSecret);
    const gatewayResponse = await gatewayRequest;
    assert.equal(providerFetchStarted, true);
    assert.equal(gatewayResponse.status, 200);

    const replacementDeleteGate = deferred();
    store.deleteGate = replacementDeleteGate;
    let replacementSettled = false;
    const replacement = service
      .configureCredentialAsync(profile.id, {
        secret: "async-replacement-secret",
      })
      .then((result) => {
        replacementSettled = true;
        return result;
      });
    await nextTurn();
    assert.equal(replacementSettled, false);
    assert.equal(service.getView(profile.id).credential.status, "configured");
    assert.equal(repository.listCredentialOrphanCleanups().length, 1);
    assert.equal(store.stored.has(firstReference), true);
    replacementDeleteGate.resolve();
    await replacement;
    store.deleteGate = null;
    assert.equal(store.stored.has(firstReference), false);
    assert.equal(repository.listCredentialOrphanCleanups().length, 0);

    const uncertain = service.create({
      name: "Uncertain write",
      provider: "openai",
      model: "gpt-5.4",
    });
    store.failAfterNextStore = true;
    const uncertainSecret = "indeterminate-secret";
    await assert.rejects(
      service.configureCredentialAsync(uncertain.id, {
        secret: uncertainSecret,
      }),
      (error: unknown) => assertSafeFailure(error, uncertainSecret),
    );
    const uncertainReference = store.storeCalls.at(-1)!.reference;
    assert.equal(store.stored.has(uncertainReference), true);
    assert.equal(repository.listCredentialOrphanCleanups().length, 1);
    assert.deepEqual(await service.reconcileCredentialOrphansAsync(), {
      deleted: 1,
      rebound: 0,
      failed: 0,
    });
    assert.equal(store.stored.has(uncertainReference), false);
    assert.equal(repository.listCredentialOrphanCleanups().length, 0);

    const racing = service.create({
      name: "CAS race",
      provider: "openai",
      model: "gpt-5.4",
    });
    const racingStoreGate = deferred();
    store.storeGate = racingStoreGate;
    const racingSecret = "cas-race-secret";
    const racingConfigure = service.configureCredentialAsync(racing.id, {
      secret: racingSecret,
    });
    await nextTurn();
    service.update(racing.id, { model: "gpt-5.4-updated" });
    racingStoreGate.resolve();
    store.storeGate = null;
    const racingReference = store.storeCalls.at(-1)!.reference;
    await assert.rejects(racingConfigure, (error: unknown) => {
      assert.ok(error instanceof WorkspaceApiError);
      assert.equal(error.status, 409);
      return assertSafeFailure(error, racingSecret, racingReference);
    });
    assert.equal(store.stored.has(racingReference), false);
    assert.equal(repository.listCredentialOrphanCleanups().length, 0);

    const activeReference = store.storeCalls[1].reference;
    const clearDeleteGate = deferred();
    store.deleteGate = clearDeleteGate;
    let clearSettled = false;
    const clearing = service.clearCredentialAsync(profile.id).then((result) => {
      clearSettled = true;
      return result;
    });
    await nextTurn();
    assert.equal(clearSettled, false);
    assert.equal(service.getView(profile.id).credential.status, "missing");
    assert.equal(repository.listCredentialOrphanCleanups().length, 1);
    clearDeleteGate.resolve();
    await clearing;
    store.deleteGate = null;
    assert.equal(store.stored.has(activeReference), false);
    assert.equal(repository.listCredentialOrphanCleanups().length, 0);

    await service.configureCredentialAsync(profile.id, {
      secret: "binding-change-secret",
    });
    const boundReference = store.storeCalls.at(-1)!.reference;
    const bindingDeleteGate = deferred();
    store.deleteGate = bindingDeleteGate;
    let bindingSettled = false;
    const rebinding = service
      .updateAsync(profile.id, {
        provider: "deepseek",
        model: "deepseek-chat",
      })
      .then((result) => {
        bindingSettled = true;
        return result;
      });
    await nextTurn();
    assert.equal(bindingSettled, false);
    assert.equal(service.getView(profile.id).credential.status, "missing");
    assert.equal(repository.listCredentialOrphanCleanups().length, 1);
    bindingDeleteGate.resolve();
    await rebinding;
    store.deleteGate = null;
    assert.equal(store.stored.has(boundReference), false);

    await service.configureCredentialAsync(profile.id, {
      secret: "delete-profile-secret",
    });
    const deletedReference = store.storeCalls.at(-1)!.reference;
    const profileDeleteGate = deferred();
    store.deleteGate = profileDeleteGate;
    let deleteSettled = false;
    const deleting = service.deleteAsync(profile.id).then(() => {
      deleteSettled = true;
    });
    await nextTurn();
    assert.equal(deleteSettled, false);
    assert.equal(repository.listCredentialOrphanCleanups().length, 1);
    profileDeleteGate.resolve();
    await deleting;
    store.deleteGate = null;
    assert.equal(store.stored.has(deletedReference), false);
    assert.equal(repository.listCredentialOrphanCleanups().length, 0);

    const collision = service.create({
      name: "Certain collision",
      provider: "openai",
      model: "gpt-5.4",
    });
    store.collideNextStore = true;
    await assert.rejects(
      service.configureCredentialAsync(collision.id, {
        secret: "collision-secret",
      }),
      (error: unknown) => assertSafeFailure(error, "collision-secret"),
    );
    assert.equal(repository.listCredentialOrphanCleanups().length, 0);

    const callsBeforeUnavailable = store.storeCalls.length;
    store.available = false;
    assert.equal(service.capabilities().credentialWriteEnabled, false);
    assert.equal(service.capabilities().runtimeWired, false);
    await assert.rejects(
      service.configureCredentialAsync(collision.id, {
        secret: "unavailable-secret",
      }),
      (error: unknown) => {
        assert.ok(error instanceof WorkspaceApiError);
        assert.equal(error.status, 409);
        return assertSafeFailure(error, "unavailable-secret");
      },
    );
    assert.equal(store.storeCalls.length, callsBeforeUnavailable);

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          suite: "vera-workspace-async-credential-service-v1",
          checks: [
            "explicit sync/async lifecycle boundary",
            "store-before-CAS ordering and crash-safe cleanup intent",
            "awaited replacement, clear, binding-change, delete and reconcile cleanup",
            "CAS rollback and indeterminate-write recovery",
            "Promise-compatible gateway credential resolution",
            "dynamic credential availability and secret-free failures",
          ],
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
}

void main();
