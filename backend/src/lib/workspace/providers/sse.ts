import { abortError, ProviderProtocolError, type SseRecord } from "./types";

export const PROVIDER_STREAM_MAX_BYTES = 4 * 1024 * 1024;
export const PROVIDER_SSE_MAX_EVENT_BYTES = 256 * 1024;

function separator(buffer: string) {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf < 0) return crlf < 0 ? null : { index: crlf, length: 4 };
  if (crlf < 0 || lf < crlf) return { index: lf, length: 2 };
  return { index: crlf, length: 4 };
}

function parseBlock(block: string): SseRecord | null {
  if (Buffer.byteLength(block) > PROVIDER_SSE_MAX_EVENT_BYTES) {
    throw new ProviderProtocolError(
      "response_too_large",
      "Model provider stream event exceeded the allowed size.",
      false,
    );
  }
  let event: string | null = null;
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const rawValue = colon < 0 ? "" : line.slice(colon + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    if (field === "event") event = value.slice(0, 128);
    if (field === "data") data.push(value);
  }
  if (data.length === 0) return null;
  const payload = data.join("\n");
  if (payload === "[DONE]") return { event, data: null, done: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new ProviderProtocolError(
      "invalid_response",
      "Model provider returned malformed streaming data.",
      false,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ProviderProtocolError(
      "invalid_response",
      "Model provider returned an invalid streaming event.",
      false,
    );
  }
  return { event, data: parsed as Record<string, unknown>, done: false };
}

export async function* readBoundedJsonSse(
  response: Response,
  signal: AbortSignal,
): AsyncIterable<SseRecord> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^text\/event-stream(?:\s*;|$)/i.test(contentType)) {
    throw new ProviderProtocolError(
      "invalid_response",
      "Model provider did not return an event stream.",
      false,
    );
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > PROVIDER_STREAM_MAX_BYTES) {
    throw new ProviderProtocolError(
      "response_too_large",
      "Model provider response exceeded the allowed size.",
      false,
    );
  }
  if (!response.body) {
    throw new ProviderProtocolError(
      "invalid_response",
      "Model provider returned an empty stream.",
      false,
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let buffer = "";
  try {
    while (true) {
      if (signal.aborted) throw abortError();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > PROVIDER_STREAM_MAX_BYTES) {
        throw new ProviderProtocolError(
          "response_too_large",
          "Model provider response exceeded the allowed size.",
          false,
        );
      }
      try {
        buffer += decoder.decode(value, { stream: true });
      } catch {
        throw new ProviderProtocolError(
          "invalid_response",
          "Model provider stream was not valid UTF-8.",
          false,
        );
      }
      for (let next = separator(buffer); next; next = separator(buffer)) {
        const block = buffer.slice(0, next.index);
        buffer = buffer.slice(next.index + next.length);
        const record = parseBlock(block);
        if (record) yield record;
      }
      if (Buffer.byteLength(buffer) > PROVIDER_SSE_MAX_EVENT_BYTES) {
        throw new ProviderProtocolError(
          "response_too_large",
          "Model provider stream event exceeded the allowed size.",
          false,
        );
      }
    }
    try {
      buffer += decoder.decode();
    } catch {
      throw new ProviderProtocolError(
        "invalid_response",
        "Model provider stream was not valid UTF-8.",
        false,
      );
    }
    if (buffer.trim()) {
      const record = parseBlock(buffer);
      if (record) yield record;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The protocol or cancellation error remains authoritative.
    }
  }
}
