/** Closed public Link failures; never expose ORM, runner config or secret errors. */
export class LinkResourceError extends Error {
  constructor(readonly code: string, readonly status: 400 | 403 | 404 | 409 | 503 = 409) {
    super(code); this.name = "LinkResourceError";
  }
}
