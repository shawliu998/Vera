import assert from "node:assert/strict";
import test from "node:test";

import { buildDocContext } from "./contextBuilders";
import { getTurnReadIdentity } from "./tools/documentOps";

function fixtureDb() {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    documents: [
      {
        id: "document-1",
        user_id: "user-1",
        status: "ready",
        current_version_id: "version-2",
      },
    ],
    document_versions: [
      {
        id: "version-1",
        document_id: "document-1",
        storage_path: "matter/agreement-v1.docx",
        pdf_storage_path: null,
        version_number: 1,
        filename: "agreement-v1.docx",
        file_type: "docx",
        size_bytes: 10,
        page_count: 1,
        deleted_at: null,
      },
      {
        id: "version-2",
        document_id: "document-1",
        storage_path: "matter/agreement-v2.docx",
        pdf_storage_path: null,
        version_number: 2,
        filename: "agreement-v2.docx",
        file_type: "docx",
        size_bytes: 11,
        page_count: 1,
        deleted_at: null,
      },
    ],
  };
  return {
    from(table: string) {
      const filters: Array<(row: Record<string, unknown>) => boolean> = [];
      const query: Record<string, (...args: any[]) => any> = {
        select: () => query,
        eq(column: string, value: unknown) {
          filters.push((row) => row[column] === value);
          return query;
        },
        in(column: string, values: unknown[]) {
          filters.push((row) => values.includes(row[column]));
          return query;
        },
        is(column: string, value: unknown) {
          filters.push((row) => row[column] === value);
          return query;
        },
        single: () =>
          Promise.resolve({
            data:
              (tables[table] ?? []).filter((row) =>
                filters.every((filter) => filter(row)),
              )[0] ?? null,
            error: null,
          }),
        then(
          resolve: (value: unknown) => unknown,
          reject?: (error: unknown) => unknown,
        ) {
          return Promise.resolve({
            data: (tables[table] ?? []).filter((row) =>
              filters.every((filter) => filter(row)),
            ),
            error: null,
          }).then(resolve, reject);
        },
      };
      return query;
    },
  };
}

test("Work Task attachment pins the requested Version while ordinary Assistant uses current", async () => {
  const db = fixtureDb();
  const fixed = await buildDocContext(
    [
      {
        role: "user",
        content: "Review the fixed agreement.",
        files: [
          {
            filename: "agreement.docx",
            document_id: "document-1",
            version_id: "version-1",
          },
        ],
      },
    ],
    "user-1",
    db as never,
  );
  assert.equal(fixed.docIndex["doc-0"]?.version_id, "version-1");
  assert.equal(fixed.docIndex["doc-0"]?.fixed_version, true);
  assert.equal(
    fixed.docStore.get("doc-0")?.storage_path,
    "matter/agreement-v1.docx",
  );
  const fixedRead = await getTurnReadIdentity({
    docLabel: "doc-0",
    docIndex: fixed.docIndex,
    docStore: fixed.docStore,
    db: db as never,
  });
  assert.equal(fixedRead?.versionId, "version-1");
  assert.equal(fixedRead?.storagePath, "matter/agreement-v1.docx");

  const ordinary = await buildDocContext(
    [
      {
        role: "user",
        content: "Open the current agreement.",
        files: [{ filename: "agreement.docx", document_id: "document-1" }],
      },
    ],
    "user-1",
    db as never,
  );
  assert.equal(ordinary.docIndex["doc-0"]?.version_id, "version-2");
  assert.equal(ordinary.docIndex["doc-0"]?.fixed_version, false);
  assert.equal(
    ordinary.docStore.get("doc-0")?.storage_path,
    "matter/agreement-v2.docx",
  );
  const ordinaryRead = await getTurnReadIdentity({
    docLabel: "doc-0",
    docIndex: ordinary.docIndex,
    docStore: ordinary.docStore,
    db: db as never,
  });
  assert.equal(ordinaryRead?.versionId, "version-2");
});

test("conflicting fixed Versions fail before loading any document", async () => {
  await assert.rejects(
    buildDocContext(
      [
        {
          role: "user",
          content: "Invalid duplicate attachment.",
          files: [
            {
              filename: "agreement.docx",
              document_id: "document-1",
              version_id: "version-1",
            },
            {
              filename: "agreement.docx",
              document_id: "document-1",
              version_id: "version-2",
            },
          ],
        },
      ],
      "user-1",
      fixtureDb() as never,
    ),
    /Conflicting fixed Versions/,
  );
});
