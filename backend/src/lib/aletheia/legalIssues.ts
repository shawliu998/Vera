import { createHash } from "node:crypto";

export const LEGAL_RESEARCH_REQUEST_SCHEMA = "vera-legal-research-request-v1";
export const LEGAL_ISSUE_TREE_SCHEMA = "vera-legal-research-issue-tree-v1";

const MAX_NODES = 200;
const MAX_DEPTH = 12;
const MAX_TITLE_LENGTH = 240;
const MAX_DESCRIPTION_LENGTH = 4_000;
const MAX_ORDER = 1_000_000;
const LOCAL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const ISSUE_STATUSES = new Set(["open", "resolved", "needs_material"]);

export type LegalIssueStatus = "open" | "resolved" | "needs_material";

export type LegalIssueNode = {
  id: string;
  parentId: string | null;
  title: string;
  description: string | null;
  status: LegalIssueStatus;
  order: number;
};

export type LegalIssueTree = {
  rootId: string;
  nodes: LegalIssueNode[];
  nodeCount: number;
  maxDepth: number;
  statusCounts: Record<LegalIssueStatus, number>;
  treeHash: string;
};

export class LegalIssueTreeError extends Error {
  constructor(message: string, readonly code = "invalid_issue_tree") {
    super(message);
    this.name = "LegalIssueTreeError";
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requiredText(value: unknown, label: string, maximum: number) {
  if (typeof value !== "string") {
    throw new LegalIssueTreeError(`${label} is required.`);
  }
  const result = value.trim();
  if (!result || result.length > maximum) {
    throw new LegalIssueTreeError(`${label} must be between 1 and ${maximum} characters.`);
  }
  return result;
}

function optionalText(value: unknown, label: string, maximum: number) {
  if (value === undefined || value === null || value === "") return null;
  return requiredText(value, label, maximum);
}

function localId(value: unknown, label: string) {
  const id = requiredText(value, label, 80);
  if (!LOCAL_ID.test(id)) {
    throw new LegalIssueTreeError(`${label} must be a local opaque identifier.`);
  }
  return id;
}

function sha256(value: string) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function canonicalTree(nodes: LegalIssueNode[]) {
  return nodes
    .map((node) => ({ ...node }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function validateLegalIssueTree(value: unknown): LegalIssueTree {
  const payload = object(value);
  const rawNodes = payload.nodes;
  if (!Array.isArray(rawNodes) || rawNodes.length === 0 || rawNodes.length > MAX_NODES) {
    throw new LegalIssueTreeError(`nodes must contain between 1 and ${MAX_NODES} entries.`);
  }

  const nodes = rawNodes.map((rawNode, index): LegalIssueNode => {
    const node = object(rawNode);
    const id = localId(node.id, `nodes[${index}].id`);
    const parentId = node.parentId === null
      ? null
      : localId(node.parentId, `nodes[${index}].parentId`);
    if (!ISSUE_STATUSES.has(node.status as string)) {
      throw new LegalIssueTreeError(`nodes[${index}].status is invalid.`);
    }
    if (!Number.isInteger(node.order) || (node.order as number) < 0 || (node.order as number) > MAX_ORDER) {
      throw new LegalIssueTreeError(`nodes[${index}].order must be an integer between 0 and ${MAX_ORDER}.`);
    }
    return {
      id,
      parentId,
      title: requiredText(node.title, `nodes[${index}].title`, MAX_TITLE_LENGTH),
      description: optionalText(node.description, `nodes[${index}].description`, MAX_DESCRIPTION_LENGTH),
      status: node.status as LegalIssueStatus,
      order: node.order as number,
    };
  });

  const nodesById = new Map<string, LegalIssueNode>();
  for (const node of nodes) {
    if (nodesById.has(node.id)) {
      throw new LegalIssueTreeError("nodes must not contain duplicate IDs.");
    }
    nodesById.set(node.id, node);
  }
  const roots = nodes.filter((node) => node.parentId === null);
  if (roots.length !== 1) {
    throw new LegalIssueTreeError("nodes must have exactly one root.");
  }
  for (const node of nodes) {
    if (node.parentId !== null && !nodesById.has(node.parentId)) {
      throw new LegalIssueTreeError(`node ${node.id} has an unknown parent.`);
    }
    if (node.parentId === node.id) {
      throw new LegalIssueTreeError(`node ${node.id} cannot be its own parent.`);
    }
  }

  const depthById = new Map<string, number>();
  const visiting = new Set<string>();
  const depthFor = (node: LegalIssueNode): number => {
    const cached = depthById.get(node.id);
    if (cached !== undefined) return cached;
    if (visiting.has(node.id)) {
      throw new LegalIssueTreeError("nodes must not contain a cycle.");
    }
    visiting.add(node.id);
    const depth = node.parentId === null
      ? 1
      : depthFor(nodesById.get(node.parentId) as LegalIssueNode) + 1;
    visiting.delete(node.id);
    if (depth > MAX_DEPTH) {
      throw new LegalIssueTreeError(`nodes must not exceed depth ${MAX_DEPTH}.`);
    }
    depthById.set(node.id, depth);
    return depth;
  };

  for (const node of nodes) depthFor(node);
  const statusCounts: Record<LegalIssueStatus, number> = {
    open: 0,
    resolved: 0,
    needs_material: 0,
  };
  for (const node of nodes) statusCounts[node.status] += 1;
  const canonicalNodes = canonicalTree(nodes);
  return {
    rootId: roots[0].id,
    nodes: canonicalNodes,
    nodeCount: nodes.length,
    maxDepth: Math.max(...depthById.values()),
    statusCounts,
    treeHash: sha256(JSON.stringify(canonicalNodes)),
  };
}

export function isValidLegalResearchRequest(value: unknown) {
  const content = object(value);
  const request = object(content.request);
  const bounded = (field: unknown, maximum: number) =>
    typeof field === "string" && field.trim().length > 0 && field.trim().length <= maximum;
  const asOfDate = typeof request.asOfDate === "string" ? request.asOfDate.trim() : "";
  const parsedDate = new Date(`${asOfDate}T00:00:00.000Z`);
  return content.schemaVersion === LEGAL_RESEARCH_REQUEST_SCHEMA &&
    bounded(request.title, 240) &&
    bounded(request.facts, 12_000) &&
    bounded(request.jurisdiction, 120) &&
    bounded(request.question, 2_000) &&
    /^\d{4}-\d{2}-\d{2}$/.test(asOfDate) &&
    !Number.isNaN(parsedDate.valueOf()) &&
    parsedDate.toISOString().slice(0, 10) === asOfDate;
}
