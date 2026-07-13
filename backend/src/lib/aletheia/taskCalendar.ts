import type { TaskCalendarEntry } from "./repository";

const CRLF = "\r\n";
const EVENT_DURATION_MS = 60 * 60 * 1000;

function escapeText(value: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

function utcTimestamp(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Task calendar contains an invalid timestamp.");
  }
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function foldLine(line: string) {
  const physicalLines: string[] = [];
  let current = "";
  let currentBytes = 0;
  let limit = 75;

  for (const character of line) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (currentBytes + characterBytes > limit) {
      physicalLines.push(current);
      current = ` ${character}`;
      currentBytes = 1 + characterBytes;
      limit = 75;
    } else {
      current += character;
      currentBytes += characterBytes;
    }
  }
  physicalLines.push(current);
  return physicalLines.join(CRLF);
}

function relativeTaskUrl(task: TaskCalendarEntry) {
  const query = new URLSearchParams({
    matterId: task.matter_id,
    taskId: task.id,
  });
  return `/aletheia/tasks?${query.toString()}`;
}

function alarmLines(summary: string) {
  return ["-P7D", "-P1D", "-PT2H"].flatMap((trigger) => [
    "BEGIN:VALARM",
    `TRIGGER:${trigger}`,
    "ACTION:DISPLAY",
    `DESCRIPTION:${escapeText(summary)}`,
    "END:VALARM",
  ]);
}

function eventLines(task: TaskCalendarEntry) {
  const dueAt = new Date(task.due_at);
  if (!Number.isFinite(dueAt.getTime())) {
    throw new Error("Task calendar contains an invalid due date.");
  }
  const description = [
    `Matter: ${task.matter_title}`,
    `Priority: ${task.priority}`,
    task.note ? `Note: ${task.note}` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
  const lines = [
    "BEGIN:VEVENT",
    `UID:aletheia-task-${task.id}@aletheia.local`,
    `DTSTAMP:${utcTimestamp(task.updated_at || task.created_at)}`,
    `DTSTART:${utcTimestamp(task.due_at)}`,
    `DTEND:${utcTimestamp(
      new Date(dueAt.getTime() + EVENT_DURATION_MS).toISOString(),
    )}`,
    `SUMMARY:${escapeText(task.title)}`,
    `DESCRIPTION:${escapeText(description)}`,
    `URL:${relativeTaskUrl(task)}`,
    `CATEGORIES:${["ALETHEIA", "TASK", task.status, task.priority]
      .map((category) => escapeText(category.toUpperCase()))
      .join(",")}`,
    `STATUS:${task.status === "completed" ? "CANCELLED" : "CONFIRMED"}`,
  ];
  if (task.status === "open") lines.push(...alarmLines(task.title));
  lines.push("END:VEVENT");
  return lines;
}

export function buildTaskCalendar(tasks: TaskCalendarEntry[]) {
  const lines = [
    "BEGIN:VCALENDAR",
    "PRODID:-//Vera//Task Calendar//EN",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Aletheia Tasks",
    ...tasks.flatMap(eventLines),
    "END:VCALENDAR",
  ];
  return `${lines.map(foldLine).join(CRLF)}${CRLF}`;
}
