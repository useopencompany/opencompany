import * as SQLite from "expo-sqlite";
import { throwIfAborted } from "@/shared/lib/abort";
import { LEGACY_SCHEMA, SINGLE_ID_SCHEMA } from "./migrations";
import type { ChatPartition } from "./types";

let databasePromise: Promise<SQLite.SQLiteDatabase> | null = null;
let writerPromise: Promise<SQLite.SQLiteDatabase> | null = null;
let writeTail: Promise<unknown> = Promise.resolve();

async function openDatabase(): Promise<SQLite.SQLiteDatabase> {
  const database = await SQLite.openDatabaseAsync("opencompany-chat.db");
  await database.execAsync("PRAGMA journal_mode = WAL;");
  const row = await database.getFirstAsync<{ user_version: number }>("PRAGMA user_version");
  const version = row?.user_version ?? 0;
  if (version > 2) throw new Error("The local chat database is newer than this app.");
  if (version < 2) {
    // Foreign keys must be disabled outside the transaction while replacing referenced tables.
    await database.execAsync("PRAGMA foreign_keys = OFF;");
    try {
      await database.withTransactionAsync(async () => {
        if (version === 0) await database.execAsync(LEGACY_SCHEMA);
        await database.execAsync(SINGLE_ID_SCHEMA);
        const violation = await database.getFirstAsync("PRAGMA foreign_key_check");
        if (violation) throw new Error("The local chat migration failed its integrity check.");
      });
    } finally {
      await database.execAsync("PRAGMA foreign_keys = ON;");
    }
  } else {
    await database.execAsync("PRAGMA foreign_keys = ON;");
  }
  return database;
}

export function getChatDatabase(): Promise<SQLite.SQLiteDatabase> {
  databasePromise ??= openDatabase().catch((error: unknown) => {
    databasePromise = null;
    throw error;
  });
  return databasePromise;
}

export function values(partition: ChatPartition): [string, string] {
  return [partition.userId, partition.workspaceId];
}

// Serialize transactions on a dedicated write connection and fence writes from canceled sessions, including
// mutations already queued when sign-out starts. Purges use this same queue without a signal.
export function withChatTransaction<T>(
  partition: ChatPartition | null,
  operation: (transaction: SQLite.SQLiteDatabase) => Promise<T>,
): Promise<T> {
  const result = writeTail.then(async () => {
    throwIfAborted(partition?.signal);
    await getChatDatabase();
    writerPromise ??= SQLite.openDatabaseAsync("opencompany-chat.db", {
      useNewConnection: true,
    }).then(async (writer) => {
      await writer.execAsync("PRAGMA foreign_keys = ON;");
      return writer;
    });
    const database = await writerPromise;
    let value!: T;
    await database.withTransactionAsync(async () => {
      throwIfAborted(partition?.signal);
      value = await operation(database);
      throwIfAborted(partition?.signal);
    });
    return value;
  });
  writeTail = result.catch(() => undefined);
  return result;
}

export function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

export async function waitForChatWrites(): Promise<void> {
  await writeTail;
}
