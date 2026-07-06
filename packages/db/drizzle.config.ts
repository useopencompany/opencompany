import "../../scripts/load-env.mjs";
import { defineConfig } from "drizzle-kit";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for Drizzle.");
}

export default defineConfig({
  schema: ["./src/schema.ts", "./src/goat-schema.ts"],
  out: "../../drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: databaseUrl,
  },
});
