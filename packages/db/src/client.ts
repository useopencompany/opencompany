import { neon } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import * as legacyBillingSchema from "./legacy-billing-schema";
import * as llmBrokerSchema from "./llm-broker-schema";
import * as productSchema from "./product-schema";

const schema = { ...legacyBillingSchema, ...llmBrokerSchema, ...productSchema };

let db: NeonHttpDatabase<typeof schema> | undefined;

export function resolveDatabaseUrl(databaseUrl?: string) {
  const resolved = [
    databaseUrl,
    process.env.DATABASE_URL,
    process.env.API_DATABASE_URL,
    process.env.RUNNER_DATABASE_URL,
  ].find((value) => value?.trim());
  if (!resolved) {
    throw new Error(
      "DATABASE_URL, API_DATABASE_URL, or RUNNER_DATABASE_URL is required for database access.",
    );
  }

  return resolved.trim();
}

export function createDb(databaseUrl?: string) {
  return drizzle(neon(resolveDatabaseUrl(databaseUrl)), { schema });
}

export function getDb() {
  if (!db) {
    db = createDb();
  }

  return db;
}

export { schema };
