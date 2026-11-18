import { neon } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import * as legacyBillingSchema from "./legacy-billing-schema";
import * as llmBrokerSchema from "./llm-broker-schema";
import * as productSchema from "./product-schema";

const schema = { ...legacyBillingSchema, ...llmBrokerSchema, ...productSchema };

let db: NeonHttpDatabase<typeof schema> | undefined;

function getDatabaseUrl(databaseUrl?: string) {
  const resolved =
    databaseUrl === undefined
      ? process.env.DATABASE_URL?.trim() || process.env.API_DATABASE_URL?.trim()
      : databaseUrl.trim();
  if (!resolved) {
    throw new Error("DATABASE_URL or API_DATABASE_URL is required for database access.");
  }

  return resolved;
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
