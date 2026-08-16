import { SqliteGoalRuntimeStore } from "../persistence/sqlite/store";
import {
  SqliteImmediateTransactionDriver,
  type BetterSqlite3ClientSource,
} from "../persistence/sqlite/transaction";

export interface AgentGoalRecoveryPresentation {
  readonly runtimeSessionId: string;
  readonly chat: {
    readonly title: string;
    readonly createdAt: string;
  };
}

interface RecoveryChatRow {
  readonly id?: unknown;
  readonly title?: unknown;
  readonly created_at?: unknown;
}

/**
 * Focused SQLite read model for desktop restart recovery.
 *
 * Runtime candidates and their Chats are loaded in two bounded queries. This
 * deliberately avoids composing the Goal Runtime or importing the monolithic
 * Chat query module on the desktop home-page path.
 */
export function readAgentGoalRecoveryPresentations(
  source: BetterSqlite3ClientSource,
  ownerId: string,
  limit = 20,
): AgentGoalRecoveryPresentation[] {
  const owner = identifier(ownerId, "ownerId");
  const parsedLimit = positiveInteger(limit, "limit", 100);
  const client = new SqliteImmediateTransactionDriver(source).client;
  const sessions = new SqliteGoalRuntimeStore(
    client,
  ).listRecoveryPresentationSessions(owner, parsedLimit);
  if (sessions.length === 0) return [];

  const placeholders = sessions.map(() => "?").join(", ");
  const rows = client
    .prepare(
      `SELECT id, title, "createdAt" AS created_at
         FROM "Chat"
        WHERE "userId" = ? AND id IN (${placeholders})`,
    )
    .all(owner, ...sessions.map((session) => session.runtimeSessionId));
  const chats = new Map(
    rows.map((value) => {
      const row = value as RecoveryChatRow;
      const id = requiredString(row.id, "recovery Chat id");
      return [
        id,
        {
          title: requiredString(row.title, "recovery Chat title"),
          createdAt: secondsIso(
            requiredInteger(row.created_at, "recovery Chat createdAt", 0),
          ),
        },
      ] as const;
    }),
  );

  return sessions.flatMap((session) => {
    const chat = chats.get(session.runtimeSessionId);
    return chat
      ? [
          {
            runtimeSessionId: session.runtimeSessionId,
            chat,
          },
        ]
      : [];
  });
}

function identifier(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value !== value.trim()
  ) {
    throw new TypeError(`${field} must be a non-empty identifier`);
  }
  return value;
}

function positiveInteger(
  value: number,
  field: string,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${field} must be a positive bounded integer`);
  }
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function requiredInteger(
  value: unknown,
  field: string,
  minimum: number,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new TypeError(`${field} must be an integer >= ${minimum}`);
  }
  return value as number;
}

function secondsIso(value: number): string {
  return new Date(value * 1_000).toISOString();
}
