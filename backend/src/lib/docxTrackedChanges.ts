/**
 * DOCX tracked-changes helpers.
 *
 * `applyTrackedEdits` rewrites a .docx so that the requested substitutions
 * appear as `<w:ins>` / `<w:del>` tracked changes rather than direct text
 * replacements. `resolveTrackedChange` accepts or rejects one change by
 * its `w:id`, producing a new .docx with only that change collapsed.
 *
 * Only text inside `<w:p><w:r><w:t>` is considered. Headers, footers,
 * comments, footnotes are left alone. Pre-existing tracked changes in the
 * paragraph are presented to the matcher in *accepted view*: w:ins runs are
 * treated as normal text, w:del wrappers are invisible. When a new edit's
 * range lands on runs inside a pre-existing w:ins, the wrapper is dropped
 * (accepting that insertion) before the new change is emitted.
 */

import JSZip from "jszip";
import { XMLParser, XMLBuilder } from "fast-xml-parser";
import fastDiff from "fast-diff";

// ---------------------------------------------------------------------------
// JSZip path helpers
// ---------------------------------------------------------------------------
//
// Some older Windows/Word archives store entries with backslash path
// separators (e.g. `word\document.xml`) even though the zip spec requires
// forward slashes. JSZip looks up entries by exact string, so
// `zip.file("word/document.xml")` misses those files. These helpers accept
// the canonical forward-slash form and transparently fall back to the
// backslash variant for both reads and writes.

