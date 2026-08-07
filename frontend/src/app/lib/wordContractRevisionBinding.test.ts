import assert from "node:assert/strict";
import test from "node:test";

import {
  assertWordContractRevisionOpenBinding,
  classifyWordContractRevisionBinding,
  decodeWordContractRevisionBinding,
  encodeWordContractRevisionBinding,
  successorWordContractRevisionBinding,
  WordContractRevisionOpenIdentityError,
  type WordContractRevisionBinding,
} from "./wordContractRevisionBinding";

const binding: WordContractRevisionBinding = {
  schemaVersion: 1,
  kind: "contract-playbook-word-handoff-v1",
  taskId: "task-1",
  projectId: "matter-1",
  documentId: "document-1",
  versionId: "version-10",
};

// Cross-runtime protocol fixture. Keep this map literal (rather than deriving
// it with the encoder) so the backend has an exact, UUID-length contract to
// match when it writes the initial prepared-revision receipt.
const UUID_PROTOCOL_BINDING: WordContractRevisionBinding = {
  schemaVersion: 1,
  kind: "contract-playbook-word-handoff-v1",
  taskId: "a0d75d08-c1a0-4a3f-afb3-4c16d5141615",
  projectId: "0ebafd84-1f05-4a5a-b90c-fe992434e6ee",
  documentId: "0ff133ee-4208-80f8-fdf9-3bf5a94331da",
  versionId: "8d3f5df3-c172-f4c6-6857-ad1847aa57e0",
};

const UUID_PROTOCOL_PROPERTIES = {
  VeraContractRevisionBindingCount: "2",
  VeraContractRevisionBinding001:
    '{"schemaVersion":1,"kind":"contract-playbook-word-handoff-v1","taskId":"a0d75d08-c1a0-4a3f-afb3-4c16d5141615","projectId":"0ebafd84-1f05-4a5a-b90c-fe992434e6ee","documentId":"0ff133ee-4208-80f8-fdf9-3',
  VeraContractRevisionBinding002:
    'bf5a94331da","versionId":"8d3f5df3-c172-f4c6-6857-ad1847aa57e0"}',
};

function propertiesFor(value: WordContractRevisionBinding = binding) {
  return Object.fromEntries(
    encodeWordContractRevisionBinding(value).map(({ name, value }) => [
      name,
      value,
    ]),
  );
}

test("contract Word binding round-trips its exact immutable identity", () => {
  const properties = propertiesFor();
  assert.ok(
    encodeWordContractRevisionBinding(binding).every(
      (property) => property.value.length <= 200,
    ),
  );
  assert.deepEqual(decodeWordContractRevisionBinding(properties), binding);
  assert.deepEqual(classifyWordContractRevisionBinding(properties), {
    kind: "bound",
    binding,
  });
});

test("contract Word binding uses the frozen UUID-length Count/001/002 protocol", () => {
  assert.deepEqual(
    Object.fromEntries(
      encodeWordContractRevisionBinding(UUID_PROTOCOL_BINDING).map(
        ({ name, value }) => [name, value],
      ),
    ),
    UUID_PROTOCOL_PROPERTIES,
  );
  assert.deepEqual(
    decodeWordContractRevisionBinding(UUID_PROTOCOL_PROPERTIES),
    UUID_PROTOCOL_BINDING,
  );
});

test("raw UUID custom properties resolve to the canonical Matter identity", () => {
  const rawBinding: WordContractRevisionBinding = {
    schemaVersion: 1,
    kind: "contract-playbook-word-handoff-v1",
    taskId: "774a4b80-a594-4b8f-b9a1-2594a65ae7d4",
    projectId: "0ebafd84-1f05-4a5a-b90c-fe992434e6ee",
    documentId: "e987d4cec59bf34bfe5dcc7b11c72408",
    versionId: "60c23f6a8da9d6a422b031bede5a247d",
  };
  const canonicalDocumentId = "e987d4ce-c59b-f34b-fe5d-cc7b11c72408";
  const canonicalVersionId = "60c23f6a-8da9-d6a4-22b0-31bede5a247d";

  assert.deepEqual(
    decodeWordContractRevisionBinding(propertiesFor(rawBinding)),
    {
      ...rawBinding,
      documentId: canonicalDocumentId,
      versionId: canonicalVersionId,
    },
  );
  assert.equal(
    assertWordContractRevisionOpenBinding(rawBinding, {
      documentId: canonicalDocumentId,
      versionId: canonicalVersionId,
    }),
    rawBinding,
  );
});

test("contract Word binding classifies missing and malformed receipts fail-closed", () => {
  assert.deepEqual(classifyWordContractRevisionBinding({}), {
    kind: "absent",
  });
  assert.deepEqual(
    classifyWordContractRevisionBinding({
      VeraContractRevisionBindingCount: "2",
      VeraContractRevisionBinding001: "{",
    }),
    { kind: "invalid" },
  );
});

test("open contract Word identity requires exact document and version", () => {
  assert.equal(
    assertWordContractRevisionOpenBinding(binding, {
      documentId: "document-1",
      versionId: "version-10",
    }),
    binding,
  );
  assert.throws(
    () =>
      assertWordContractRevisionOpenBinding(binding, {
        documentId: "document-2",
        versionId: "version-10",
      }),
    WordContractRevisionOpenIdentityError,
  );
  assert.throws(
    () =>
      assertWordContractRevisionOpenBinding(binding, {
        documentId: "document-1",
        versionId: "version-11",
      }),
    WordContractRevisionOpenIdentityError,
  );
});

test("only an upload receipt advances the contract Word open identity", () => {
  assert.deepEqual(
    successorWordContractRevisionBinding(binding, "version-11"),
    {
      ...binding,
      versionId: "version-11",
    },
  );
  assert.throws(
    () => successorWordContractRevisionBinding(binding, ""),
    /server did not return a Version identity/,
  );
});
