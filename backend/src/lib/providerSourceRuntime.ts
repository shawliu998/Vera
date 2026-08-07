import { z } from "zod";

import {
  COURTLISTENER_SOURCE_CONNECTOR_PIN,
  createCourtListenerSourceInvoker,
  createCourtListenerSourceNormalizer,
} from "./agent-packs/research/courtListenerSourcePack";
import {
  EPO_OPS_SOURCE_CONNECTOR_PIN,
  createEpoOpsSourceInvoker,
  createEpoOpsSourceNormalizer,
} from "./agent-packs/patent/epoOpsSourcePack";
import {
  READ_ONLY_SOURCE_AUTHORIZATION_VERSION,
  readOnlySourceAuthorizationSchema,
  type ReadOnlySourceAuthorizationV1,
  type ReadOnlySourceConnectorPinV1,
  type ReadOnlySourceOperationV1,
} from "./agent-kernel/connectors/readOnlySourceContract";
import type {
  ReadOnlySourceBoundInvokerV1,
  ReadOnlySourceNormalizerV1,
} from "./agent-kernel/connectors/readOnlySourceExecution";
import { createServerSupabase } from "./supabase";
import {
  getUserApiKeys,
  getUserEpoOpsCredentials,
  type EpoOpsCredentials,
} from "./userApiKeys";

type Db = ReturnType<typeof createServerSupabase>;
type SupportedOperation = Extract<
  ReadOnlySourceOperationV1,
  "search" | "read_snapshot"
>;

const registeredPins = new Map<string, ReadOnlySourceConnectorPinV1>([
  [
    COURTLISTENER_SOURCE_CONNECTOR_PIN.connector_id,
    COURTLISTENER_SOURCE_CONNECTOR_PIN,
  ],
  [EPO_OPS_SOURCE_CONNECTOR_PIN.connector_id, EPO_OPS_SOURCE_CONNECTOR_PIN],
]);

export const REGISTERED_PROVIDER_SOURCE_CONNECTOR_IDS = Object.freeze(
  [...registeredPins.keys()].sort(),
);

export class ProviderSourceRuntimeError extends Error {
  constructor(readonly code: "connector_unregistered") {
    super(`provider_source_runtime_${code}`);
    this.name = "ProviderSourceRuntimeError";
  }
}

export type ProviderSourceRuntimeV1 = {
  pin: ReadOnlySourceConnectorPinV1;
  authorization: ReadOnlySourceAuthorizationV1;
  invoker: ReadOnlySourceBoundInvokerV1;
  normalizer: ReadOnlySourceNormalizerV1;
};

export function resolveRegisteredProviderSourcePin(
  connectorId: string,
): ReadOnlySourceConnectorPinV1 {
  const pin = registeredPins.get(connectorId);
  if (!pin) throw new ProviderSourceRuntimeError("connector_unregistered");
  return pin;
}

function authorization(input: {
  pin: ReadOnlySourceConnectorPinV1;
  connected: boolean;
  checkedAt: string;
}) {
  return readOnlySourceAuthorizationSchema.parse({
    schema_version: READ_ONLY_SOURCE_AUTHORIZATION_VERSION,
    connector_id: input.pin.connector_id,
    connection: input.connected ? "connected" : "disconnected",
    subscription: "not_required",
    checked_at: input.checkedAt,
  });
}

export async function resolveProviderSourceRuntime(input: {
  connectorId: string;
  operation: SupportedOperation;
  userId: string;
  db?: Db;
  now?: () => string;
  dependencies?: {
    getEpoOpsCredentials?: (
      userId: string,
      db: Db,
    ) => Promise<EpoOpsCredentials | null>;
    getCourtListenerToken?: (
      userId: string,
      db: Db,
    ) => Promise<string | null>;
  };
}): Promise<ProviderSourceRuntimeV1> {
  z.string().uuid().parse(input.userId);
  const db = input.db ?? createServerSupabase();
  const pin = resolveRegisteredProviderSourcePin(input.connectorId);
  if (!pin.allowed_operations.includes(input.operation)) {
    throw new ProviderSourceRuntimeError("connector_unregistered");
  }
  const checkedAt = (input.now ?? (() => new Date().toISOString()))();

  if (pin.connector_id === EPO_OPS_SOURCE_CONNECTOR_PIN.connector_id) {
    const credentials = await (
      input.dependencies?.getEpoOpsCredentials ?? getUserEpoOpsCredentials
    )(input.userId, db);
    return {
      pin,
      authorization: authorization({
        pin,
        connected: credentials !== null,
        checkedAt,
      }),
      invoker: createEpoOpsSourceInvoker({
        operation: input.operation,
        credentials: credentials ?? { consumerKey: "", consumerSecret: "" },
      }),
      normalizer: createEpoOpsSourceNormalizer(),
    };
  }

  const token = await (
    input.dependencies?.getCourtListenerToken ??
    (async (userId: string, client: Db) =>
      (await getUserApiKeys(userId, client)).courtlistener?.trim() || null)
  )(input.userId, db);
  return {
    pin,
    authorization: authorization({
      pin,
      connected: token !== null,
      checkedAt,
    }),
    invoker: createCourtListenerSourceInvoker({
      operation: input.operation,
      apiToken: token ?? "",
    }),
    normalizer: createCourtListenerSourceNormalizer(),
  };
}