function getZipEntry(zip: JSZip, pathSlash: string) {
    const direct = zip.file(pathSlash);
    if (direct) return direct;
    return zip.file(pathSlash.replace(/\//g, "\\"));
}

function setZipEntry(
    zip: JSZip,
    pathSlash: string,
    content: string | Buffer,
): void {
    const backslash = pathSlash.replace(/\//g, "\\");
    // If the archive already stores the entry under backslashes, keep it
    // there so we don't emit both variants side by side.
    if (!zip.file(pathSlash) && zip.file(backslash)) {
        zip.file(backslash, content);
        return;
    }
    zip.file(pathSlash, content);
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EditInput {
    find: string;
    replace: string;
    context_before: string;
    context_after: string;
    reason?: string;
}

export interface AppliedChange {
    id: string;
    delId?: string;
    insId?: string;
    deletedText: string;
    insertedText: string;
    contextBefore: string;
    contextAfter: string;
    reason?: string;
}

export interface EditError {
    index: number;
    reason: string;
}

export interface ApplyTrackedEditsResult {
    bytes: Buffer;
    changes: AppliedChange[];
    errors: EditError[];
}

export interface DocxCommentInput {
    anchor: string;
    comment: string;
    reason?: string;
}

export interface AppliedDocxComment {
    id: string;
    anchorText: string;
    comment: string;
    reason?: string;
}

export interface ApplyDocxCommentsResult {
    bytes: Buffer;
    comments: AppliedDocxComment[];
    errors: EditError[];
}

export interface DocxRevisionMarkup {
    kind: "insertion" | "deletion";
    id: string | null;
    author: string | null;
    date: string | null;
    text: string;
    paragraphIndex: number;
    finalStart: number;
    finalEnd: number;
}

export interface DocxCommentMarkup {
    kind: "comment";
    id: string;
    author: string | null;
    date: string | null;
    text: string;
    anchorText: string;
    paragraphStart: number | null;
    paragraphEnd: number | null;
    finalStart: number | null;
    finalEnd: number | null;
}

export type DocxReviewMarkupItem = DocxRevisionMarkup | DocxCommentMarkup;

export interface DocxReviewMarkupResult {
    /** Accepted/final text, byte-for-byte equivalent to extractDocxBodyText. */
    finalText: string;
    items: DocxReviewMarkupItem[];
}

/**
 * The current review UI and verifier deliberately model markup in the main
 * document story only. A generated clean contract must never claim to have
 * resolved markup in headers, footers, footnotes, or endnotes that those
 * surfaces cannot yet verify. This is a narrow preflight for the Contract
 * Playbook clean-copy bridge, not a second DOCX review model.
 */
export async function docxReviewMarkupOutsideMainStory(
    bytes: Buffer,
): Promise<string[]> {
    const zip = await JSZip.loadAsync(bytes);
    const storyPaths = Object.keys(zip.files).filter((path) =>
        /^word\/(?:header\d+|footer\d+|footnotes|endnotes)\.xml$/i.test(
            path.replace(/\\/g, "/"),
        ),
    );
    const markup = /<w:(?:ins|del|commentRangeStart|commentRangeEnd|commentReference)\b/i;
    const affected: string[] = [];
    for (const path of storyPaths) {
        const entry = zip.file(path);
        if (!entry) {
            throw new Error(`DOCX review story is unavailable: ${path}`);
        }
        if (markup.test(await entry.async("string"))) {
            affected.push(path.replace(/\\/g, "/"));
        }
    }
    return affected.sort();
}

// ---------------------------------------------------------------------------
// Preserve-order tree helpers
// ---------------------------------------------------------------------------

type XNode = Record<string, unknown>;

const ATTR_KEY = ":@";
const TEXT_KEY = "#text";

function elName(n: unknown): string | null {
    if (!n || typeof n !== "object") return null;
    for (const k of Object.keys(n as XNode)) {
        if (k === ATTR_KEY || k === TEXT_KEY) continue;
        return k;
    }
    return null;
}

function isTextNode(n: unknown): n is { [TEXT_KEY]: string } {
    if (!n || typeof n !== "object") return false;
    const obj = n as XNode;
    return TEXT_KEY in obj && elName(n) === null;
}

function elChildren(n: unknown): XNode[] {
    const name = elName(n);
    if (!name) return [];
    const v = (n as XNode)[name];
    return Array.isArray(v) ? (v as XNode[]) : [];
}

function setChildren(n: XNode, children: XNode[]): void {
    const name = elName(n);
    if (!name) return;
    n[name] = children;
}

function elAttrs(n: unknown): Record<string, string> {
    if (!n || typeof n !== "object") return {};
    const a = (n as XNode)[ATTR_KEY];
    return (a as Record<string, string>) ?? {};
}

function makeEl(
    name: string,
    children: XNode[] = [],
    attrs?: Record<string, string>,
): XNode {
    const el: XNode = { [name]: children };
    if (attrs) {
        const attrObj: Record<string, string> = {};
        for (const [k, v] of Object.entries(attrs)) {
            attrObj[`@_${k}`] = v;
        }
        el[ATTR_KEY] = attrObj;
    }
    return el;
}

function makeText(s: string): XNode {
    return { [TEXT_KEY]: s };
}

function getTextContent(wtEl: XNode): string {
    // A w:t node has only a single text child (or nothing).
    const kids = elChildren(wtEl);
    let out = "";
    for (const k of kids) {
        if (isTextNode(k)) out += String(k[TEXT_KEY] ?? "");
    }
    return out;
}

// Build a w:r element that wraps a piece of text. Newlines in the text are
// emitted as <w:br/> soft line breaks (interleaved with w:t/w:delText
// segments) so models can request multi-line replacements without the
// literal "\n" showing up as visible text.
function buildRun(rPr: XNode | null, text: string, tagName: "w:t" | "w:delText"): XNode {
    const children: XNode[] = [];
    if (rPr) children.push(cloneNode(rPr));
    const segments = text.split("\n");
    for (let i = 0; i < segments.length; i++) {
        if (i > 0) children.push(makeEl("w:br", []));
        const seg = segments[i];
        if (seg.length > 0) {
            children.push(
                makeEl(tagName, [makeText(seg)], { "xml:space": "preserve" }),
            );
        }
    }
    return makeEl("w:r", children);
}

function cloneNode<T>(n: T): T {
    return JSON.parse(JSON.stringify(n)) as T;
}

// ---------------------------------------------------------------------------
// Paragraph flattening
// ---------------------------------------------------------------------------

interface RunSlot {
    childIndex: number;         // index in paragraph.children
    rPr: XNode | null;          // reference (not cloned)
    /**
     * Per-w:t info. Slots preserve the relative order of the run's textual
     * children. Non-textual run children (w:tab, w:br, ...) are ignored for
     * the char stream but left in place via their surrounding w:r.
     */
    textNodes: { wtEl: XNode; text: string; paraStart: number; paraEnd: number }[];
}

interface Flattened {
    paraText: string;
    // For each char index in paraText: which run slot + which textNode + offset within text
    charRun: Int32Array;      // runIdx
    charTextNode: Int32Array; // index into slot.textNodes
    charOffset: Int32Array;   // offset within that textNode.text
    runs: RunSlot[];          // order corresponds to their paragraph position
}

function flattenParagraph(paraChildren: XNode[]): Flattened {
    const runs: RunSlot[] = [];
    let paraText = "";
    const charRunArr: number[] = [];
    const charTextNodeArr: number[] = [];
    const charOffsetArr: number[] = [];

    const processRun = (rEl: XNode, topChildIdx: number) => {
        const rKids = elChildren(rEl);
        let rPr: XNode | null = null;
        const textNodes: RunSlot["textNodes"] = [];
        for (const rk of rKids) {
            const name = elName(rk);
            if (name === "w:rPr") {
                rPr = rk;
            } else if (name === "w:t") {
                const txt = getTextContent(rk);
                const start = paraText.length;
                textNodes.push({
                    wtEl: rk,
                    text: txt,
                    paraStart: start,
                    paraEnd: start + txt.length,
                });
                const runIdx = runs.length;
                const tnIdx = textNodes.length - 1;
                paraText += txt;
                for (let i = 0; i < txt.length; i++) {
                    charRunArr.push(runIdx);
                    charTextNodeArr.push(tnIdx);
                    charOffsetArr.push(i);
                }
            }
            // other run children (w:tab, w:br, w:sym, …) are left alone
        }
        runs.push({ childIndex: topChildIdx, rPr, textNodes });
    };

    for (let ci = 0; ci < paraChildren.length; ci++) {
        const child = paraChildren[ci];
        const name = elName(child);
        if (name === "w:r") {
            processRun(child, ci);
        } else if (name === "w:ins") {
            // Accepted view: include inner runs as if bare. childIndex points
            // at the w:ins wrapper so reconstruction can drop the wrapper
            // whole when a new edit touches any of these runs.
            for (const inner of elChildren(child)) {
                if (elName(inner) === "w:r") processRun(inner, ci);
            }
        }
        // w:del: skip entirely — accepted view excludes deleted text.
    }

    return {
        paraText,
        charRun: Int32Array.from(charRunArr),
        charTextNode: Int32Array.from(charTextNodeArr),
        charOffset: Int32Array.from(charOffsetArr),
        runs,
    };
}

// ---------------------------------------------------------------------------
// Planning edits on a paragraph
// ---------------------------------------------------------------------------

/**
 * A single logical change. Spans a contiguous [start, end) character range in
 * the paragraph text (may be empty for a pure insert) and may carry an
 * inserted string appended at `start`.
 */
interface PlannedChange {
    editIndex: number;            // source edit index
    deleteStart: number;          // paragraph text offset (inclusive)
    deleteEnd: number;            // paragraph text offset (exclusive); may equal start
    deletedText: string;          // substring of paraText in [start, end)
    insertedText: string;         // may be empty
    contextBefore: string;
    contextAfter: string;
    reason?: string;
    changeId: string;             // logical id (not the w:id)
    delWId?: string;              // w:id of w:del wrapper (if deletedText non-empty)
    insWId?: string;              // w:id of w:ins wrapper (if insertedText non-empty)
}

/**
 * Collapse a `fast-diff` result into a minimal `{deletedText, insertedText}`
 * tuple anchored at a single start position. `fast-diff` produces
 * sequences like EQ-DEL-EQ-INS. For tracked-change UI we want one
 * "replace this substring with that substring" card per edit, so we
 * merge everything into the outer span.
 */
function collapseDiff(find: string, replace: string): { deleted: string; inserted: string; leadingEq: number; trailingEq: number } {
    // Find leading/trailing common substrings so the tracked range is minimal
    let leading = 0;
    const minLen = Math.min(find.length, replace.length);
    while (leading < minLen && find[leading] === replace[leading]) leading++;
    let trailing = 0;
    while (
        trailing < minLen - leading &&
        find[find.length - 1 - trailing] === replace[replace.length - 1 - trailing]
    ) {
        trailing++;
    }
    const deleted = find.slice(leading, find.length - trailing);
    const inserted = replace.slice(leading, replace.length - trailing);
    return { deleted, inserted, leadingEq: leading, trailingEq: trailing };
}

// ---------------------------------------------------------------------------
// Paragraph reconstruction
// ---------------------------------------------------------------------------

/**
 * Given a paragraph's children and a sorted, non-overlapping list of
 * `PlannedChange`s that fall within it, return a new children array with
 * tracked changes inserted.
 */
function reconstructParagraph(
    paraChildren: XNode[],
    flat: Flattened,
    plan: PlannedChange[],
    now: string,
    author: string,
): XNode[] {
    if (plan.length === 0) return paraChildren;

    // Determine the run-index span that edits touch.
    let firstRunIdx = flat.runs.length;
    let lastRunIdx = -1;
    for (const p of plan) {
        for (let pos = p.deleteStart; pos < p.deleteEnd; pos++) {
            const r = flat.charRun[pos];
            if (r < firstRunIdx) firstRunIdx = r;
            if (r > lastRunIdx) lastRunIdx = r;
        }
        // Also include the run to the left/right of a pure insertion so we
        // can inherit its rPr.
        if (p.deleteStart === p.deleteEnd && p.deleteStart < flat.paraText.length) {
            const r = flat.charRun[p.deleteStart];
            if (r < firstRunIdx) firstRunIdx = r;
            if (r > lastRunIdx) lastRunIdx = r;
        } else if (p.deleteStart === p.deleteEnd && p.deleteStart > 0) {
            const r = flat.charRun[p.deleteStart - 1];
            if (r < firstRunIdx) firstRunIdx = r;
            if (r > lastRunIdx) lastRunIdx = r;
        }
    }
    if (firstRunIdx > lastRunIdx) {
        // No runs touched (edits against empty paragraph?) — nothing to do.
        return paraChildren;
    }

    // Child-index range in paragraph.children we are going to replace.
    const startChildIdx = flat.runs[firstRunIdx].childIndex;
    const endChildIdx = flat.runs[lastRunIdx].childIndex;

    // Paragraph-text range that this run span covers.
    const firstRun = flat.runs[firstRunIdx];
    const lastRun = flat.runs[lastRunIdx];
    const spanStart =
        firstRun.textNodes.length > 0 ? firstRun.textNodes[0].paraStart : 0;
    const spanEnd =
        lastRun.textNodes.length > 0
            ? lastRun.textNodes[lastRun.textNodes.length - 1].paraEnd
            : spanStart;

    // Walk [spanStart, spanEnd) in paraText, producing a new children array.
    const newRunGroup: XNode[] = [];

    // Helper: get the rPr for the run containing paragraph offset `pos`
    // (clamped to the touched span). Used to inherit formatting for
    // insertions that fall exactly on a boundary.
    const rPrForPos = (pos: number): XNode | null => {
        if (pos < 0) pos = 0;
        if (pos >= flat.paraText.length) pos = flat.paraText.length - 1;
        if (pos < 0) return firstRun.rPr;
        return flat.runs[flat.charRun[pos]].rPr;
    };

    // Emit a "normal" run fragment covering [a, b) of paraText, grouping
    // consecutive chars that belong to the same source text node.
    const emitNormal = (a: number, b: number) => {
        if (a >= b) return;
        let i = a;
        while (i < b) {
            const runIdx = flat.charRun[i];
            const tnIdx = flat.charTextNode[i];
            let j = i + 1;
            while (
                j < b &&
                flat.charRun[j] === runIdx &&
                flat.charTextNode[j] === tnIdx
            ) {
                j++;
            }
            const slot = flat.runs[runIdx];
            const rPr = slot.rPr;
            const slice = flat.paraText.slice(i, j);
            newRunGroup.push(buildRun(rPr, slice, "w:t"));
            i = j;
        }
    };

    // Emit a w:del wrapping run fragments covering [a, b) of paraText.
    const emitDel = (a: number, b: number, wId: string) => {
        if (a >= b) return;
        const inner: XNode[] = [];
        let i = a;
        while (i < b) {
            const runIdx = flat.charRun[i];
            const tnIdx = flat.charTextNode[i];
            let j = i + 1;
            while (
                j < b &&
                flat.charRun[j] === runIdx &&
                flat.charTextNode[j] === tnIdx
            ) {
                j++;
            }
            const slot = flat.runs[runIdx];
            const slice = flat.paraText.slice(i, j);
            inner.push(buildRun(slot.rPr, slice, "w:delText"));
            i = j;
        }
        newRunGroup.push(
            makeEl("w:del", inner, {
                "w:id": wId,
                "w:author": author,
                "w:date": now,
            }),
        );
    };

    // Emit a w:ins at position `pos` inheriting rPr from there.
    const emitIns = (pos: number, text: string, wId: string) => {
        if (!text) return;
        const rPr = rPrForPos(pos === spanEnd ? pos - 1 : pos);
        const run = buildRun(rPr, text, "w:t");
        newRunGroup.push(
            makeEl("w:ins", [run], {
                "w:id": wId,
                "w:author": author,
                "w:date": now,
            }),
        );
    };

    let cursor = spanStart;
    for (const p of plan) {
        // Untouched slice before this edit
        emitNormal(cursor, p.deleteStart);
        // Insertion fires at the edit boundary
        if (p.insertedText) emitIns(p.deleteStart, p.insertedText, p.insWId!);
        // Deletion wraps the span
        if (p.deleteEnd > p.deleteStart)
            emitDel(p.deleteStart, p.deleteEnd, p.delWId!);
        cursor = p.deleteEnd;
    }
    emitNormal(cursor, spanEnd);

    // Replace only the w:r children that the edits touch; preserve any other
    // interleaved elements (bookmarks, existing tracked-changes, w:sdt …) at
    // their original positions.
    const droppedChildIdx = new Set<number>();
    for (let r = firstRunIdx; r <= lastRunIdx; r++) {
        droppedChildIdx.add(flat.runs[r].childIndex);
    }
    // Any w:del wrappers that sit inside the span we're rewriting are also
    // dropped, which accepts their deletions (their text is already absent
    // from paraText in the accepted view).
    for (let i = startChildIdx; i <= endChildIdx; i++) {
        if (elName(paraChildren[i]) === "w:del") droppedChildIdx.add(i);
    }
    const firstDroppedIdx = startChildIdx;
    void endChildIdx;
    const out: XNode[] = [];
    for (let i = 0; i < paraChildren.length; i++) {
        if (i === firstDroppedIdx) {
            for (const n of newRunGroup) out.push(n);
        }
        if (droppedChildIdx.has(i)) continue;
        out.push(paraChildren[i]);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Locating context in the document
// ---------------------------------------------------------------------------

interface ParagraphRef {
    paraNode: XNode;
    paraChildren: XNode[];
    flat: Flattened;
    globalStart: number; // where this paragraph starts in the full doc text
}

function indexAll(hay: string, needle: string): number[] {
    if (!needle) return [];
    const out: number[] = [];
    let i = 0;
    while (i <= hay.length - needle.length) {
        const j = hay.indexOf(needle, i);
        if (j < 0) break;
        out.push(j);
        i = j + 1;
    }
    return out;
}

// --- Whitespace / punctuation normalization for anchor matching -------------
// The text LLMs see (via mammoth's extractRawText) does not line up 1:1 with
// the raw w:t concatenation: smart quotes, non-breaking spaces, tabs, and
// runs of whitespace all differ. We normalize both haystack and needle to
// a canonical form for matching, then map matched offsets back to the
// original paragraph text.

function preNormalize(s: string): string {
    // All 1-to-1 character replacements — preserves length for straightforward
    // index mapping.
    return s
        .replace(/[\u2018\u2019\u2032]/g, "'")
        .replace(/[\u201C\u201D\u2033]/g, '"')
        .replace(/[\u2013\u2014]/g, "-")
        .replace(/\u00A0/g, " ")
        .replace(/\u200B/g, " ");
}

interface Normalized {
    norm: string;
    // origIdx[i] = index in the *original* string for norm[i]
    origIdx: number[];
}

function normalizeWs(input: string): Normalized {
    const s = preNormalize(input);
    const norm: string[] = [];
    const origIdx: number[] = [];
    let prevSpace = false;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (/\s/.test(ch)) {
            if (!prevSpace) {
                norm.push(" ");
                origIdx.push(i);
                prevSpace = true;
            }
        } else {
            norm.push(ch);
            origIdx.push(i);
            prevSpace = false;
        }
    }
    return { norm: norm.join(""), origIdx };
}

/**
 * Locate the unique position in `hayNorm` where `findNorm` appears AND is
 * preceded by `ctxBeforeNorm` AND followed by `ctxAfterNorm`. The context
 * check uses direct string-slice equality rather than concatenation so
 * boundary-whitespace collapsing doesn't matter. Returns the normalized
 * [start, end) range of the `find` portion, or a structured error.
 */
function findUniqueAnchor(
    hayNorm: string,
    findNorm: string,
    ctxBeforeNorm: string,
    ctxAfterNorm: string,
): { start: number; end: number } | { error: "none" | "ambiguous" } {
    const candidates: number[] = [];

    const checkCtx = (pos: number): boolean => {
        if (ctxBeforeNorm) {
            const start = pos - ctxBeforeNorm.length;
            if (start < 0) return false;
            if (hayNorm.slice(start, pos) !== ctxBeforeNorm) return false;
        }
        if (ctxAfterNorm) {
            const end = pos + findNorm.length;
            if (hayNorm.slice(end, end + ctxAfterNorm.length) !== ctxAfterNorm)
                return false;
        }
        return true;
    };

    if (findNorm.length === 0) {
        // Pure insertion — scan every position
        for (let i = 0; i <= hayNorm.length; i++) {
            if (checkCtx(i)) candidates.push(i);
        }
    } else {
        let from = 0;
        while (from <= hayNorm.length - findNorm.length) {
            const idx = hayNorm.indexOf(findNorm, from);
            if (idx < 0) break;
            if (checkCtx(idx)) candidates.push(idx);
            from = idx + 1;
        }
    }

    if (candidates.length === 0) return { error: "none" };
    if (candidates.length > 1) return { error: "ambiguous" };
    return {
        start: candidates[0],
        end: candidates[0] + findNorm.length,
    };
}

/** Map a normalized [start, end) range back to the original string range. */
function mapNormRangeToOriginal(
    paraNorm: Normalized,
    origLen: number,
    normStart: number,
    normEnd: number,
): { start: number; end: number } {
    const origStart =
        normStart < paraNorm.origIdx.length
            ? paraNorm.origIdx[normStart]
            : origLen;
    const origEnd =
        normEnd === normStart
            ? origStart
            : normEnd - 1 < paraNorm.origIdx.length
              ? paraNorm.origIdx[normEnd - 1] + 1
              : origLen;
    return { start: origStart, end: origEnd };
}

// ---------------------------------------------------------------------------
// Main: applyTrackedEdits
// ---------------------------------------------------------------------------

const W_NS_ATTRS: Record<string, string> = {
    "xmlns:w":
        "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
};

function createParser() {
    return new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: "@_",
        preserveOrder: true,
        trimValues: false,
        parseAttributeValue: false,
        processEntities: true,
    });
}

function createBuilder() {
    return new XMLBuilder({
        ignoreAttributes: false,
        attributeNamePrefix: "@_",
        preserveOrder: true,
        suppressEmptyNode: false,
        processEntities: true,
    });
}

function findBody(doc: XNode[]): XNode[] | null {
    for (const top of doc) {
        if (elName(top) === "w:document") {
            for (const c of elChildren(top)) {
                if (elName(c) === "w:body") return elChildren(c);
            }
        }
    }
    return null;
}

function replaceBody(doc: XNode[], bodyChildren: XNode[]): void {
    for (const top of doc) {
        if (elName(top) !== "w:document") continue;
        const docKids = elChildren(top);
        for (const c of docKids) {
            if (elName(c) === "w:body") setChildren(c, bodyChildren);
        }
    }
}

/**
 * Walk a tree and collect all max w:id values in w:ins/w:del so new changes
 * can start their numbering safely above it.
 */
function maxTrackedId(doc: XNode[]): number {
    let max = 0;
    const visit = (n: unknown) => {
        const name = elName(n);
        if (!name) return;
        if (name === "w:ins" || name === "w:del") {
            const a = elAttrs(n);
            const raw = a["@_w:id"];
            if (raw != null) {
                const v = parseInt(String(raw), 10);
                if (Number.isFinite(v) && v > max) max = v;
            }
        }
        for (const c of elChildren(n as XNode)) visit(c);
    };
    for (const top of doc) visit(top);
    return max;
}

/**
 * Extract the body text of a .docx using the same flattening rules as the
 * tracked-changes matcher. Paragraphs are joined by a single newline. The
 * output is what the LLM should base its `find` / `context_before` /
 * `context_after` strings on, since it exactly mirrors the string the
 * anchor matcher operates against.
 */
export async function extractDocxBodyText(bytes: Buffer): Promise<string> {
    const zip = await JSZip.loadAsync(bytes);
    const docXmlFile = getZipEntry(zip, "word/document.xml");
    if (!docXmlFile) return "";
    const docXmlRaw = await docXmlFile.async("string");
    const parser = createParser();
    const tree = parser.parse(docXmlRaw) as XNode[];
    const bodyChildren = findBody(tree);
    if (!bodyChildren) return "";

    const lines: string[] = [];
    const collect = (nodes: XNode[]) => {
        for (const n of nodes) {
            const name = elName(n);
            if (!name) continue;
            if (name === "w:p") {
                const flat = flattenParagraph(elChildren(n));
                lines.push(flat.paraText);
            } else if (
                name === "w:tbl" ||
                name === "w:tr" ||
                name === "w:tc" ||
                name === "w:sdt" ||
                name === "w:sdtContent"
            ) {
                collect(elChildren(n));
            }
        }
    };
    collect(bodyChildren);
    return lines.join("\n");
}

function descendantText(node: XNode, textElement: "w:t" | "w:delText"): string {
    let out = "";
    const visit = (current: XNode) => {
        if (elName(current) === textElement) {
            out += getTextContent(current);
            return;
        }
        for (const child of elChildren(current)) visit(child);
    };
    visit(node);
    return out;
}

function commentText(comment: XNode): string {
    const paragraphs: string[] = [];
    const visit = (nodes: XNode[]) => {
        for (const node of nodes) {
            const name = elName(node);
            if (!name) continue;
            if (name === "w:p") {
                paragraphs.push(flattenParagraph(elChildren(node)).paraText);
            } else {
                visit(elChildren(node));
            }
        }
    };
    visit(elChildren(comment));
    return paragraphs.join("\n");
}

function readComments(tree: XNode[]): Map<string, DocxCommentMarkup> {
    const comments = new Map<string, DocxCommentMarkup>();
    const visit = (nodes: XNode[]) => {
        for (const node of nodes) {
            if (elName(node) === "w:comment") {
                const attrs = elAttrs(node);
                const rawId = attrs["@_w:id"];
                if (rawId == null) continue;
                const id = String(rawId);
                comments.set(id, {
                    kind: "comment",
                    id,
                    author: attrs["@_w:author"] ?? null,
                    date: attrs["@_w:date"] ?? null,
                    text: commentText(node),
                    anchorText: "",
                    paragraphStart: null,
                    paragraphEnd: null,
                    finalStart: null,
                    finalEnd: null,
                });
                continue;
            }
            visit(elChildren(node));
        }
    };
    visit(tree);
    return comments;
}

/**
 * Extract tracked insertions, deletions, and classic OOXML comments without
 * changing the accepted/final text used by read_document and edit anchors.
 *
 * The first version intentionally follows extractDocxBodyText's body-only
 * paragraph traversal. Comment replies/commentsExtended and markup in
 * headers, footers, footnotes, or text boxes remain out of scope.
 */
export async function extractDocxReviewMarkup(
    bytes: Buffer,
): Promise<DocxReviewMarkupResult> {
    const zip = await JSZip.loadAsync(bytes);
    const docXmlFile = getZipEntry(zip, "word/document.xml");
    if (!docXmlFile) return { finalText: "", items: [] };

    const parser = createParser();
    const documentTree = parser.parse(
        await docXmlFile.async("string"),
    ) as XNode[];
    const bodyChildren = findBody(documentTree);
    if (!bodyChildren) return { finalText: "", items: [] };

    const commentsFile = getZipEntry(zip, "word/comments.xml");
    const comments = commentsFile
        ? readComments(
              parser.parse(await commentsFile.async("string")) as XNode[],
          )
        : new Map<string, DocxCommentMarkup>();
    const activeComments = new Map<string, DocxCommentMarkup>();
    const revisions: DocxRevisionMarkup[] = [];
    const lines: string[] = [];
    let finalOffset = 0;
    let paragraphIndex = 0;

    const appendToActiveComments = (text: string) => {
        if (!text) return;
        for (const comment of activeComments.values()) {
            comment.anchorText += text;
        }
    };

    const collect = (nodes: XNode[]) => {
        for (const node of nodes) {
            const name = elName(node);
            if (!name) continue;
            if (name === "w:p") {
                if (lines.length > 0) {
                    finalOffset += 1;
                    appendToActiveComments("\n");
                }
                const flat = flattenParagraph(elChildren(node));
                lines.push(flat.paraText);
                let paragraphOffset = 0;

                for (const child of elChildren(node)) {
                    const childName = elName(child);
                    if (childName === "w:commentRangeStart") {
                        const id = elAttrs(child)["@_w:id"];
                        const comment = id == null ? undefined : comments.get(String(id));
                        if (comment) {
                            comment.paragraphStart = paragraphIndex;
                            comment.finalStart = finalOffset + paragraphOffset;
                            activeComments.set(comment.id, comment);
                        }
                        continue;
                    }
                    if (childName === "w:commentRangeEnd") {
                        const id = elAttrs(child)["@_w:id"];
                        const comment = id == null ? undefined : activeComments.get(String(id));
                        if (comment) {
                            comment.paragraphEnd = paragraphIndex;
                            comment.finalEnd = finalOffset + paragraphOffset;
                            activeComments.delete(comment.id);
                        }
                        continue;
                    }
                    if (childName === "w:del") {
                        revisions.push({
                            kind: "deletion",
                            id: elAttrs(child)["@_w:id"] ?? null,
                            author: elAttrs(child)["@_w:author"] ?? null,
                            date: elAttrs(child)["@_w:date"] ?? null,
                            text: descendantText(child, "w:delText"),
                            paragraphIndex,
                            finalStart: finalOffset + paragraphOffset,
                            finalEnd: finalOffset + paragraphOffset,
                        });
                        continue;
                    }

                    let visibleText = "";
                    if (childName === "w:ins") {
                        visibleText = descendantText(child, "w:t");
                        revisions.push({
                            kind: "insertion",
                            id: elAttrs(child)["@_w:id"] ?? null,
                            author: elAttrs(child)["@_w:author"] ?? null,
                            date: elAttrs(child)["@_w:date"] ?? null,
                            text: visibleText,
                            paragraphIndex,
                            finalStart: finalOffset + paragraphOffset,
                            finalEnd:
                                finalOffset + paragraphOffset + visibleText.length,
                        });
                    } else if (childName === "w:r") {
                        visibleText = descendantText(child, "w:t");
                    }

                    appendToActiveComments(visibleText);
                    paragraphOffset += visibleText.length;
                }

                // The existing accepted-view flattener is authoritative. Keep
                // global offsets aligned even if an unsupported run child was
                // ignored by the review-markup walker above.
                finalOffset += flat.paraText.length;
                paragraphIndex += 1;
            } else if (
                name === "w:tbl" ||
                name === "w:tr" ||
                name === "w:tc" ||
                name === "w:sdt" ||
                name === "w:sdtContent"
            ) {
                collect(elChildren(node));
            }
        }
    };
    collect(bodyChildren);

    const items: DocxReviewMarkupItem[] = [
        ...revisions,
        ...comments.values(),
    ];
    items.sort((left, right) => {
        const leftStart = left.finalStart ?? Number.MAX_SAFE_INTEGER;
        const rightStart = right.finalStart ?? Number.MAX_SAFE_INTEGER;
        return leftStart - rightStart;
    });
    return { finalText: lines.join("\n"), items };
}

/**
 * Walk document.xml in render order and collect the w:id for every
 * w:ins / w:del wrapper. The order here matches what docx-preview emits
 * as <ins>/<del> in the DOM, so the frontend can tag each rendered
 * element by index to recover the w:id attribute that docx-preview drops.
 */
export async function extractTrackedChangeIds(
    bytes: Buffer,
): Promise<{ kind: "ins" | "del"; w_id: string }[]> {
    const zip = await JSZip.loadAsync(bytes);
    const docXmlFile = getZipEntry(zip, "word/document.xml");
    if (!docXmlFile) return [];
    const docXmlRaw = await docXmlFile.async("string");
    const parser = createParser();
    const tree = parser.parse(docXmlRaw) as XNode[];
    const out: { kind: "ins" | "del"; w_id: string }[] = [];
    const visit = (n: unknown) => {
        const name = elName(n);
        if (!name) return;
        if (name === "w:ins" || name === "w:del") {
            const a = elAttrs(n);
            const raw = a["@_w:id"];
            if (raw != null) {
                out.push({
                    kind: name === "w:ins" ? "ins" : "del",
                    w_id: String(raw),
                });
            }
        }
        for (const c of elChildren(n as XNode)) visit(c);
    };
    for (const top of tree) visit(top);
    return out;
}

export async function applyTrackedEdits(
    bytes: Buffer,
    edits: EditInput[],
    opts?: { author?: string },
): Promise<ApplyTrackedEditsResult> {
    const author = opts?.author ?? "Mike";
    const now = new Date().toISOString();

    const zip = await JSZip.loadAsync(bytes);
    const docXmlFile = getZipEntry(zip, "word/document.xml");
    if (!docXmlFile) throw new Error("document.xml missing from docx");
    const docXmlRaw = await docXmlFile.async("string");

    const parser = createParser();
    const tree = parser.parse(docXmlRaw) as XNode[];

    const bodyChildren = findBody(tree);
    if (!bodyChildren) throw new Error("w:body missing from document.xml");

    // Build paragraph table (only w:p at the top level of the body — does not
    // recurse into tables; for tables, w:p also appears inside w:tbl > w:tr >
    // w:tc so we need to traverse deeper).
    const paragraphs: ParagraphRef[] = [];
    const collectParagraphs = (nodes: XNode[]) => {
        for (const n of nodes) {
            const name = elName(n);
            if (!name) continue;
            if (name === "w:p") {
                const kids = elChildren(n);
                const flat = flattenParagraph(kids);
                paragraphs.push({
                    paraNode: n,
                    paraChildren: kids,
                    flat,
                    globalStart: 0, // set below
                });
            } else if (name === "w:tbl" || name === "w:tr" || name === "w:tc" || name === "w:sdt" || name === "w:sdtContent") {
                collectParagraphs(elChildren(n));
            }
        }
    };
    collectParagraphs(bodyChildren);

    // Assign global offsets (paragraphs joined by "\n" so context can
    // straddle a paragraph boundary, though edits themselves must stay
    // inside a single paragraph).
    {
        let off = 0;
        for (const p of paragraphs) {
            p.globalStart = off;
            off += p.flat.paraText.length + 1; // +1 for synthetic separator
        }
    }

    // Precompute normalized forms per paragraph for reuse across edits.
    const paraNorms: Normalized[] = paragraphs.map((p) =>
        normalizeWs(p.flat.paraText),
    );

    let nextWId = maxTrackedId(tree) + 1;
    const plansPerParagraph = new Map<number, PlannedChange[]>();
    const appliedChanges: AppliedChange[] = [];
    const errors: EditError[] = [];

    for (let editIdx = 0; editIdx < edits.length; editIdx++) {
        const edit = edits[editIdx];
        const find = edit.find ?? "";
        const replace = edit.replace ?? "";
        const ctxBefore = edit.context_before ?? "";
        const ctxAfter = edit.context_after ?? "";

        if (!find && !replace) {
            errors.push({ index: editIdx, reason: "Empty edit." });
            continue;
        }
        if (!find && !ctxBefore && !ctxAfter) {
            errors.push({
                index: editIdx,
                reason: "Pure insertion requires context_before or context_after.",
            });
            continue;
        }

        const findNorm = normalizeWs(find).norm;
        const ctxBeforeNorm = normalizeWs(ctxBefore).norm;
        const ctxAfterNorm = normalizeWs(ctxAfter).norm;

        // Strategy:
        //   1) find + full context  (strictest — preferred)
        //   2) find + half context  (drop whichever context side is shorter)
        //   3) find alone           (only if globally unique across doc)
        // At each stage we scan every paragraph. "Unique across the doc"
        // means exactly one paragraph yields exactly one match.
        type Hit = { paraIdx: number; normStart: number; normEnd: number };

        /**
         * Search every paragraph with the given context sides. If any
         * paragraph returns a match AND no paragraph is internally ambiguous,
         * return the collected hits; otherwise signal ambiguous.
         */
        const tryStrategy = (
            cb: string,
            ca: string,
        ): { kind: "ok"; hits: Hit[] } | { kind: "ambiguous" } => {
            const hits: Hit[] = [];
            let ambiguous = false;
            for (let pi = 0; pi < paragraphs.length; pi++) {
                const r = findUniqueAnchor(
                    paraNorms[pi].norm,
                    findNorm,
                    cb,
                    ca,
                );
                if ("error" in r) {
                    if (r.error === "ambiguous") ambiguous = true;
                    continue;
                }
                hits.push({ paraIdx: pi, normStart: r.start, normEnd: r.end });
            }
            if (ambiguous || hits.length > 1) return { kind: "ambiguous" };
            return { kind: "ok", hits };
        };

        let selected: Hit | null = null;
        const attempts = [
            { cb: ctxBeforeNorm, ca: ctxAfterNorm },
            { cb: ctxBeforeNorm, ca: "" },
            { cb: "", ca: ctxAfterNorm },
            { cb: "", ca: "" }, // find-only
        ];
        let sawAmbiguous = false;
        for (const { cb, ca } of attempts) {
            const r = tryStrategy(cb, ca);
            if (r.kind === "ambiguous") {
                sawAmbiguous = true;
                continue;
            }
            if (r.hits.length === 1) {
                selected = r.hits[0];
                break;
            }
        }

        if (!selected) {
            errors.push({
                index: editIdx,
                reason: sawAmbiguous
                    ? `Ambiguous match for find="${truncate(find, 80)}". Add longer context_before / context_after so the anchor is unique.`
                    : `Could not locate find="${truncate(find, 80)}" in the document. Re-read the document and copy context verbatim (including punctuation & whitespace).`,
            });
            continue;
        }

        const hit = selected;
        const paraIdx = hit.paraIdx;
        const paraNorm = paraNorms[paraIdx];
        const origLen = paragraphs[paraIdx].flat.paraText.length;
        const { start: findStart, end: findEnd } = mapNormRangeToOriginal(
            paraNorm,
            origLen,
            hit.normStart,
            hit.normEnd,
        );

        // Use the actual original text in that range as `deletedText` —
        // this preserves the document's whitespace/quote style rather than
        // the normalized needle the LLM provided.
        const originalFind = paragraphs[paraIdx].flat.paraText.slice(
            findStart,
            findEnd,
        );

        const { deleted, inserted, leadingEq } = collapseDiff(
            originalFind,
            replace,
        );
        const minStart = findStart + leadingEq;
        const minEnd = minStart + deleted.length;
        void findEnd;

        const changeId = `mike-${editIdx}-${Date.now()}`;
        const plan: PlannedChange = {
            editIndex: editIdx,
            deleteStart: minStart,
            deleteEnd: minEnd,
            deletedText: deleted,
            insertedText: inserted,
            contextBefore: edit.context_before ?? "",
            contextAfter: edit.context_after ?? "",
            reason: edit.reason,
            changeId,
            delWId: deleted ? String(nextWId++) : undefined,
            insWId: inserted ? String(nextWId++) : undefined,
        };

        // Check for overlap with earlier plans in the same paragraph.
        const existing = plansPerParagraph.get(paraIdx) ?? [];
        const overlap = existing.some(
            (p) => !(plan.deleteEnd <= p.deleteStart || plan.deleteStart >= p.deleteEnd),
        );
        if (overlap) {
            errors.push({
                index: editIdx,
                reason: "Overlaps a previous edit in the same paragraph.",
            });
            continue;
        }

        existing.push(plan);
        existing.sort((a, b) => a.deleteStart - b.deleteStart);
        plansPerParagraph.set(paraIdx, existing);

        appliedChanges.push({
            id: changeId,
            delId: plan.delWId,
            insId: plan.insWId,
            deletedText: plan.deletedText,
            insertedText: plan.insertedText,
            contextBefore: plan.contextBefore,
            contextAfter: plan.contextAfter,
            reason: plan.reason,
        });
    }

    // Apply plans per paragraph.
    for (const [paraIdx, plan] of plansPerParagraph) {
        const p = paragraphs[paraIdx];
        const newKids = reconstructParagraph(
            p.paraChildren,
            p.flat,
            plan,
            now,
            author,
        );
        setChildren(p.paraNode, newKids);
    }

    const builder = createBuilder();
    const rebuiltXml = builder.build(tree);
    const withDecl = ensureXmlDeclaration(rebuiltXml);
    setZipEntry(zip, "word/document.xml", withDecl);

    const outBuf = await zip.generateAsync({
        type: "nodebuffer",
        compression: "DEFLATE",
    });
    return { bytes: outBuf, changes: appliedChanges, errors };
}

interface PlannedComment {
    inputIndex: number;
    start: number;
    end: number;
    id: string;
    anchorText: string;
    comment: string;
    reason?: string;
}

function reconstructParagraphWithComments(paraChildren: XNode[], flat: Flattened, plans: PlannedComment[]): XNode[] {
    if (!plans.length) return paraChildren;
    let firstRunIdx = flat.runs.length;
    let lastRunIdx = -1;
    for (const plan of plans) {
        for (let pos = plan.start; pos < plan.end; pos++) {
            const run = flat.charRun[pos];
            if (run < firstRunIdx) firstRunIdx = run;
            if (run > lastRunIdx) lastRunIdx = run;
        }
    }
    if (firstRunIdx > lastRunIdx) return paraChildren;

    const startChildIdx = flat.runs[firstRunIdx].childIndex;
    const endChildIdx = flat.runs[lastRunIdx].childIndex;
    const firstRun = flat.runs[firstRunIdx];
    const lastRun = flat.runs[lastRunIdx];
    const spanStart = firstRun.textNodes[0]?.paraStart ?? 0;
    const spanEnd = lastRun.textNodes[lastRun.textNodes.length - 1]?.paraEnd ?? spanStart;
    const newRunGroup: XNode[] = [];
    const emitNormal = (start: number, end: number) => {
        let cursor = start;
        while (cursor < end) {
            const runIndex = flat.charRun[cursor];
            const textNodeIndex = flat.charTextNode[cursor];
            let next = cursor + 1;
            while (next < end && flat.charRun[next] === runIndex && flat.charTextNode[next] === textNodeIndex) {
                next += 1;
            }
            const slot = flat.runs[runIndex];
            newRunGroup.push(buildRun(slot.rPr, flat.paraText.slice(cursor, next), "w:t"));
            cursor = next;
        }
    };

    let cursor = spanStart;
    for (const plan of plans) {
        emitNormal(cursor, plan.start);
        newRunGroup.push(makeEl("w:commentRangeStart", [], { "w:id": plan.id }));
        emitNormal(plan.start, plan.end);
        newRunGroup.push(makeEl("w:commentRangeEnd", [], { "w:id": plan.id }), makeEl("w:commentReference", [], { "w:id": plan.id }));
        cursor = plan.end;
    }
    emitNormal(cursor, spanEnd);

    const droppedChildIndices = new Set<number>();
    for (let run = firstRunIdx; run <= lastRunIdx; run += 1) {
        droppedChildIndices.add(flat.runs[run].childIndex);
    }
    const output: XNode[] = [];
    for (let index = 0; index < paraChildren.length; index += 1) {
        if (index === startChildIdx) output.push(...newRunGroup);
        if (droppedChildIndices.has(index)) continue;
        output.push(paraChildren[index]);
    }
    void endChildIdx;
    return output;
}

function appendRootChild(tree: XNode[], rootName: string, child: XNode) {
    const root = tree.find((node) => elName(node) === rootName);
    if (!root) throw new Error(`${rootName} missing from OOXML part`);
    const children = elChildren(root);
    children.push(child);
    setChildren(root, children);
}

function numericIds(tree: XNode[], elementNames: Set<string>) {
    const ids: number[] = [];
    const visit = (nodes: XNode[]) => {
        for (const node of nodes) {
            if (elementNames.has(elName(node) ?? "")) {
                const value = Number.parseInt(elAttrs(node)["@_w:id"] ?? "", 10);
                if (Number.isFinite(value) && value >= 0) ids.push(value);
            }
            visit(elChildren(node));
        }
    };
    visit(tree);
    return ids;
}

/**
 * Add classic Word comments to unique, continuous exact spans in the main
 * document story. The function deliberately rejects ambiguous, overlapping,
 * or already-reviewed anchors. It never guesses a paragraph or comments on
 * text inside a pending insertion.
 */
export async function applyDocxComments(bytes: Buffer, comments: DocxCommentInput[], opts?: { author?: string; initials?: string; date?: string }): Promise<ApplyDocxCommentsResult> {
    if (!comments.length) {
        return { bytes, comments: [], errors: [] };
    }
    const author = opts?.author?.trim() || "Vera";
    const initials = opts?.initials?.trim() || "V";
    const date = opts?.date ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(date))) {
        throw new Error("DOCX comment date must be an ISO timestamp");
    }

    const zip = await JSZip.loadAsync(bytes);
    const documentFile = getZipEntry(zip, "word/document.xml");
    if (!documentFile) throw new Error("document.xml missing from docx");
    const parser = createParser();
    const builder = createBuilder();
    const documentTree = parser.parse(await documentFile.async("string")) as XNode[];
    const bodyChildren = findBody(documentTree);
    if (!bodyChildren) throw new Error("w:body missing from document.xml");

    const paragraphs: ParagraphRef[] = [];
    const collectParagraphs = (nodes: XNode[]) => {
        for (const node of nodes) {
            const name = elName(node);
            if (name === "w:p") {
                const children = elChildren(node);
                paragraphs.push({
                    paraNode: node,
                    paraChildren: children,
                    flat: flattenParagraph(children),
                    globalStart: 0,
                });
            } else if (name === "w:tbl" || name === "w:tr" || name === "w:tc" || name === "w:sdt" || name === "w:sdtContent") {
                collectParagraphs(elChildren(node));
            }
        }
    };
    collectParagraphs(bodyChildren);
    const paragraphNorms = paragraphs.map((paragraph) => normalizeWs(paragraph.flat.paraText));

    const existingCommentsFile = getZipEntry(zip, "word/comments.xml");
    const commentsTree = existingCommentsFile
        ? (parser.parse(await existingCommentsFile.async("string")) as XNode[])
        : [
              makeEl("w:comments", [], {
                  "xmlns:w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
              }),
          ];
    const usedIds = [...numericIds(documentTree, new Set(["w:commentRangeStart", "w:commentRangeEnd"])), ...numericIds(commentsTree, new Set(["w:comment"]))];
    let nextCommentId = (usedIds.length ? Math.max(...usedIds) : -1) + 1;
    const plansByParagraph = new Map<number, PlannedComment[]>();
    const applied: AppliedDocxComment[] = [];
    const errors: EditError[] = [];

    for (const [inputIndex, input] of comments.entries()) {
        const anchor = input.anchor?.trim() ?? "";
        const comment = input.comment?.trim() ?? "";
        if (!anchor || !comment) {
            errors.push({
                index: inputIndex,
                reason: "A DOCX comment requires a non-empty anchor and body.",
            });
            continue;
        }
        const anchorNorm = normalizeWs(anchor).norm;
        const hits: Array<{ paragraphIndex: number; start: number; end: number }> = [];
        let internallyAmbiguous = false;
        for (const [paragraphIndex, paragraph] of paragraphs.entries()) {
            const match = findUniqueAnchor(paragraphNorms[paragraphIndex].norm, anchorNorm, "", "");
            if ("error" in match) {
                if (match.error === "ambiguous") internallyAmbiguous = true;
                continue;
            }
            const original = mapNormRangeToOriginal(paragraphNorms[paragraphIndex], paragraph.flat.paraText.length, match.start, match.end);
            hits.push({
                paragraphIndex,
                start: original.start,
                end: original.end,
            });
        }
        if (internallyAmbiguous || hits.length !== 1) {
            errors.push({
                index: inputIndex,
                reason: internallyAmbiguous || hits.length > 1 ? "Comment anchor is ambiguous in the document." : "Comment anchor was not found in the document.",
            });
            continue;
        }
        const hit = hits[0];
        const paragraph = paragraphs[hit.paragraphIndex];
        const touchedChildIndices = new Set<number>();
        for (let position = hit.start; position < hit.end; position += 1) {
            touchedChildIndices.add(paragraph.flat.runs[paragraph.flat.charRun[position]].childIndex);
        }
        const touchesPendingInsertion = [...touchedChildIndices].some((index) => elName(paragraph.paraChildren[index]) === "w:ins");
        const firstChild = Math.min(...touchedChildIndices);
        const lastChild = Math.max(...touchedChildIndices);
        const touchesExistingComment = paragraph.paraChildren.slice(firstChild, lastChild + 1).some((node) => ["w:commentRangeStart", "w:commentRangeEnd", "w:commentReference"].includes(elName(node) ?? ""));
        const existingPlans = plansByParagraph.get(hit.paragraphIndex) ?? [];
        const overlaps = existingPlans.some((plan) => !(hit.end <= plan.start || hit.start >= plan.end));
        if (touchesPendingInsertion || touchesExistingComment || overlaps) {
            errors.push({
                index: inputIndex,
                reason: touchesPendingInsertion ? "Comment anchor touches a pending insertion." : touchesExistingComment ? "Comment anchor touches existing review markup." : "Comment anchor overlaps another planned comment.",
            });
            continue;
        }
        const id = String(nextCommentId++);
        const plan: PlannedComment = {
            inputIndex,
            start: hit.start,
            end: hit.end,
            id,
            anchorText: paragraph.flat.paraText.slice(hit.start, hit.end),
            comment,
            reason: input.reason,
        };
        existingPlans.push(plan);
        existingPlans.sort((left, right) => left.start - right.start);
        plansByParagraph.set(hit.paragraphIndex, existingPlans);
        applied.push({
            id,
            anchorText: plan.anchorText,
            comment,
            reason: input.reason,
        });
    }

    if (!applied.length) {
        return { bytes, comments: [], errors };
    }

    for (const [paragraphIndex, plans] of plansByParagraph) {
        const paragraph = paragraphs[paragraphIndex];
        setChildren(paragraph.paraNode, reconstructParagraphWithComments(paragraph.paraChildren, paragraph.flat, plans));
        for (const plan of plans) {
            appendRootChild(
                commentsTree,
                "w:comments",
                makeEl(
                    "w:comment",
                    [
                        makeEl("w:p", [
                            makeEl("w:r", [
                                makeEl("w:t", [makeText(plan.comment)], {
                                    "xml:space": "preserve",
                                }),
                            ]),
                        ]),
                    ],
                    {
                        "w:id": plan.id,
                        "w:initials": initials,
                        "w:author": author,
                        "w:date": date,
                    },
                ),
            );
        }
    }

    setZipEntry(zip, "word/document.xml", ensureXmlDeclaration(builder.build(documentTree)));
    setZipEntry(zip, "word/comments.xml", ensureXmlDeclaration(builder.build(commentsTree)));

    const relationshipsPath = "word/_rels/document.xml.rels";
    const relationshipsFile = getZipEntry(zip, relationshipsPath);
    if (!relationshipsFile) {
        throw new Error("document.xml.rels missing from docx");
    }
    const relationshipsTree = parser.parse(await relationshipsFile.async("string")) as XNode[];
    const relationshipState = (() => {
        let commentsTarget: string | null = null;
        const ids = new Set<string>();
        const visit = (nodes: XNode[]) => {
            for (const node of nodes) {
                if (elName(node) === "Relationship") {
                    const attrs = elAttrs(node);
                    if (attrs["@_Id"]) ids.add(attrs["@_Id"]);
                    if (/\/comments$/i.test(attrs["@_Type"] ?? "")) {
                        commentsTarget = attrs["@_Target"] ?? "";
                    }
                }
                visit(elChildren(node));
            }
        };
        visit(relationshipsTree);
        return { commentsTarget, ids };
    })();
    if (relationshipState.commentsTarget !== null && !/(?:^|\/)comments\.xml$/i.test(relationshipState.commentsTarget)) {
        throw new Error("Existing DOCX comments relationship does not target comments.xml");
    }
    if (relationshipState.commentsTarget === null) {
        let relationshipId = "rIdVeraComments";
        let suffix = 1;
        while (relationshipState.ids.has(relationshipId)) {
            relationshipId = `rIdVeraComments${suffix++}`;
        }
        appendRootChild(
            relationshipsTree,
            "Relationships",
            makeEl("Relationship", [], {
                Id: relationshipId,
                Type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments",
                Target: "comments.xml",
            }),
        );
        setZipEntry(zip, relationshipsPath, ensureXmlDeclaration(builder.build(relationshipsTree)));
    }

    const contentTypesPath = "[Content_Types].xml";
    const contentTypesFile = getZipEntry(zip, contentTypesPath);
    if (!contentTypesFile) throw new Error("[Content_Types].xml missing from docx");
    const contentTypesTree = parser.parse(await contentTypesFile.async("string")) as XNode[];
    const hasCommentContentType = (() => {
        let found = false;
        const visit = (nodes: XNode[]) => {
            for (const node of nodes) {
                if (elName(node) === "Override" && /^\/word\/comments\.xml$/i.test(elAttrs(node)["@_PartName"] ?? "")) {
                    found = true;
                }
                visit(elChildren(node));
            }
        };
        visit(contentTypesTree);
        return found;
    })();
    if (!hasCommentContentType) {
        appendRootChild(
            contentTypesTree,
            "Types",
            makeEl("Override", [], {
                PartName: "/word/comments.xml",
                ContentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml",
            }),
        );
        setZipEntry(zip, contentTypesPath, ensureXmlDeclaration(builder.build(contentTypesTree)));
    }

    return {
        bytes: Buffer.from(
            await zip.generateAsync({
                type: "nodebuffer",
                compression: "DEFLATE",
            }),
        ),
        comments: applied,
        errors,
    };
}

// ---------------------------------------------------------------------------
// Resolve a single tracked change (Accept or Reject)
// ---------------------------------------------------------------------------

/**
 * Walk the XML tree and transform matching w:ins/w:del wrappers for the
 * given change id. Returns { found, updatedTree }.
 */
function resolveInTree(
    doc: XNode[],
    changeIds: string[],
    mode: "accept" | "reject",
): { found: boolean } {
    const ids = new Set(changeIds.map((s) => String(s)));
    let touched = false;

    const rewrite = (parentKids: XNode[]): XNode[] => {
        const out: XNode[] = [];
        for (const n of parentKids) {
            const name = elName(n);
            if (!name) {
                out.push(n);
                continue;
            }

            // Recurse first so nested tables/sdts get processed
            const kids = elChildren(n);
            if (kids.length) {
                const newKids = rewrite(kids);
                if (newKids !== kids) setChildren(n, newKids);
            }

            if (name === "w:ins" || name === "w:del") {
                const a = elAttrs(n);
                const wId = String(a["@_w:id"] ?? "");
                if (ids.has(wId)) {
                    touched = true;
                    if (
                        (name === "w:ins" && mode === "accept") ||
                        (name === "w:del" && mode === "reject")
                    ) {
                        // Keep children, drop wrapper. For w:del rejected, we
                        // also need to convert inner w:delText → w:t so the
                        // text reverts to normal body content.
                        const inner =
                            name === "w:del"
                                ? (elChildren(n) as XNode[]).map(unwrapDelText)
                                : (elChildren(n) as XNode[]);
                        for (const c of inner) out.push(c);
                        continue;
                    } else {
                        // accept-del / reject-ins → drop the wrapper and its
                        // inner runs entirely.
                        continue;
                    }
                }
            }

            out.push(n);
        }
        return out;
    };

    for (const top of doc) {
        if (elName(top) !== "w:document") continue;
        const docKids = elChildren(top);
        setChildren(top, rewrite(docKids));
    }

    return { found: touched };
}

function unwrapDelText(n: XNode): XNode {
    const name = elName(n);
    if (!name) return n;
    if (name === "w:r") {
        const kids = elChildren(n).map(unwrapDelText);
        setChildren(n, kids);
        return n;
    }
    if (name === "w:delText") {
        const attrs = elAttrs(n);
        return {
            "w:t": elChildren(n),
            ...(Object.keys(attrs).length ? { [ATTR_KEY]: attrs } : {}),
        };
    }
    return n;
}

export async function resolveTrackedChange(
    bytes: Buffer,
    changeIds: string[],
    mode: "accept" | "reject",
): Promise<{ bytes: Buffer; found: boolean }> {
    const zip = await JSZip.loadAsync(bytes);
    const docXmlFile = getZipEntry(zip, "word/document.xml");
    if (!docXmlFile) throw new Error("document.xml missing from docx");
    const docXmlRaw = await docXmlFile.async("string");

    const parser = createParser();
    const tree = parser.parse(docXmlRaw) as XNode[];

    const { found } = resolveInTree(tree, changeIds, mode);

    const builder = createBuilder();
    const rebuilt = ensureXmlDeclaration(builder.build(tree));
    setZipEntry(zip, "word/document.xml", rebuilt);
    const out = await zip.generateAsync({
        type: "nodebuffer",
        compression: "DEFLATE",
    });
    return { bytes: out, found };
}

/**
 * Produce the clean accepted view of a DOCX after a model-authored edit.
 *
 * This is intentionally narrower than a general Word cleanup pipeline: it
 * accepts all tracked changes in the main document and removes Word comment
 * anchors/parts. It is used only when a declared deliverable is itself
 * required to be clean (for example, a Contract Playbook review opinion).
 * Contract revisions never use this helper.
 */
export async function finalizeCleanDocx(bytes: Buffer): Promise<Buffer> {
    const outsideMainStory = await docxReviewMarkupOutsideMainStory(bytes);
    if (outsideMainStory.length) {
        throw new Error(
            `DOCX review markup exists outside the main story: ${outsideMainStory.join(", ")}`,
        );
    }
    const trackedIds = Array.from(
        new Set(
            (await extractTrackedChangeIds(bytes)).map((item) => item.w_id),
        ),
    );
    const accepted = trackedIds.length
        ? (await resolveTrackedChange(bytes, trackedIds, "accept")).bytes
        : bytes;
    const zip = await JSZip.loadAsync(accepted);
    const parser = createParser();
    const builder = createBuilder();

    const stripCommentMarkers = (nodes: XNode[]): XNode[] =>
        nodes.flatMap((node) => {
            const name = elName(node);
            if (
                name === "w:commentRangeStart" ||
                name === "w:commentRangeEnd" ||
                name === "w:commentReference"
            ) {
                return [];
            }
            if (name) {
                setChildren(node, stripCommentMarkers(elChildren(node)));
            }
            return [node];
        });

    for (const path of Object.keys(zip.files)) {
        const canonicalPath = path.replace(/\\/g, "/");
        if (
            !/^word\/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml$/i.test(
                canonicalPath,
            )
        ) {
            continue;
        }
        const entry = zip.file(path);
        if (!entry) continue;
        const tree = parser.parse(await entry.async("string")) as XNode[];
        zip.file(
            path,
            ensureXmlDeclaration(
                builder.build(stripCommentMarkers(tree)),
            ),
        );
    }

    const commentPartPattern =
        /^word\/(?:comments(?:Extended|Ids)?|people)\.xml$/i;
    for (const path of Object.keys(zip.files)) {
        if (commentPartPattern.test(path.replace(/\\/g, "/"))) {
            zip.remove(path);
        }
    }

    const filterPackageReferences = async (
        path: string,
        shouldRemove: (attrs: Record<string, string>) => boolean,
    ) => {
        const entry = getZipEntry(zip, path);
        if (!entry) return;
        const filterTree = (nodes: XNode[]): XNode[] =>
            nodes.flatMap((node) => {
                if (shouldRemove(elAttrs(node))) return [];
                const name = elName(node);
                if (name) setChildren(node, filterTree(elChildren(node)));
                return [node];
            });
        const tree = parser.parse(await entry.async("string")) as XNode[];
        setZipEntry(
            zip,
            path,
            ensureXmlDeclaration(builder.build(filterTree(tree))),
        );
    };

    await filterPackageReferences(
        "word/_rels/document.xml.rels",
        (attrs) =>
            typeof attrs["@_Type"] === "string" &&
            /\/(?:comments|commentsExtended|commentsIds|people)$/i.test(
                attrs["@_Type"],
            ),
    );
    await filterPackageReferences(
        "[Content_Types].xml",
        (attrs) =>
            typeof attrs["@_PartName"] === "string" &&
            /^\/word\/(?:comments(?:Extended|Ids)?|people)\.xml$/i.test(
                attrs["@_PartName"],
            ),
    );

    return Buffer.from(
        await zip.generateAsync({
            type: "nodebuffer",
            compression: "DEFLATE",
        }),
    );
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function ensureXmlDeclaration(xml: string): string {
    if (xml.startsWith("<?xml")) return xml;
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${xml}`;
}

function truncate(s: string, n: number): string {
    if (!s) return "";
    return s.length > n ? s.slice(0, n) + "…" : s;
}

// Lightweight guards used elsewhere; exported for tests.
export const _internal = {
    flattenParagraph,
    collapseDiff,
    indexAll,
};

// Silence unused import if fastDiff is ever reintroduced for ranged matching.
// kept available in the file because the plan references it for future work.
export const _fastDiff = fastDiff;

// Suppress unused warning for W_NS_ATTRS (kept for potential future use when
// emitting standalone w:ins/w:del into parts without a namespace inheritance).
export const _nsAttrs = W_NS_ATTRS;
