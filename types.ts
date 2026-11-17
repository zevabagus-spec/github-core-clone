// Shared plumbing: the error type handlers throw to answer an HTTP status
// with a JSON {message} body, and the two result shapes a route handler
// returns. app.ts owns serialization for both.

/** An error that maps directly onto an HTTP status plus a JSON message. */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export function notFound(message = 'Not Found'): HttpError {
  return new HttpError(404, message);
}

export function badRequest(message: string): HttpError {
  return new HttpError(400, message);
}

export function unprocessable(message: string): HttpError {
  return new HttpError(422, message);
}

export function conflict(message: string): HttpError {
  return new HttpError(409, message);
}

/**
 * A JSON result: status, a JSON-serializable body, optional extra headers.
 * When `body` is present it holds the exact response bytes (already
 * serialized JSON) and `json` is ignored and null: handlers serve a cached
 * serialization this way, skipping the object rebuild and stringify.
 */
export interface JsonResult {
  status: number;
  json: unknown;
  headers?: Record<string, string>;
  body?: Buffer;
}

/** A binary result (git smart HTTP): status, exact content type, raw bytes.
 * The content type is part of the wire contract: the suite checks it on
 * every git response, so handlers set it explicitly per service. */
export interface BinResult {
  status: number;
  contentType: string;
  body: Buffer;
}
