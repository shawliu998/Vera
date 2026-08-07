import assert from "node:assert/strict";
import test from "node:test";

import { EPO_OPS_SOURCE_CONNECTOR_PIN } from "./agent-packs/patent/epoOpsSourcePack";
import { COURTLISTENER_SOURCE_CONNECTOR_PIN } from "./agent-packs/research/courtListenerSourcePack";
import {
  ProviderSourceRuntimeError,
  REGISTERED_PROVIDER_SOURCE_CONNECTOR_IDS,
  resolveProviderSourceRuntime,
  resolveRegisteredProviderSourcePin,
} from "./providerSourceRuntime";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const CHECKED_AT = "2026-08-08T10:00:00.000Z";

test("the source registry contains only exact audited connector pins", () => {
  assert.deepEqual(REGISTERED_PROVIDER_SOURCE_CONNECTOR_IDS, [
    EPO_OPS_SOURCE_CONNECTOR_PIN.connector_id,
    COURTLISTENER_SOURCE_CONNECTOR_PIN.connector_id,
  ]);
  assert.deepEqual(
    resolveRegisteredProviderSourcePin(
      EPO_OPS_SOURCE_CONNECTOR_PIN.connector_id,
    ),
    EPO_OPS_SOURCE_CONNECTOR_PIN,
  );
  assert.throws(
    () => resolveRegisteredProviderSourcePin("model.selected.connector"),
    (error: unknown) =>
      error instanceof ProviderSourceRuntimeError &&
      error.code === "connector_unregistered",
  );
});

test("EPO OPS runtime resolves only the current user and keeps secrets in the invoker closure", async () => {
  const seen: string[] = [];
  const runtime = await resolveProviderSourceRuntime({
    connectorId: EPO_OPS_SOURCE_CONNECTOR_PIN.connector_id,
    operation: "search",
    userId: USER_A,
    db: {} as never,
    now: () => CHECKED_AT,
    dependencies: {
      getEpoOpsCredentials: async (userId) => {
        seen.push(userId);
        return userId === USER_A
          ? { consumerKey: "user-a-key", consumerSecret: "user-a-secret" }
          : null;
      },
    },
  });
  assert.deepEqual(seen, [USER_A]);
  assert.equal(runtime.pin.connector_id, EPO_OPS_SOURCE_CONNECTOR_PIN.connector_id);
  assert.deepEqual(runtime.authorization, {
    schema_version: "read_only_source_authorization_v1",
    connector_id: EPO_OPS_SOURCE_CONNECTOR_PIN.connector_id,
    connection: "connected",
    subscription: "not_required",
    checked_at: CHECKED_AT,
  });
  const serialized = JSON.stringify(runtime);
  assert.doesNotMatch(serialized, /user-a-key|user-a-secret/);
  assert.equal(runtime.invoker.connectorId, runtime.pin.connector_id);
  assert.deepEqual(runtime.invoker.binding, runtime.pin.binding);
  assert.deepEqual(runtime.normalizer.pin, runtime.pin);
});

test("an unconfigured current user remains disconnected without borrowing another user's EPO pair", async () => {
  const runtime = await resolveProviderSourceRuntime({
    connectorId: EPO_OPS_SOURCE_CONNECTOR_PIN.connector_id,
    operation: "read_snapshot",
    userId: USER_B,
    db: {} as never,
    now: () => CHECKED_AT,
    dependencies: {
      getEpoOpsCredentials: async (userId) =>
        userId === USER_A
          ? { consumerKey: "user-a-key", consumerSecret: "user-a-secret" }
          : null,
    },
  });
  assert.equal(runtime.authorization.connection, "disconnected");
  assert.doesNotMatch(JSON.stringify(runtime), /user-a-key|user-a-secret/);
});

test("CourtListener uses the same current-user runtime boundary", async () => {
  const runtime = await resolveProviderSourceRuntime({
    connectorId: COURTLISTENER_SOURCE_CONNECTOR_PIN.connector_id,
    operation: "search",
    userId: USER_A,
    db: {} as never,
    now: () => CHECKED_AT,
    dependencies: {
      getCourtListenerToken: async (userId) =>
        userId === USER_A ? "courtlistener-user-a-token" : null,
    },
  });
  assert.equal(runtime.authorization.connection, "connected");
  assert.equal(runtime.pin.connector_id, runtime.invoker.connectorId);
  assert.doesNotMatch(JSON.stringify(runtime), /courtlistener-user-a-token/);
});
