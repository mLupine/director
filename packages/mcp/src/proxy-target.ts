import { AppError } from "@director.run/utilities/error";
import { getLogger } from "@director.run/utilities/logger";
import type {
  ProxyTargetAttributes,
  ProxyTransport,
} from "@director.run/utilities/schema";
import { SimpleClient } from "./simple-client";

const logger = getLogger(`mcp/proxy-target`);

export type ProxyTargetTransport = ProxyTransport;
export type ProxyTargetStatus =
  | "starting"
  | "running"
  | "failed"
  | "disabled"
  | "disconnected";

export class ProxyTarget extends SimpleClient {
  public readonly attributes: ProxyTargetAttributes;
  private _status: ProxyTargetStatus = "disconnected";
  private _lastError?: string;
  private _lastErrorAt?: Date;
  private _connectedAt?: Date;
  private _lastAttemptAt?: Date;

  constructor(attributes: ProxyTargetAttributes) {
    super(attributes.name.toLocaleLowerCase());
    this.attributes = attributes;
  }

  public get status(): ProxyTargetStatus {
    return this._status;
  }

  public get lastError(): string | undefined {
    return this._lastError;
  }

  public get lastErrorAt(): Date | undefined {
    return this._lastErrorAt;
  }

  public get connectedAt(): Date | undefined {
    return this._connectedAt;
  }

  public get lastAttemptAt(): Date | undefined {
    return this._lastAttemptAt;
  }

  public setStatus(status: ProxyTargetStatus, error?: string): void {
    const previousStatus = this._status;
    this._status = status;

    if (error) {
      this._lastError = error;
      this._lastErrorAt = new Date();
    }

    if (status === "running") {
      this._connectedAt = new Date();
      this._lastError = undefined;
      this._lastErrorAt = undefined;
    }

    if (status === "starting") {
      this._lastAttemptAt = new Date();
    }

    logger.debug({
      message: `status changed from ${previousStatus} to ${status}`,
      targetName: this.name,
      error,
    });
  }

  public getStatusInfo() {
    let errorCategory = null;
    let isRetryable = null;
    let suggestedAction = null;

    if (this._lastError) {
      const errorCode = AppError.categorizeError(this._lastError);
      const appError = new AppError(errorCode, this._lastError);
      errorCategory = errorCode;
      isRetryable = appError.isRetryable;
      suggestedAction = appError.suggestedAction;
    }

    return {
      status: this._status,
      lastError: this._lastError || null,
      lastErrorAt: this._lastErrorAt || null,
      connectedAt: this._connectedAt || null,
      lastAttemptAt: this._lastAttemptAt || null,
      errorCategory,
      isRetryable,
      suggestedAction,
    };
  }

  public async smartConnect({ throwOnError } = { throwOnError: false }) {
    const { name, transport } = this.attributes;

    // Skip if disabled
    if (this._status === "disabled") {
      logger.debug({
        message: `skipping connection to disabled target ${name}`,
      });
      return;
    }

    this.setStatus("starting");

    const connectOperation = async () => {
      logger.info({
        message: `connecting to target ${name}`,
        transport,
      });

      if (transport.type === "http") {
        await this.connectToHTTP(transport.url, transport.headers);
      } else {
        await this.connectToStdio(transport.command, transport.args ?? [], {
          ...(process.env as Record<string, string>),
          ...(transport?.env || {}),
        });
      }
    };

    try {
      await connectOperation();

      this.setStatus("running");
      logger.info({
        message: `successfully connected to target ${name}`,
      });
    } catch (error) {
      const originalError =
        error instanceof Error ? error : new Error(String(error));
      const errorCode = AppError.categorizeError(originalError);
      const appError = new AppError(errorCode, originalError.message, {
        targetName: name,
        transport: transport.type,
        operation: "connect",
      });

      // Set status with categorized error information
      const errorMessage = `[${errorCode}] ${originalError.message}`;
      this.setStatus("failed", errorMessage);

      logger.error({
        message: `failed to connect to target ${name}`,
        error: originalError,
        category: errorCode,
        isRetryable: appError.isRetryable,
        suggestedAction: appError.suggestedAction,
      });

      if (throwOnError) {
        throw originalError;
      }
    }
  }

