export class InletError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "InletError";
  }
}

export class VerificationError extends InletError {
  constructor(message: string, code = "invalid_signature") {
    super(message, 401, code);
    this.name = "VerificationError";
  }
}

export class PayloadError extends InletError {
  constructor(message: string, code = "invalid_payload") {
    super(message, 400, code);
    this.name = "PayloadError";
  }
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}
