export const UUID_COMMAND_REQUEST_MAX_BYTES = 4 * 1024;
export const UUID_COMMAND_REQUEST_READ_TIMEOUT_MS = 5_000;

export type BoundedJsonRequestFailureKind =
  | "invalid_body"
  | "body_too_large"
  | "body_read_timeout";

/**
 * Stable request-body failure emitted before domain-specific validation.
 * Raw body data and parser errors are deliberately not retained.
 */
export class BoundedJsonRequestError extends Error {
  readonly kind: BoundedJsonRequestFailureKind;

  constructor(kind: BoundedJsonRequestFailureKind) {
    super("The JSON request body could not be consumed safely.");
    this.name = "BoundedJsonRequestError";
    this.kind = kind;
  }
}

function invalidBody() {
  return new BoundedJsonRequestError("invalid_body");
}

/**
 * Read JSON without accepting more than maxBytes of caller-controlled payload
 * into application-owned buffering. Content-Length is an early rejection
 * hint; streamed byte accounting remains authoritative for absent, chunked,
 * or dishonest length headers.
 */
export async function readBoundedJsonRequest(
  request: Request,
  options: { maxBytes?: number; readTimeoutMs?: number } = {},
): Promise<unknown> {
  const maxBytes = options.maxBytes ?? UUID_COMMAND_REQUEST_MAX_BYTES;
  const readTimeoutMs = options.readTimeoutMs ??
    UUID_COMMAND_REQUEST_READ_TIMEOUT_MS;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError(
      "A positive safe integer request-body limit is required.",
    );
  }
  if (!Number.isSafeInteger(readTimeoutMs) || readTimeoutMs < 1) {
    throw new TypeError(
      "A positive safe integer request-body read timeout is required.",
    );
  }
  if (request.bodyUsed || !request.body) throw invalidBody();

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) {
      void request.body.cancel().catch(() => undefined);
      throw invalidBody();
    }
    if (Number(contentLength) > maxBytes) {
      void request.body.cancel().catch(() => undefined);
      throw new BoundedJsonRequestError("body_too_large");
    }
  }

  const reader = request.body.getReader();
  const bytes = new Uint8Array(maxBytes);
  let totalBytes = 0;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    deadlineTimer = setTimeout(() => {
      reject(new BoundedJsonRequestError("body_read_timeout"));
    }, readTimeoutMs);
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      if (!(value instanceof Uint8Array)) throw invalidBody();
      if (value.byteLength > maxBytes - totalBytes) {
        throw new BoundedJsonRequestError("body_too_large");
      }
      bytes.set(value, totalBytes);
      totalBytes += value.byteLength;
    }

    if (totalBytes === 0) throw invalidBody();

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, totalBytes),
      );
    } catch {
      throw invalidBody();
    }

    try {
      return JSON.parse(text);
    } catch {
      throw invalidBody();
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    if (error instanceof BoundedJsonRequestError) throw error;
    throw invalidBody();
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    try {
      reader.releaseLock();
    } catch {
      // A failed or cancelled reader can already have released its lock.
    }
  }
}
