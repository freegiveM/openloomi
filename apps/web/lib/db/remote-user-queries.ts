import { db } from "./queries";
import { user as userTable } from "./schema";
import type { User } from "./schema";
import { eq } from "drizzle-orm";
import { hash } from "bcrypt-ts";
import { isTauriMode } from "@/lib/env/constants";

/**
 * Create or get local shadow user from cloud user info
 */
export async function getOrCreateShadowUser(
  cloudUser: {
    id: string;
    email: string | undefined;
    name: string | null;
    avatarUrl: string | null;
  },
  _dbParam?: any,
  options?: { isOAuthUser?: boolean; password?: string },
): Promise<User> {
  // PostgreSQL uses UUID type, cannot add cloud_ prefix (would break UUID format)
  // SQLite uses text type, can add cloud_ prefix
  const shadowUserId = isTauriMode()
    ? // Caller may have already generated cloud_ prefix (e.g., tauri.ts), avoid cloud_cloud_xxx
      cloudUser.id.startsWith("cloud_")
      ? cloudUser.id
      : `cloud_${cloudUser.id}`
    : // In Postgres, if cloud_ prefix was accidentally passed, try to restore original UUID
      cloudUser.id.startsWith("cloud_")
      ? cloudUser.id.slice("cloud_".length)
      : cloudUser.id;

  const providedPassword = options?.password;

  // Generate password hash (if password is provided)
  let hashedPassword: string | null = null;
  if (providedPassword) {
    hashedPassword = await hash(providedPassword, 10);
  }

  try {
    // Try to get shadow user from local database
    const [existing] = await db
      .select()
      .from(userTable)
      .where(eq(userTable.id, shadowUserId))
      .limit(1);

    if (existing) {
      // Update shadow user info - refer to markUserLoggedIn approach
      const now = new Date();
      const updates: any = {
        updatedAt: now,
      };

      // Only update when value exists and is not null/undefined
      if (cloudUser.name != null) {
        updates.name = cloudUser.name;
      }

      if (cloudUser.avatarUrl != null) {
        updates.avatarUrl = cloudUser.avatarUrl;
      }

      if (hashedPassword != null) {
        updates.password = hashedPassword;
      }

      const [updated] = await db
        .update(userTable)
        .set(updates)
        .where(eq(userTable.id, shadowUserId))
        .returning();

      return updated;
    }

    // Create new shadow user - refer to createUser approach
    const now = new Date();

    // Build insert data, only includes non-null/undefined fields
    const insertData: any = {
      id: shadowUserId,
      name:
        cloudUser.name ||
        (cloudUser.email ? cloudUser.email.split("@")[0] : "User"),
      createdAt: now,
      updatedAt: now,
    };

    // Only add when email exists
    if (cloudUser.email != null) {
      insertData.email = cloudUser.email;
    }

    // Only add when password exists
    if (hashedPassword != null) {
      insertData.password = hashedPassword;
    }

    // Only add when avatarUrl exists
    if (cloudUser.avatarUrl != null) {
      insertData.avatarUrl = cloudUser.avatarUrl;
    }

    const [newUser] = await db.insert(userTable).values(insertData).returning();

    return newUser;
  } catch (error) {
    console.error("[getOrCreateShadowUser] Error:", error);
    throw error;
  }
}

/**
 * Best-effort safety net: ensure the local User table has a row for the
 * current session's user. Idempotent; no-op when the user already exists.
 *
 * This is meant to be called from the auth entrypoint (Tauri auth() wrapper)
 * so that any subsequent DB write that has a FK to `User.id` won't fail with
 * FOREIGN KEY constraint failed — even if the original sign-in flow never
 * created the shadow user row (e.g., session was restored from file but the
 * SQLite DB was reset, or the sign-in path skipped `getOrCreateShadowUser`).
 */
export async function ensureLocalUser(
  session:
    | {
        user?: {
          id?: string | null;
          email?: string | null;
          name?: string | null;
          avatarUrl?: string | null;
        } | null;
      }
    | null
    | undefined,
): Promise<void> {
  const userId = session?.user?.id;
  if (!userId) return;

  await getOrCreateShadowUser({
    id: userId,
    email: session.user?.email ?? undefined,
    name: session.user?.name ?? null,
    avatarUrl: session.user?.avatarUrl ?? null,
  });
}
