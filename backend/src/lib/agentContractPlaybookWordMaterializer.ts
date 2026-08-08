import {
  applyDocxComments,
  applyTrackedEdits,
  docxReviewMarkupOutsideMainStory,
  extractDocxBodyText,
  extractDocxReviewMarkup,
  finalizeCleanDocx,
} from "./docxTrackedChanges";
import type { ContractPlaybookMaterializationPlanV1 } from "./agent-packs/contract/contractPlaybookMaterialization";

export type ContractPlaybookWordMaterializationIssueCode =
  | "plan_review_required"
  | "source_review_markup_present"
  | "source_hidden_review_markup_present"
  | "action_anchor_not_unique"
  | "action_anchor_crosses_paragraph"
  | "action_anchor_overlap"
  | "comment_write_failed"
  | "tracked_change_write_failed"
  | "revision_clean_text_mismatch"
  | "clean_review_markup_remaining";

export class ContractPlaybookWordMaterializationError extends Error {
  constructor(
    readonly issueCode: ContractPlaybookWordMaterializationIssueCode,
    readonly facts: Record<string, unknown>,
  ) {
    super(`Contract Word materialization requires review: ${issueCode}`);
    this.name = "ContractPlaybookWordMaterializationError";
  }
}

type NormalizedText = { text: string; originalIndices: number[] };

function normalizeWithMap(value: string): NormalizedText {
  const text: string[] = [];
  const originalIndices: number[] = [];
  let previousSpace = false;
  for (let index = 0; index < value.length; index += 1) {
    const original = value[index];
    const canonical = original
      .normalize("NFKC")
      .replace(/[\u2018\u2019\u2032]/g, "'")
      .replace(/[\u201c\u201d\u2033]/gi, '"')
      .replace(/[\u2013\u2014]/g, "-")
      .replace(/[\u00a0\u200b]/g, " ");
    for (const character of canonical) {
      if (/\s/u.test(character)) {
        if (!previousSpace) {
          text.push(" ");
          originalIndices.push(index);
          previousSpace = true;
        }
      } else {
        text.push(character);
        originalIndices.push(index);
        previousSpace = false;
      }
    }
  }
  return { text: text.join(""), originalIndices };
}

function allIndices(haystack: string, needle: string) {
  const indices: number[] = [];
  let cursor = 0;
  while (cursor <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, cursor);
    if (index < 0) break;
    indices.push(index);
    cursor = index + 1;
  }
  return indices;
}

function exactActionRanges(
  body: string,
  plan: ContractPlaybookMaterializationPlanV1,
) {
  const normalizedBody = normalizeWithMap(body);
  return plan.revision_actions.map((action) => {
    const anchor =
      action.kind === "replace_exact_span" ? action.find : action.anchor;
    const normalizedAnchor = normalizeWithMap(anchor).text;
    const hits = allIndices(normalizedBody.text, normalizedAnchor);
    if (hits.length !== 1) {
      throw new ContractPlaybookWordMaterializationError(
        "action_anchor_not_unique",
        {
          finding_id: action.finding_id,
          rule_id: action.rule_id,
          match_count: hits.length,
        },
      );
    }
    const normalizedStart = hits[0];
    const normalizedEnd = normalizedStart + normalizedAnchor.length;
    const start = normalizedBody.originalIndices[normalizedStart];
    const end =
      normalizedBody.originalIndices[normalizedEnd - 1] === undefined
        ? body.length
        : normalizedBody.originalIndices[normalizedEnd - 1] + 1;
    if (body.slice(start, end).includes("\n")) {
      throw new ContractPlaybookWordMaterializationError(
        "action_anchor_crosses_paragraph",
        { finding_id: action.finding_id, rule_id: action.rule_id },
      );
    }
    return { action, start, end };
  });
}

/**
 * Materialize revision and clean-copy bytes from one server-owned plan. The
 * source contract is read-only. Any ambiguity or unsupported pre-existing
 * review markup fails before a derived document is returned.
 */
