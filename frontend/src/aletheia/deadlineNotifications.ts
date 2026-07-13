import type {
  AletheiaMatterTaskRecord,
  AletheiaTaskNotificationClaim,
} from "@/app/lib/aletheiaApi";
import type { AletheiaNotification } from "./AletheiaNotificationCenter";

const dayMilliseconds = 24 * 60 * 60 * 1000;

function localDateKey(value: Date) {
  return [
    value.getFullYear(),
    String(value.getMonth() + 1).padStart(2, "0"),
    String(value.getDate()).padStart(2, "0"),
  ].join("-");
}

function dueLabel(value: Date) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

export type DeadlineNotificationCandidate = AletheiaNotification & {
  key: string;
  taskId: string;
  dueAt: string;
};

export function deadlineNotificationCandidate(
  task: AletheiaMatterTaskRecord,
  currentTime: Date,
  matterTitle?: string,
): DeadlineNotificationCandidate | null {
  if (task.status !== "open") return null;
  const due = new Date(task.due_at);
  if (Number.isNaN(due.valueOf())) return null;
  const remaining = due.valueOf() - currentTime.valueOf();
  if (remaining > dayMilliseconds) return null;

  const overdue = remaining < 0;
  const dateKey = localDateKey(currentTime);
  const key = `deadline-${task.id}-${overdue ? "overdue" : "due-soon"}-${dateKey}`;
  const context = matterTitle ? `${matterTitle} · ` : "";
  return {
    key,
    taskId: task.id,
    dueAt: task.due_at,
    tag: key,
    href: "/aletheia/tasks",
    title: overdue ? `Overdue: ${task.title}` : `Due soon: ${task.title}`,
    body: `${context}${overdue ? "Was due" : "Due"} ${dueLabel(due)}. Review the confirmed deadline in Work Queue.`,
  };
}

export function deadlineNotificationCandidates(
  tasks: AletheiaMatterTaskRecord[],
  currentTime: Date,
  matterTitles: Map<string, string> = new Map(),
) {
  return tasks
    .map((task) =>
      deadlineNotificationCandidate(
        task,
        currentTime,
        matterTitles.get(task.matter_id),
      ),
    )
    .filter((item): item is DeadlineNotificationCandidate => item !== null)
    .sort((left, right) => left.dueAt.localeCompare(right.dueAt));
}

export function claimedDeadlineNotification(
  claim: AletheiaTaskNotificationClaim,
): AletheiaNotification {
  const due = new Date(claim.dueAt);
  const overdue = claim.category === "overdue";
  return {
    tag: claim.tag,
    href: "/aletheia/tasks",
    nativeHandled: true,
    title: overdue ? `Overdue: ${claim.title}` : `Due soon: ${claim.title}`,
    body: `${claim.matterTitle} · ${overdue ? "Was due" : "Due"} ${dueLabel(due)}. Review the confirmed deadline in Work Queue.`,
  };
}
