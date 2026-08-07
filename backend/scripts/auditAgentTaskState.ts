import dotenv from "dotenv";

import { auditAgentTaskState } from "../src/lib/agent-kernel/recovery/taskStateAudit";
import { createServerSupabase } from "../src/lib/supabase";

const envFile = process.env.VERA_AGENT_TASK_AUDIT_ENV_FILE?.trim() || ".env";
dotenv.config({ path: envFile, quiet: true });

const db = createServerSupabase();
const pageSize = 1000;

async function loadRows(
  table: string,
  select: string,
): Promise<Record<string, unknown>[]> {
  const collected: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await db
      .from(table)
      .select(select)
      .order("id", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) {
      throw new Error(
        `Read-only audit could not read ${table}: ${error.message}`,
      );
    }
    const page = (data ?? []) as Record<string, unknown>[];
    collected.push(...page);
    if (page.length < pageSize) return collected;
  }
}

async function countRows(table: string) {
  const { count, error } = await db
    .from(table)
    .select("*", { count: "exact", head: true });
  if (error) {
    throw new Error(
      `Read-only audit could not count ${table}: ${error.message}`,
    );
  }
  return count ?? 0;
}

async function main() {
  const [tasks, steps, artifactLinkCount, reviewDecisionCount] =
    await Promise.all([
      loadRows(
        "agent_tasks",
        "id,status,current_step,latest_checkpoint,execution_lease_owner,execution_lease_expires_at",
      ),
      loadRows("agent_steps", "id,task_id,position,status,attempt,result_data"),
      countRows("agent_artifact_links"),
      countRows("agent_task_review_decisions"),
    ]);

  const report = auditAgentTaskState(tasks as never, steps as never);
  process.stdout.write(
    `${JSON.stringify(
      {
        ...report,
        counts: {
          ...report.counts,
          artifact_links: artifactLinkCount,
          review_decisions: reviewDecisionCount,
        },
        read_only: true,
        source: "agent_tasks/agent_steps structural fields only",
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Agent Task read-only audit failed: ${message}\n`);
  process.exitCode = 1;
});
