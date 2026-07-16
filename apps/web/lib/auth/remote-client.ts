/**
 * Backward-compatible re-exports.
 *
 * OpenLoomi is open source and self-hosted — there is no SaaS cloud
 * client anymore. The legacy `CloudApiClient` / `getCloudApiClient` /
 * `createCloudClientForRequest` / `shouldUseCloudAuth` symbols have
 * been removed. Call sites that previously imported them now talk to
 * the local database / local API routes instead.
 *
 * The token-manager helpers are re-exported so existing import paths
 * (`from "@/lib/auth/remote-client"`) keep working.
 */

export {
  getAuthToken as getStoredAuthToken,
  storeAuthToken,
  clearAuthToken,
} from "@/lib/auth/token-manager";
