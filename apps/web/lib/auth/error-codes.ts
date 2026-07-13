/**
 * Auth error codes
 * Used for unified error handling between frontend and backend
 */
export enum AuthErrorCode {
  // Auth-related errors
  INVALID_CREDENTIALS = "INVALID_CREDENTIALS",
  USER_NOT_FOUND = "USER_NOT_FOUND",
  USER_EXISTS = "USER_EXISTS",

  // Request parameter errors
  MISSING_EMAIL = "MISSING_EMAIL",
  MISSING_PASSWORD = "MISSING_PASSWORD",
  INVALID_EMAIL = "INVALID_EMAIL",
  INVALID_PASSWORD = "INVALID_PASSWORD",

  // Server errors
  INTERNAL_ERROR = "INTERNAL_ERROR",
  SERVICE_UNAVAILABLE = "SERVICE_UNAVAILABLE",

  // Other errors
  RATE_LIMITED = "RATE_LIMITED",
}