export async function materializeContractPlaybookWordDocuments(input: {
  sourceBytes: Buffer;
  plan: ContractPlaybookMaterializationPlanV1;
  author?: string;
  initials?: string;
  date?: string;
}) {
  if (input.plan.status !== "ready") {
    throw new ContractPlaybookWordMaterializationError("plan_review_required", {
      issues: input.plan.issues,
    });
  }
  const outsideMainStory = await docxReviewMarkupOutsideMainStory(
    input.sourceBytes,
  );
  if (outsideMainStory.length) {
    throw new ContractPlaybookWordMaterializationError(
      "source_hidden_review_markup_present",
      { story_paths: outsideMainStory },
    );
  }
  const sourceMarkup = await extractDocxReviewMarkup(input.sourceBytes);
  if (sourceMarkup.items.length) {
    throw new ContractPlaybookWordMaterializationError(
      "source_review_markup_present",
      {
        markup_count: sourceMarkup.items.length,
        markup_kinds: sourceMarkup.items.map((item) => item.kind),
      },
    );
  }
  const sourceBody = await extractDocxBodyText(input.sourceBytes);
  const ranges = exactActionRanges(sourceBody, input.plan);
  const ordered = [...ranges].sort((left, right) => left.start - right.start);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].start < ordered[index - 1].end) {
      throw new ContractPlaybookWordMaterializationError(
        "action_anchor_overlap",
        {
          finding_ids: [
            ordered[index - 1].action.finding_id,
            ordered[index].action.finding_id,
          ],
          rule_ids: [
            ordered[index - 1].action.rule_id,
            ordered[index].action.rule_id,
          ],
        },
      );
    }
  }

  const commentActions = input.plan.revision_actions.filter(
    (action) => action.kind === "comment_exact_span",
  );
  const commented = await applyDocxComments(
    input.sourceBytes,
    commentActions.map((action) => ({
      anchor: action.anchor,
      comment: action.comment,
      reason: action.rule_id,
    })),
    {
      author: input.author ?? "Vera",
      initials: input.initials ?? "V",
      date: input.date,
    },
  );
  if (
    commented.errors.length ||
    commented.comments.length !== commentActions.length
  ) {
    throw new ContractPlaybookWordMaterializationError("comment_write_failed", {
      errors: commented.errors,
    });
  }

  const replacementActions = input.plan.revision_actions.filter(
    (action) => action.kind === "replace_exact_span",
  );
  const revision = await applyTrackedEdits(
    commented.bytes,
    replacementActions.map((action) => ({
      find: action.find,
      replace: action.replace,
      context_before: "",
      context_after: "",
      reason: action.rule_id,
    })),
    { author: input.author ?? "Vera" },
  );
  if (
    revision.errors.length ||
    revision.changes.length !== replacementActions.length
  ) {
    throw new ContractPlaybookWordMaterializationError(
      "tracked_change_write_failed",
      { errors: revision.errors },
    );
  }

  const cleanBytes = await finalizeCleanDocx(revision.bytes);
  const revisionBody = await extractDocxBodyText(revision.bytes);
  const cleanBody = await extractDocxBodyText(cleanBytes);
  if (revisionBody !== cleanBody) {
    throw new ContractPlaybookWordMaterializationError(
      "revision_clean_text_mismatch",
      {
        revision_text_length: revisionBody.length,
        clean_text_length: cleanBody.length,
      },
    );
  }
  const cleanMarkup = await extractDocxReviewMarkup(cleanBytes);
  if (cleanMarkup.items.length) {
    throw new ContractPlaybookWordMaterializationError(
      "clean_review_markup_remaining",
      { markup_count: cleanMarkup.items.length },
    );
  }
  return {
    revisionBytes: revision.bytes,
    cleanBytes,
    sourceBody,
    acceptedBody: cleanBody,
    trackedChanges: revision.changes,
    comments: commented.comments,
  };
}
