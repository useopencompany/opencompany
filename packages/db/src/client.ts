import { neon } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import * as schema from "./schema";

let db: NeonHttpDatabase<typeof schema> | undefined;

function getDatabaseUrl(databaseUrl = process.env.DATABASE_URL) {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for database access.");
  }

  return databaseUrl;
}

export function createDb(databaseUrl?: string) {
  return drizzle(neon(getDatabaseUrl(databaseUrl)), { schema });
}

export function getDb() {
  if (!db) {
    db = createDb();
  }

  return db;
}

export { schema };
