export class GraphMcpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphMcpError";
  }
}

export class AuthenticationError extends GraphMcpError {
  constructor(message: string) {
    super(message);
    this.name = "AuthenticationError";
  }
}

export class GraphApiError extends GraphMcpError {
  readonly statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = "GraphApiError";
    if (statusCode !== undefined) {
      this.statusCode = statusCode;
    }
  }
}

export class RateLimitError extends GraphMcpError {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}
