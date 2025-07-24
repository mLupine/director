import { isNumber } from "lodash";

export type ExpressError = Error & {
  statusCode: number;
};

export class AppError extends Error {
  name = "AppError";

  constructor(
    public code: ErrorCode,
    message: string,
    public props: Record<string, unknown> = {},
  ) {
    super(message);
  }

  get isRetryable(): boolean {
    return [
      ErrorCode.CONNECTION_REFUSED,
      ErrorCode.NETWORK_ERROR,
      ErrorCode.TIMEOUT,
      ErrorCode.SERVER_ERROR,
      ErrorCode.RATE_LIMIT,
    ].includes(this.code);
  }

  get suggestedAction(): string | undefined {
    switch (this.code) {
      case ErrorCode.CONNECTION_REFUSED:
      case ErrorCode.NETWORK_ERROR:
        return "Check network connectivity and server availability";
      case ErrorCode.TIMEOUT:
        return "Increase timeout or check server performance";
      case ErrorCode.AUTHENTICATION_ERROR:
      case ErrorCode.UNAUTHORIZED:
        return "Check credentials and authentication configuration";
      case ErrorCode.AUTHORIZATION_ERROR:
        return "Check permissions and access rights";
      case ErrorCode.CONFIGURATION_ERROR:
        return "Check configuration settings and parameters";
      case ErrorCode.NOT_FOUND:
      case ErrorCode.FILE_NOT_FOUND:
      case ErrorCode.COMMAND_NOT_FOUND:
        return "Verify the resource exists and the path is correct";
      case ErrorCode.RATE_LIMIT:
        return "Reduce request frequency or wait before retrying";
      default:
        return undefined;
    }
  }

  static categorizeError(error: Error | string): ErrorCode {
    const errorMessage = typeof error === "string" ? error : error.message;

    // Network-related errors
    if (
      /(ECONNREFUSED|ENOTFOUND|ECONNRESET|EHOSTUNREACH|ENETUNREACH|fetch failed)/i.test(
        errorMessage,
      )
    ) {
      return ErrorCode.NETWORK_ERROR;
    }

    // Timeout errors
    if (/(timeout|timed out|ETIMEDOUT)/i.test(errorMessage)) {
      return ErrorCode.TIMEOUT;
    }

    // Authentication errors
    if (
      /(401|unauthorized|authentication|invalid credentials)/i.test(
        errorMessage,
      )
    ) {
      return ErrorCode.AUTHENTICATION_ERROR;
    }

    // Authorization errors
    if (/(403|forbidden|permission denied|access denied)/i.test(errorMessage)) {
      return ErrorCode.AUTHORIZATION_ERROR;
    }

    // Not found errors
    if (/(404|not found|ENOENT)/i.test(errorMessage)) {
      return ErrorCode.NOT_FOUND;
    }

    // Configuration errors
    if (
      /(invalid config|configuration error|missing required)/i.test(
        errorMessage,
      )
    ) {
      return ErrorCode.CONFIGURATION_ERROR;
    }

    // Rate limit errors
    if (/(429|rate limit|too many requests)/i.test(errorMessage)) {
      return ErrorCode.RATE_LIMIT;
    }

    // Server errors
    if (/(500|502|503|504|server error)/i.test(errorMessage)) {
      return ErrorCode.SERVER_ERROR;
    }

    // Client errors
    if (/(400|bad request|invalid request)/i.test(errorMessage)) {
      return ErrorCode.CLIENT_ERROR;
    }

    return ErrorCode.CONNECTION_REFUSED; // Default for unknown errors
  }
}

export enum ErrorCode {
  NOT_FOUND = "NOT_FOUND",
  COMMAND_NOT_FOUND = "COMMAND_NOT_FOUND",
  FILE_NOT_FOUND = "FILE_NOT_FOUND",
  BAD_REQUEST = "BAD_REQUEST",
  CONNECTION_REFUSED = "CONNECTION_REFUSED",
  UNAUTHORIZED = "UNAUTHORIZED",
  DUPLICATE = "DUPLICATE",
  JSON_PARSE_ERROR = "JSON_PARSE_ERROR",
  INVALID_ARGUMENT = "INVALID_ARGUMENT",
  NETWORK_ERROR = "NETWORK_ERROR",
  TIMEOUT = "TIMEOUT",
  AUTHENTICATION_ERROR = "AUTHENTICATION_ERROR",
  AUTHORIZATION_ERROR = "AUTHORIZATION_ERROR",
  SERVER_ERROR = "SERVER_ERROR",
  CLIENT_ERROR = "CLIENT_ERROR",
  CONFIGURATION_ERROR = "CONFIGURATION_ERROR",
  RATE_LIMIT = "RATE_LIMIT",
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export function isExpressError(error: unknown): error is ExpressError {
  return (
    error instanceof Error &&
    "statusCode" in error &&
    isNumber(error.statusCode)
  );
}