  public enable(): void {
    if (this._status === "disabled") {
      this.setStatus("disconnected");
      logger.info({
        message: `enabled target ${this.name}`,
      });
    }
  }

  public disable(): void {
    this.setStatus("disabled");
    logger.info({
      message: `disabled target ${this.name}`,
    });
  }

  public async restart(
    { throwOnError } = { throwOnError: false },
  ): Promise<void> {
    logger.info({
      message: `restarting target ${this.name}`,
    });

    try {
      await this.close();
    } catch (error) {
      logger.warn({
        message: `error closing connection during restart`,
        targetName: this.name,
        error,
      });
    }

    this.setStatus("disconnected");
    await this.smartConnect({ throwOnError });
  }

  public async close(): Promise<void> {
    if (this._status !== "disabled") {
      this.setStatus("disconnected");
    }

    logger.info({
      message: `closing connection to target ${this.name}`,
    });

    await super.close();
  }

  public async enhancedHealthCheck(): Promise<{
    isHealthy: boolean;
    responseTime?: number;
    error?: string;
  }> {
    // If disabled, always return unhealthy
    if (this._status === "disabled") {
      return {
        isHealthy: false,
        error: "Server is disabled",
      };
    }

    const startTime = Date.now();

    try {
      let result: { isHealthy: boolean; responseTime?: number; error?: string };

      if (this.attributes.transport.type === "http") {
        result = await this.checkHttpHealth(
          this.attributes.transport.url,
          startTime,
        );
      } else {
        // For stdio transports, use the basic connection health check
        const isHealthy = await this.healthCheck();
        result = {
          isHealthy,
          responseTime: Date.now() - startTime,
          error: isHealthy ? undefined : "Connection health check failed",
        };
      }

      // Update status based on health check result
      if (!result.isHealthy && this._status === "running") {
        this.setStatus("failed", result.error);
      } else if (result.isHealthy && this._status === "failed") {
        this.setStatus("running");
      }

      return result;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.setStatus("failed", errorMessage);

      return {
        isHealthy: false,
        responseTime: Date.now() - startTime,
        error: errorMessage,
      };
    }
  }

  private async checkHttpHealth(
    url: string,
    startTime: number,
  ): Promise<{ isHealthy: boolean; responseTime?: number; error?: string }> {
    const timeout = 5000; // 5 seconds
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      // Try a simple HEAD request first, fall back to GET if not supported
      let response: Response;

      try {
        response = await fetch(url, {
          method: "HEAD",
          signal: controller.signal,
          headers: {
            "User-Agent": "Director-HealthChecker/1.0",
          },
        });
      } catch (headError) {
        // If HEAD fails, try GET request
        response = await fetch(url, {
          method: "GET",
          signal: controller.signal,
          headers: {
            "User-Agent": "Director-HealthChecker/1.0",
          },
        });
      }

      clearTimeout(timeoutId);
      const responseTime = Date.now() - startTime;

      // Consider 2xx and 3xx responses as healthy
      const isHealthy = response.status >= 200 && response.status < 400;

      if (!isHealthy) {
        logger.debug({
          message: "http health check returned non-healthy status",
          targetName: this.name,
          url,
          status: response.status,
          statusText: response.statusText,
          responseTime,
        });
      }

      return {
        isHealthy,
        responseTime,
        error: isHealthy
          ? undefined
          : `HTTP ${response.status}: ${response.statusText}`,
      };
    } catch (error) {
      clearTimeout(timeoutId);
      const responseTime = Date.now() - startTime;

      if (error instanceof Error && error.name === "AbortError") {
        return {
          isHealthy: false,
          responseTime,
          error: `Health check timeout after ${timeout}ms`,
        };
      }

      throw error;
    }
  }
}
