/**
 * Token Manager Tests
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const localStorageMock = {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
};

const cookieStore: Record<string, string> = {};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@/lib/api/remote-client", () => ({
  shouldUseCloudAuth: vi.fn(() => false),
}));

vi.mock("@/lib/auth/token-manager", async (orig) => {
  const mod = (await orig()) as Record<string, unknown>;
  const cookieStore: Record<string, string | undefined> = {};

  return {
    ...mod,
    storeAuthToken: (token: string) => {
      cookieStore.cloud_auth_token_client = token;
    },
    getAuthToken: () => {
      const v = cookieStore.cloud_auth_token_client;
      if (v) return v;
      return null;
    },
    clearAuthToken: () => {
      cookieStore.cloud_auth_token_client = undefined;
    },
  };
});

import {
  clearAuthToken,
  getAuthToken,
  getTokenTimeRemaining,
  isTokenExpired,
  isTokenValid,
  parseToken,
  shouldRefreshToken,
  storeAuthToken,
} from "../../lib/auth/token-manager";

describe("TokenManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Token Storage", () => {
    it("should store token in cookie", () => {
      const token = "test_token";
      storeAuthToken(token);

      const result = getAuthToken();
      expect(result).toBe(token);
    });
  });

  describe("Token Retrieval", () => {
    it("should return null when no token stored", () => {
      clearAuthToken();
      const result = getAuthToken();
      expect(result).toBeNull();
    });
  });

  describe("Token Clearing", () => {
    it("should clear token", () => {
      storeAuthToken("test_token");
      clearAuthToken();
      expect(getAuthToken()).toBeNull();
    });
  });

  describe("Token Parsing", () => {
    it("should parse valid token", () => {
      const now = Math.floor(Date.now() / 1000);
      const payload = {
        id: "user_id",
        email: "test@example.com",
        exp: now + 3600,
        iat: now,
      };

      const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
        "base64url",
      );
      const signature = "test_signature";
      const token = `${encodedPayload}.${signature}`;

      const result = parseToken(token);

      expect(result).toEqual(payload);
    });

    it("should return null for invalid token", () => {
      const result = parseToken("invalid_token");

      expect(result).toBeNull();
    });

    it("should return null for token without signature", () => {
      const payload = { id: "user_id", email: "test@example.com" };
      const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
        "base64url",
      );
      const token = encodedPayload;

      const result = parseToken(token);

      expect(result).toBeNull();
    });
  });

  describe("Token Validation", () => {
    it("should return true for valid token", () => {
      const now = Math.floor(Date.now() / 1000);
      const payload = {
        id: "user_id",
        email: "test@example.com",
        exp: now + 3600,
        iat: now,
      };

      const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
        "base64url",
      );
      const signature = "test_signature";
      const token = `${encodedPayload}.${signature}`;

      const result = isTokenValid(token);

      expect(result).toBe(true);
    });

    it("should return false for expired token", () => {
      const now = Math.floor(Date.now() / 1000);
      const payload = {
        id: "user_id",
        email: "test@example.com",
        exp: now - 3600, // expired
        iat: now - 7200,
      };

      const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
        "base64url",
      );
      const signature = "test_signature";
      const token = `${encodedPayload}.${signature}`;

      const result = isTokenValid(token);

      expect(result).toBe(false);
    });

    it("should return false for empty token", () => {
      const result = isTokenValid("");

      expect(result).toBe(false);
    });
  });

  describe("Token Expiry", () => {
    it("should detect expired token", () => {
      const now = Math.floor(Date.now() / 1000);
      const payload = {
        id: "user_id",
        email: "test@example.com",
        exp: now - 3600, // expired 1 hour ago
        iat: now - 7200,
      };

      const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
        "base64url",
      );
      const signature = "test_signature";
      const token = `${encodedPayload}.${signature}`;

      const result = isTokenExpired(token);

      expect(result).toBe(true);
    });

    it("should not expire valid token", () => {
      const now = Math.floor(Date.now() / 1000);
      const payload = {
        id: "user_id",
        email: "test@example.com",
        exp: now + 3600, // expires in 1 hour
        iat: now,
      };

      const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
        "base64url",
      );
      const signature = "test_signature";
      const token = `${encodedPayload}.${signature}`;

      const result = isTokenExpired(token);

      expect(result).toBe(false);
    });
  });

  describe("Token Refresh", () => {
    it("should refresh token when close to expiry", () => {
      const now = Math.floor(Date.now() / 1000);
      const ONE_DAY = 24 * 60 * 60;
      const payload = {
        id: "user_id",
        email: "test@example.com",
        exp: now + ONE_DAY, // expires in 1 day (less than 7 day threshold)
        iat: now,
      };

      const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
        "base64url",
      );
      const signature = "test_signature";
      const token = `${encodedPayload}.${signature}`;

      const result = shouldRefreshToken(token);

      expect(result).toBe(true);
    });

    it("should not refresh token when far from expiry", () => {
      const now = Math.floor(Date.now() / 1000);
      const payload = {
        id: "user_id",
        email: "test@example.com",
        exp: now + 10 * 24 * 60 * 60, // expires in 10 days
        iat: now,
      };

      const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
        "base64url",
      );
      const signature = "test_signature";
      const token = `${encodedPayload}.${signature}`;

      const result = shouldRefreshToken(token);

      expect(result).toBe(false);
    });
  });

  describe("Token Time Remaining", () => {
    it("should calculate time remaining correctly", () => {
      const now = Math.floor(Date.now() / 1000);
      const ONE_HOUR = 3600;
      const payload = {
        id: "user_id",
        email: "test@example.com",
        exp: now + ONE_HOUR,
        iat: now,
      };

      const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
        "base64url",
      );
      const signature = "test_signature";
      const token = `${encodedPayload}.${signature}`;

      const result = getTokenTimeRemaining(token);

      // Should be close to 1 hour (with some tolerance)
      expect(result).toBeGreaterThan(3500);
      expect(result).toBeLessThan(3700);
    });

    it("should return 0 for expired token", () => {
      const now = Math.floor(Date.now() / 1000);
      const payload = {
        id: "user_id",
        email: "test@example.com",
        exp: now - 3600, // already expired
        iat: now - 7200,
      };

      const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
        "base64url",
      );
      const signature = "test_signature";
      const token = `${encodedPayload}.${signature}`;

      const result = getTokenTimeRemaining(token);

      expect(result).toBe(0);
    });
  });
});
