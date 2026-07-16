/**
 * Cloud URL helper for OAuth and outbound callbacks.
 *
 * Reads `CLOUD_API_URL` / `NEXT_PUBLIC_CLOUD_API_URL` only — there is no
 * hardcoded fallback. Self-hosting users must set one of these env vars
 * (the publicly reachable URL where OpenLoomi is served) for OAuth
 * callbacks to work.
 *
 * Returns an empty string when nothing is configured. Callers that build
 * absolute redirect URIs should treat empty as "OAuth not configured" and
 * surface a clear error to the user.
 */
export function getCloudUrl(): string {
  return (
    process.env.CLOUD_API_URL || process.env.NEXT_PUBLIC_CLOUD_API_URL || ""
  );
}
