"use client";

import { useMemo, useState } from "react";
import { MessageSquareText, Search } from "lucide-react";
import {
  addAletheiaReview,
  approveAletheiaLegalQaAnswer,
  appendAletheiaAuditEvent,
  createAletheiaWorkProduct,
  resolveAletheiaReview,
  searchAletheiaMatterDocuments,
  type AletheiaDocumentSearchResult,
  type AletheiaMatterDetail,
} from "@/app/lib/aletheiaApi";
import {
  validateAnduParityContracts,
  type LegalQaArtifact,
} from "@/aletheia/agentops";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type LegalQaAuditDetails = {
  workpaperId?: string;
  legalQa?: LegalQaArtifact;
  validation?: Array<{ name?: string; status?: string }>;
};

async function sha256(value: string) {
  if (!globalThis.crypto?.subtle) {
    throw new Error("This browser cannot create the required source hash.");
  }
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return `sha256:${Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function draftFromSources(question: string, sources: AletheiaDocumentSearchResult[]) {
  const excerpts = sources.slice(0, 3).map((source, index) => {
    const location = [
      source.document_name,
      source.page ? `page ${source.page}` : null,
      source.section,
    ]
      .filter(Boolean)
      .join(" · ");
    return `[${index + 1}] ${location}\n${source.text.trim()}`;
  });
  return [
    `Preliminary answer to: ${question}`,
    "",
    "Relevant retained materials:",
    ...excerpts,
    "",
    "The retained materials above are the current source basis for this preliminary answer. They may be incomplete, conflicting, or insufficient for a final legal conclusion. A qualified reviewer must verify the source text, applicable law, factual assumptions, and scope before reliance.",
  ].join("\n");
}

function fallbackRetrievalTerms(question: string) {
  const stopWords = new Set([
    "a",
    "an",
    "are",
    "before",
    "can",
    "do",
    "does",
    "for",
    "how",
    "in",
    "is",
    "of",
    "or",
    "the",
    "to",
    "what",
    "when",
    "which",
    "who",
  ]);
  return question
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((word) => word.length > 2 && !stopWords.has(word))
    .slice(0, 8);
}

export function LegalQaPanel({
  matterId,
  detail,
  onPersisted,
}: {
  matterId: string;
  detail: AletheiaMatterDetail;
  onPersisted: () => Promise<void>;
}) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [sources, setSources] = useState<AletheiaDocumentSearchResult[]>([]);
  const [drafting, setDrafting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actingAnswerId, setActingAnswerId] = useState("");
  const [message, setMessage] = useState("");

  const persisted = useMemo(() => {
    const auditByWorkpaper = new Map<string, LegalQaAuditDetails>();
    for (const event of detail.auditEvents) {
      if (event.action !== "human_note.legal_qa_answer_persisted") continue;
      const audit = event.details as LegalQaAuditDetails;
      if (audit.workpaperId) auditByWorkpaper.set(audit.workpaperId, audit);
    }
    return detail.workProducts
      .filter((workProduct) => workProduct.kind === "legal_qa_answer")
      .map((workProduct) => ({
        workProduct,
        audit: auditByWorkpaper.get(workProduct.id),
        reviews: detail.reviews.filter(
          (review) => review.work_product_id === workProduct.id,
        ),
      }))
      .sort((left, right) =>
        right.workProduct.created_at.localeCompare(left.workProduct.created_at),
      );
  }, [detail.auditEvents, detail.reviews, detail.workProducts]);

  async function draftAnswer() {
    const normalizedQuestion = question.trim();
    setMessage("");
    if (!normalizedQuestion) {
      setMessage("A legal question is required.");
      return;
    }
    setDrafting(true);
    try {
      let results: AletheiaDocumentSearchResult[] = [];
      const ftsSafeQuestion = normalizedQuestion
        .replace(/[?*"':()\-]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      try {
        if (ftsSafeQuestion) {
          results = await searchAletheiaMatterDocuments(
            matterId,
            ftsSafeQuestion,
          );
        }
      } catch {
        // Natural-language punctuation is not always valid FTS5 syntax.
        results = [];
      }
      if (!results.length) {
        const fallbackTerms = fallbackRetrievalTerms(normalizedQuestion);
        const byChunkId = new Map<string, AletheiaDocumentSearchResult>();
        for (const term of fallbackTerms) {
          const matches = await searchAletheiaMatterDocuments(matterId, term);
          for (const match of matches) byChunkId.set(match.chunk_id, match);
          if (byChunkId.size >= 3) break;
        }
        results = Array.from(byChunkId.values());
      }
      if (!results.length) {
        results = detail.evidence
          .filter((evidence) => Boolean(evidence.source_chunk_id && evidence.quote.trim()))
          .map((evidence, index) => ({
            chunk_id: evidence.source_chunk_id as string,
            matter_id: matterId,
            document_id: evidence.document_id ?? evidence.id,
            document_name: evidence.document_name ?? "Retained evidence",
            text: evidence.quote,
            chunk_index: index,
            page: evidence.page,
            section: evidence.section,
            quote_start: evidence.quote_start ?? 0,
            quote_end: evidence.quote_end ?? evidence.quote.length,
            score: 0,
            retrieval_mode: "keyword" as const,
          }));
      }
      if (!results.length) {
        setSources([]);
        setAnswer("");
        setMessage("No retained matter sources matched this question.");
        return;
      }
      setSources(results.slice(0, 3));
      setAnswer(draftFromSources(normalizedQuestion, results));
      setMessage(`${Math.min(results.length, 3)} retained source chunk(s) prepared for review.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Legal Q&A draft could not be prepared.");
    } finally {
      setDrafting(false);
    }
  }

  async function saveAnswer() {
    const normalizedQuestion = question.trim();
    const normalizedAnswer = answer.trim();
    setMessage("");
    if (!normalizedQuestion || !normalizedAnswer || !sources.length) {
      setMessage("A question, sourced draft answer, and retained source are required.");
      return;
    }
    setSaving(true);
    try {
      const sourceHashes = await Promise.all(sources.map((source) => sha256(source.text)));
      const requestAudit = await appendAletheiaAuditEvent(matterId, {
        actor: "human",
        action: "human_note.legal_qa_draft_requested",
        workflowVersion: "hermes-legal-qa-v0",
        details: {
          question: normalizedQuestion,
          sourceChunkIds: sources.map((source) => source.chunk_id),
          retrievalMode: sources[0]?.retrieval_mode ?? "keyword",
          answerGeneratedLocally: true,
        },
      });
      const workpaper = await createAletheiaWorkProduct(matterId, {
        kind: "legal_qa_answer",
        title: `Legal Q&A: ${normalizedQuestion.slice(0, 160)}`,
        status: "needs_review",
        schemaVersion: "hermes-legal-qa-v0",
        generatedBy: "human",
        content: {
          schemaVersion: "hermes-legal-qa-v0",
          status: "needs_review",
          question: normalizedQuestion,
          answer: normalizedAnswer,
          sourceChunkIds: sources.map((source) => source.chunk_id),
          requestAuditEventId: requestAudit.id,
          professionalCaveat:
            "This is a source-grounded preliminary answer for human review, not final legal advice or a legal conclusion.",
        },
      });
      const review = await addAletheiaReview(matterId, {
        targetType: "work_product",
        targetId: workpaper.id,
        workProductId: workpaper.id,
        tag: "needs_human_judgment",
        comment:
          "Review source support, jurisdiction, factual assumptions, missing materials, and whether the preliminary legal answer is appropriately scoped.",
      });
      const legalQa: LegalQaArtifact = {
        id: `legal-qa:${workpaper.id}`,
        matter_id: matterId,
        question: normalizedQuestion,
        answer: normalizedAnswer,
        status: "needs_review",
        source_refs: sources.map((source, index) => ({
          id: source.chunk_id,
          type: "source_chunk",
          hash: sourceHashes[index],
          audit_event_id: requestAudit.id,
        })),
        review_comment_ids: [review.id],
        audit_event_ids: [requestAudit.id],
        professional_caveat:
          "Preliminary source-grounded answer only; human review is required before reliance.",
      };
      const validation = validateAnduParityContracts({ legalQaArtifacts: [legalQa] });
      if (validation.some((item) => item.status === "failed")) {
        throw new Error("Legal Q&A provenance validation failed before persistence.");
      }
      await appendAletheiaAuditEvent(matterId, {
        actor: "human",
        action: "human_note.legal_qa_answer_persisted",
        workflowVersion: "hermes-legal-qa-v0",
        details: {
          workpaperId: workpaper.id,
          reviewCommentId: review.id,
          requestAuditEventId: requestAudit.id,
          legalQa,
          validation,
        },
      });
      setQuestion("");
      setAnswer("");
      setSources([]);
      await onPersisted();
      setMessage(`Legal Q&A answer recorded (${workpaper.id}).`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Legal Q&A answer could not be recorded.");
    } finally {
      setSaving(false);
    }
  }

  async function acceptAnswerReview(reviewId: string) {
    setMessage("");
    setActingAnswerId(reviewId);
    try {
      await resolveAletheiaReview(matterId, reviewId, {
        status: "accepted",
        comment:
          "Reviewer accepted the cited source support and scope of this preliminary Legal Q&A answer.",
        createEvalCase: false,
      });
      await onPersisted();
      setMessage("Legal Q&A review accepted. Approval can proceed when all reviews are resolved.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Legal Q&A review could not be accepted.");
    } finally {
      setActingAnswerId("");
    }
  }

  async function approveAnswer(answerId: string) {
    setMessage("");
    setActingAnswerId(answerId);
    try {
      await approveAletheiaLegalQaAnswer(matterId, answerId);
      await onPersisted();
      setMessage("Legal Q&A answer approved.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Legal Q&A answer could not be approved.");
    } finally {
      setActingAnswerId("");
    }
  }

  return (
    <section data-testid="legal-qa-panel" className="rounded-lg border border-gray-200 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <MessageSquareText className="h-4 w-4 text-gray-700" />
            <h2 className="font-semibold text-gray-950">Legal Q&A</h2>
          </div>
          <p className="mt-1 text-sm text-gray-600">Local source-grounded drafts remain review-only until a qualified reviewer confirms scope and support.</p>
        </div>
        <Badge variant="outline" className="rounded-md border-gray-200 bg-gray-50 px-2 py-1 text-xs text-gray-600">
          {persisted.length} recorded
        </Badge>
      </div>
      <label className="mt-4 grid gap-1.5 text-xs font-medium text-gray-700">
        Question
        <textarea data-testid="legal-qa-question" value={question} onChange={(event) => setQuestion(event.target.value)} maxLength={2000} rows={3} className="resize-y rounded-md border border-gray-200 px-3 py-2 text-sm font-normal text-gray-900 outline-none focus:border-gray-400" />
      </label>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" data-testid="draft-legal-qa-answer" disabled={drafting || saving} onClick={() => void draftAnswer()}>
          <Search className="h-4 w-4" /> Draft from sources
        </Button>
        <Button type="button" size="sm" data-testid="record-legal-qa-answer" disabled={saving || drafting} onClick={() => void saveAnswer()}>
          <MessageSquareText className="h-4 w-4" /> Record answer
        </Button>
      </div>
      <label className="mt-3 grid gap-1.5 text-xs font-medium text-gray-700">
        Draft answer
        <textarea data-testid="legal-qa-answer" value={answer} onChange={(event) => setAnswer(event.target.value)} maxLength={12000} rows={9} className="resize-y rounded-md border border-gray-200 px-3 py-2 text-sm font-normal text-gray-900 outline-none focus:border-gray-400" />
      </label>
      {sources.length > 0 ? <p data-testid="legal-qa-source-count" className="mt-2 text-xs text-gray-500">{sources.length} retained source chunk{sources.length === 1 ? "" : "s"} attached.</p> : null}
      {message ? <p data-testid="legal-qa-status" className="mt-3 text-xs text-gray-600">{message}</p> : null}
      {persisted.length > 0 ? <div className="mt-5 grid gap-2 border-t border-gray-100 pt-4">{persisted.map(({ workProduct, audit, reviews }) => {
        const openReviews = reviews.filter((review) => review.resolution_status === "open");
        const accepted = workProduct.status === "accepted";
        return <div key={workProduct.id} data-testid="legal-qa-record" className="rounded-md border border-gray-100 bg-gray-50 p-3"><div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0"><p className="truncate text-sm font-medium text-gray-950">{audit?.legalQa?.question ?? workProduct.title}</p><p className="mt-1 text-xs text-gray-500">{reviews.length} review item{reviews.length === 1 ? "" : "s"} · {audit?.legalQa?.source_refs.length ?? 0} source chunk{(audit?.legalQa?.source_refs.length ?? 0) === 1 ? "" : "s"}</p></div><Badge variant="outline" className={accepted ? "rounded-md border-emerald-100 bg-emerald-50 px-2 py-1 text-xs text-emerald-700" : "rounded-md border-amber-100 bg-amber-50 px-2 py-1 text-xs text-amber-700"}>{workProduct.status.replaceAll("_", " ")}</Badge></div><p className="mt-2 line-clamp-3 whitespace-pre-wrap text-xs text-gray-600">{audit?.legalQa?.answer ?? "Answer retained in the workpaper."}</p>{!accepted ? <div className="mt-3 flex flex-wrap justify-end gap-2 border-t border-gray-200 pt-3">{openReviews.map((review) => <Button key={review.id} type="button" size="sm" variant="outline" data-testid={`accept-legal-qa-review-${review.id}`} disabled={Boolean(actingAnswerId)} onClick={() => void acceptAnswerReview(review.id)}>Accept review</Button>)}<Button type="button" size="sm" data-testid={`approve-legal-qa-${workProduct.id}`} disabled={Boolean(actingAnswerId) || openReviews.length > 0} onClick={() => void approveAnswer(workProduct.id)}>Approve answer</Button></div> : null}</div>;
      })}</div> : null}
    </section>
  );
}
