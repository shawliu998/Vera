export class BoundedResponseBodyError extends Error {
  constructor(
    readonly reason: "content_length" | "limit_exceeded" | "aborted",
    message: string,
  ) {
    super(message);
    this.name = "BoundedResponseBodyError";
  }
}

export async function readBoundedResponseBody(
  response: Response,
  maxBytes: number,
  options: { signal?: AbortSignal } = {},
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError(
      "Response body limit must be a positive safe integer.",
    );
  }
  if (!response.body) return "";
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body.cancel();
    throw new BoundedResponseBodyError(
      "content_length",
      "Response content-length exceeded the configured limit.",
    );
  }

  const reader = response.body.getReader();
  let aborted = false;
  let abortListener: (() => void) | null = null;
  if (options.signal) {
    if (options.signal.aborted) {
      aborted = true;
    } else {
      abortListener = () => {
        aborted = true;
        void reader.cancel().catch(() => {});
      };
      options.signal.addEventListener("abort", abortListener, { once: true });
    }
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    if (aborted) {
      await reader.cancel().catch(() => {});
      throw new BoundedResponseBodyError(
        "aborted",
        "Response body read was aborted.",
      );
    }
    while (true) {
      if (aborted) {
        throw new BoundedResponseBodyError(
          "aborted",
          "Response body read was aborted.",
        );
      }
      const { done, value } = await reader.read();
      if (aborted) {
        throw new BoundedResponseBodyError(
          "aborted",
          "Response body read was aborted.",
        );
      }
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new BoundedResponseBodyError(
          "limit_exceeded",
          "Response body exceeded the configured limit.",
        );
      }
      chunks.push(value);
    }
  } finally {
    if (abortListener && options.signal) {
      options.signal.removeEventListener("abort", abortListener);
    }
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(
    "utf8",
  );
}
