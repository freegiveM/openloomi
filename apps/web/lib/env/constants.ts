/**
 * Deployment environment constant definitions
 *
 * IMPORTANT: This file must not import any node: module.
 * For server-only constants (SQLITE_DB_PATH, TAURI_SERVER_*, etc.),
 * use @/lib/env/server-constants instead.
 */
import { DEV_PORT, PROD_PORT } from "@openloomi/shared";

export type DeploymentMode = "tauri" | "server";
export type DatabaseType = "postgres" | "sqlite";
export type StorageType =
  | "vercel-blob"
  | "local-fs"
  | "google-drive"
  | "notion";

export const DEPLOYMENT_MODE: DeploymentMode =
  typeof process.env.TAURI_MODE === "string"
    ? "tauri"
    : process.env.IS_TAURI === "true"
      ? "tauri"
      : "server";

export const DATABASE_TYPE: DatabaseType =
  DEPLOYMENT_MODE === "tauri" || process.env.USE_SQLITE === "true"
    ? "sqlite"
    : "postgres";

export const DEFAULT_STORAGE_TYPE: StorageType =
  DEPLOYMENT_MODE === "tauri" ? "local-fs" : "vercel-blob";

const isDevelopment = process.env.NODE_ENV === "development";
const defaultPort = isDevelopment ? DEV_PORT : PROD_PORT;
const tauriServerPort = Number.parseInt(
  process.env.TAURI_SERVER_PORT || String(defaultPort),
  10,
);
const tauriServerHost = process.env.TAURI_SERVER_HOST || "localhost";
const serverBaseUrl =
  process.env.NEXT_PUBLIC_APP_URL ||
  process.env.APP_URL ||
  process.env.APPLICATION_URL ||
  process.env.NEXTAUTH_URL ||
  `http://${tauriServerHost}:${tauriServerPort}`;

// Re-export client-safe constants
export { guestRegex } from "@/lib/env/client-constants";
export {
  isProductionEnvironment,
  isDevelopmentEnvironment,
  isTestEnvironment,
  DEFAULT_AI_MODEL,
  isTauriMode,
  isServerMode,
  APP_DIR_NAME,
} from "@/lib/env/client-constants";

export const AI_PROXY_BASE_URL = process.env.ANTHROPIC_BASE_URL;

// Session and Auth Constants
export const maxChunkSummaryCount = 10;

// Bump this value to force all users to re-authenticate and receive a fresh session token.
export const authSessionVersion = "2025-01-17";

export const nextAuthSessionCookies = [
  "authjs.session-token",
  "__Secure-authjs.session-token",
  "__Host-authjs.session-token",
  "next-auth.session-token",
  "__Secure-next-auth.session-token",
  "__Host-next-auth.session-token",
] as const;

// For backward compatibility, export as const
import { generateDummyPassword } from "@/lib/db/utils";
export const DUMMY_PASSWORD = generateDummyPassword();
