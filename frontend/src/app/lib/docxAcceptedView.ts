import { XMLParser } from "fast-xml-parser";
import JSZip from "jszip";

/**
 * A small browser-safe projection of the DOCX accepted view used by Vera's
 * Word matcher. Insertions remain visible, deletions remain invisible, and
 * body paragraphs stay in document order. Keeping this in the client lets a
 * Playbook citation be re-located against the same readable view the model
 * and Word review flow use, without adding another API endpoint.
 */

type XNode = Record<string, unknown>;

const ATTR_KEY = ":@";
const TEXT_KEY = "#text";
const BODY_CONTAINERS = new Set([
    "w:tbl",
    "w:tr",
    "w:tc",
    "w:sdt",
    "w:sdtContent",
]);

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

function elementName(node: unknown): string | null {
    if (!node || typeof node !== "object") return null;
    for (const key of Object.keys(node as XNode)) {
        if (key !== ATTR_KEY && key !== TEXT_KEY) return key;
    }
    return null;
}

function childElements(node: unknown): XNode[] {
    const name = elementName(node);
    if (!name) return [];
    const children = (node as XNode)[name];
    return Array.isArray(children) ? (children as XNode[]) : [];
}

function isTextNode(node: unknown): node is { [TEXT_KEY]: string } {
    return (
        !!node &&
        typeof node === "object" &&
        TEXT_KEY in (node as XNode) &&
        elementName(node) === null
    );
}

function textContent(textElement: XNode): string {
    return childElements(textElement)
        .filter(isTextNode)
        .map((child) => String(child[TEXT_KEY] ?? ""))
        .join("");
}

function flattenRun(run: XNode): string {
    return childElements(run)
        .filter((child) => elementName(child) === "w:t")
        .map(textContent)
        .join("");
}

function flattenParagraph(children: XNode[]): string {
    let text = "";
    for (const child of children) {
        const name = elementName(child);
        if (name === "w:r") {
            text += flattenRun(child);
        } else if (name === "w:ins") {
            // Accepted view exposes insertion runs as ordinary document text.
            for (const insertedChild of childElements(child)) {
                if (elementName(insertedChild) === "w:r") {
                    text += flattenRun(insertedChild);
                }
            }
        }
        // w:del is intentionally omitted: it is not part of accepted view.
    }
    return text;
}

function documentBodyChildren(tree: XNode[]): XNode[] | null {
    for (const topLevel of tree) {
        if (elementName(topLevel) !== "w:document") continue;
        for (const child of childElements(topLevel)) {
            if (elementName(child) === "w:body") return childElements(child);
        }
    }
    return null;
}

function collectAcceptedParagraphs(nodes: XNode[], lines: string[]): void {
    for (const node of nodes) {
        const name = elementName(node);
        if (name === "w:p") {
            lines.push(flattenParagraph(childElements(node)));
        } else if (name && BODY_CONTAINERS.has(name)) {
            collectAcceptedParagraphs(childElements(node), lines);
        }
    }
}

/**
 * Extract the accepted body view from document.xml. Exported separately for
 * deterministic parser coverage without requiring a browser or a zip fixture.
 */
export function extractAcceptedDocxTextFromDocumentXml(xml: string): string {
    const tree = createParser().parse(xml) as XNode[];
    const body = documentBodyChildren(tree);
    if (!body) return "";
    const lines: string[] = [];
    collectAcceptedParagraphs(body, lines);
    return lines.join("\n");
}

/**
 * Read the current, cited DOCX version in the same accepted-view semantics
 * used by the backend's Word matcher. It does not inspect headers, footers,
 * comments, or unrelated package parts.
 */
export async function extractAcceptedDocxText(
    bytes: ArrayBuffer,
): Promise<string> {
    const zip = await JSZip.loadAsync(bytes);
    const documentXml =
        zip.file("word/document.xml") ?? zip.file("word\\document.xml");
    if (!documentXml) return "";
    return extractAcceptedDocxTextFromDocumentXml(
        await documentXml.async("string"),
    );
}
