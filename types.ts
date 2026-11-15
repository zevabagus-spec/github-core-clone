// Shared plumbing: the HTTP error type handlers throw, and the two result
// shapes a route handler returns. app.ts serializes both.

/** An error that maps directly onto an HTTP status with a JSON {message} body. */
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

/** A JSON result: status, a JSON-serializable body, optional extra headers.
 * When `body` is present it holds the exact response bytes (already
 * serialized JSON) and `json` is ignored: handlers use it to serve a
 * cached serialization without rebuilding the object or stringifying it
 * again. `json` is then null. */
export interface JsonResult {
  status: number;
  json: unknown;
  headers?: Record<string, string>;
  body?: Buffer;
}

/** A binary result (git smart HTTP): status, exact content type, raw bytes. */
export interface BinResult {
  status: number;
  contentType: string;
  body: Buffer;
}
