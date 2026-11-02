export class ChatError extends Error {
  constructor(public readonly code: string, public readonly status: number, message: string) {
    super(message);
  }
  static badRequest(code: string, msg: string) { return new ChatError(code, 400, msg); }
  static forbidden(code: string, msg: string) { return new ChatError(code, 403, msg); }
  static notFound(code: string, msg: string) { return new ChatError(code, 404, msg); }
  static conflict(code: string, msg: string) { return new ChatError(code, 409, msg); }
}
