import type { ProxyTransport } from "@director.run/utilities/schema";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HealthChecker } from "./health-checker";

// Mock fetch globally
const mockFetch = vi.fn() as MockInstance;
global.fetch = mockFetch as unknown as typeof fetch;

describe("HealthChecker", () => {
  let healthChecker: HealthChecker;

  beforeEach(() => {
    healthChecker = new HealthChecker();
    vi.clearAllMocks();
  });

  describe("HTTP Health Checks", () => {
    const httpTransport: ProxyTransport = {
      type: "http",
      url: "http://localhost:3000",
    };

    it("should return healthy for successful HEAD request", async () => {
      const mockResponse = {
        status: 200,
        statusText: "OK",
      };
      mockFetch.mockResolvedValue(mockResponse);

      const result = await healthChecker.checkHealth(
        httpTransport,
        "test-server",
      );

      expect(result.isHealthy).toBe(true);
      expect(result.responseTime).toBeGreaterThan(0);
      expect(result.error).toBeUndefined();
      expect(global.fetch).toHaveBeenCalledWith(
        "http://localhost:3000",
        expect.objectContaining({
          method: "HEAD",
          headers: expect.objectContaining({
            "User-Agent": "Director-HealthChecker/1.0",
          }),
        }),
      );
    });

    it("should fallback to GET when HEAD fails", async () => {
      mockFetch
        .mockRejectedValueOnce(new Error("HEAD not supported"))
        .mockResolvedValueOnce({
          status: 200,
          statusText: "OK",
        });

      const result = await healthChecker.checkHealth(
        httpTransport,
        "test-server",
      );

      expect(result.isHealthy).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(global.fetch).toHaveBeenNthCalledWith(
        1,
        "http://localhost:3000",
        expect.objectContaining({ method: "HEAD" }),
      );
      expect(global.fetch).toHaveBeenNthCalledWith(
        2,
        "http://localhost:3000",
        expect.objectContaining({ method: "GET" }),
      );
    });

    it("should return unhealthy for 4xx status codes", async () => {
      const mockResponse = {
        status: 404,
        statusText: "Not Found",
      };
      mockFetch.mockResolvedValue(mockResponse);

      const result = await healthChecker.checkHealth(
        httpTransport,
        "test-server",
      );

      expect(result.isHealthy).toBe(false);
      expect(result.error).toBe("HTTP 404: Not Found");
      expect(result.responseTime).toBeGreaterThan(0);
    });

    it("should return unhealthy for 5xx status codes", async () => {
      const mockResponse = {
        status: 500,
        statusText: "Internal Server Error",
      };
      mockFetch.mockResolvedValue(mockResponse);

      const result = await healthChecker.checkHealth(
        httpTransport,
        "test-server",
      );

      expect(result.isHealthy).toBe(false);
      expect(result.error).toBe("HTTP 500: Internal Server Error");
    });

    it("should handle timeout", async () => {
      const timeoutChecker = new HealthChecker({ timeout: 100 });

      // Mock fetch to hang
      mockFetch.mockImplementation(() => new Promise(() => {}));

      const result = await timeoutChecker.checkHealth(
        httpTransport,
        "test-server",
      );

      expect(result.isHealthy).toBe(false);
      expect(result.error).toContain("timeout after 100ms");
      expect(result.responseTime).toBeGreaterThanOrEqual(100);
    });

    it("should handle network errors", async () => {
      mockFetch.mockRejectedValue(new Error("Network error"));

      const result = await healthChecker.checkHealth(
        httpTransport,
        "test-server",
      );

      expect(result.isHealthy).toBe(false);
      expect(result.error).toBe("Network error");
      expect(result.responseTime).toBeGreaterThan(0);
    });

    it("should consider 3xx responses as healthy", async () => {
      const mockResponse = {
        status: 302,
        statusText: "Found",
      };
      mockFetch.mockResolvedValue(mockResponse);

      const result = await healthChecker.checkHealth(
        httpTransport,
        "test-server",
      );

      expect(result.isHealthy).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });

  describe("STDIO Health Checks", () => {
    const stdioTransport = {
      type: "stdio" as const,
      command: "echo",
      args: ["hello"],
    };

    it("should return healthy for accessible command", async () => {
      // Mock fs.access to succeed
      const mockAccess = vi.fn().mockResolvedValue(undefined);
      vi.doMock("fs", () => ({
        promises: { access: mockAccess },
        constants: { F_OK: 0, X_OK: 1 },
      }));

      const result = await healthChecker.checkHealth(
        stdioTransport,
        "test-server",
      );

      expect(result.isHealthy).toBe(true);
      expect(result.responseTime).toBeGreaterThan(0);
      expect(result.error).toBeUndefined();
    });

    it("should test command execution when access check fails", async () => {
      // Mock fs.access to fail (command not in current directory)
      const mockAccess = vi.fn().mockRejectedValue(new Error("ENOENT"));
      vi.doMock("fs", () => ({
        promises: { access: mockAccess },
        constants: { F_OK: 0, X_OK: 1 },
      }));

      // Mock spawn to succeed
      const mockSpawn = vi.fn().mockImplementation(() => {
        const mockChild = {
          on: vi.fn().mockImplementation((event, callback) => {
            if (event === "exit") {
              setTimeout(() => callback(0), 10);
            }
          }),
          kill: vi.fn(),
          killed: false,
        };
        return mockChild;
      });
      vi.doMock("child_process", () => ({
        spawn: mockSpawn,
      }));

      const result = await healthChecker.checkHealth(
        stdioTransport,
        "test-server",
      );

      expect(result.isHealthy).toBe(true);
      expect(result.responseTime).toBeGreaterThan(0);
    });

    it("should return unhealthy for non-existent command", async () => {
      // Mock fs.access to fail
      const mockAccess = vi.fn().mockRejectedValue(new Error("ENOENT"));
      vi.doMock("fs", () => ({
        promises: { access: mockAccess },
        constants: { F_OK: 0, X_OK: 1 },
      }));

      // Mock spawn to fail with ENOENT
      const mockSpawn = vi.fn().mockImplementation(() => {
        const mockChild = {
          on: vi.fn().mockImplementation((event, callback) => {
            if (event === "error") {
              const error = new Error("Command not found");
              error.message = "spawn nonexistent ENOENT";
              setTimeout(() => callback(error), 10);
            }
          }),
          kill: vi.fn(),
          killed: false,
        };
        return mockChild;
      });
      vi.doMock("child_process", () => ({
        spawn: mockSpawn,
      }));

      const nonExistentTransport = {
        type: "stdio" as const,
        command: "nonexistent",
        args: [],
      };

      const result = await healthChecker.checkHealth(
        nonExistentTransport,
        "test-server",
      );

      expect(result.isHealthy).toBe(false);
      expect(result.error).toContain("Command not found");
    });

    it("should handle command timeout", async () => {
      const timeoutChecker = new HealthChecker({ timeout: 50 });

      // Mock fs.access to fail
      const mockAccess = vi.fn().mockRejectedValue(new Error("ENOENT"));
      vi.doMock("fs", () => ({
        promises: { access: mockAccess },
        constants: { F_OK: 0, X_OK: 1 },
      }));

      // Mock spawn to hang
      const mockSpawn = vi.fn().mockImplementation(() => {
        const mockChild = {
          on: vi.fn(), // Never calls callbacks
          kill: vi.fn(),
          killed: false,
        };
        return mockChild;
      });
      vi.doMock("child_process", () => ({
        spawn: mockSpawn,
      }));

      const result = await timeoutChecker.checkHealth(
        stdioTransport,
        "test-server",
      );

      expect(result.isHealthy).toBe(false);
      expect(result.error).toContain("timeout after 50ms");
      expect(result.responseTime).toBeGreaterThanOrEqual(50);
    });
  });

  describe("Configuration", () => {
    it("should use custom timeout", () => {
      const customChecker = new HealthChecker({ timeout: 1000 });
      const config = customChecker.getConfig();

      expect(config.timeout).toBe(1000);
    });

    it("should update configuration", () => {
      healthChecker.updateConfig({ timeout: 2000 });
      const config = healthChecker.getConfig();

      expect(config.timeout).toBe(2000);
    });

    it("should use custom HTTP check path", () => {
      const customChecker = new HealthChecker({ httpCheckPath: "/status" });
      const config = customChecker.getConfig();

      expect(config.httpCheckPath).toBe("/status");
    });
  });

  describe("Error Handling", () => {
    it("should handle unexpected errors gracefully", async () => {
      const transport: ProxyTransport = {
        type: "http",
        url: "invalid-url",
      };

      mockFetch.mockRejectedValue(new TypeError("Invalid URL"));

      const result = await healthChecker.checkHealth(transport, "test-server");

      expect(result.isHealthy).toBe(false);
      expect(result.error).toBe("Invalid URL");
      expect(result.responseTime).toBeGreaterThan(0);
    });
  });
});
