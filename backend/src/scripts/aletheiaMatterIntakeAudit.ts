import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

async function main() {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "vera-matter-intake-"));
  process.env.ALETHEIA_AUTH_MODE = "single_user";
  process.env.ALETHEIA_DATA_DIR = dataDir;
  process.env.ALETHEIA_APPLICATION_ENCRYPTION = "disabled";
  process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";

  try {
    const { createAletheiaRepository } = await import("../lib/aletheia");
    const repository = createAletheiaRepository();
    const owner = {
      userId: "matter-intake-owner",
      userEmail: "owner@vera.local",
    };
    const outsider = {
      userId: "matter-intake-outsider",
      userEmail: "outsider@vera.local",
    };
    const metadata = {
      representationRole: "被告",
      opposingParties: "某供应链有限公司",
      court: "杭州市某区人民法院",
      caseNumber: "（2026）浙0100民初100号",
      procedureStage: "一审",
      intakeDate: "2026-07-12",
    };

    const created = (await repository.createMatter(owner, {
      title: "货款合同纠纷",
      objective: "核对付款事实并准备答辩材料。",
      template: "civil_litigation",
      status: "draft",
      riskLevel: "high",
      clientOrProject: "某制造有限公司",
      sourceProjectId: null,
      sharedWith: [],
      metadata,
    })) as Record<string, any>;

    const loaded = (await repository.getMatterDetail(
      owner,
      String(created.id),
    )) as Record<string, any>;
    assert(loaded);
    assert.equal(loaded.matter.title, "货款合同纠纷");
    assert.equal(loaded.matter.client_or_project, "某制造有限公司");
    assert.deepEqual(loaded.matter.metadata, metadata);
    assert(
      loaded.auditEvents.some(
        (event: Record<string, unknown>) => event.action === "matter_created",
      ),
    );

    assert.equal(
      await repository.getMatterDetail(outsider, String(created.id)),
      null,
    );
    const outsiderMatters = (await repository.listMatters(outsider)) as unknown[];
    assert.equal(outsiderMatters.length, 0);

    console.log(
      JSON.stringify(
        {
          ok: true,
          suite: "vera-matter-intake-v1",
          checks: [
            "Chinese intake metadata persists and reloads",
            "matter creation appends an audit event",
            "matter and user isolation fails closed",
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
