export type RunnerEnv = {
  databaseUrl: string;
  internalToken: string;
  streamTokenSecret: string;
  e2bApiKey: string;
  vercelAiGatewayApiKey: string;
  e2bTemplate: string | undefined;
  port: number;
  allowedOrigins: string[];
};

export function loadEnv(): RunnerEnv {
  return {
    databaseUrl: requiredEnv("DATABASE_URL"),
    internalToken: requiredEnv("RUNNER_INTERNAL_TOKEN"),
    streamTokenSecret:
      process.env.RUNNER_STREAM_TOKEN_SECRET ?? requiredEnv("RUNNER_INTERNAL_TOKEN"),
    e2bApiKey: requiredEnv("E2B_API_KEY"),
    vercelAiGatewayApiKey: requiredEnv("VERCEL_AI_GATEWAY_API_KEY"),
    e2bTemplate: process.env.OPENCOMPANY_E2B_TEMPLATE || undefined,
    port: Number(process.env.PORT ?? "3040"),
    allowedOrigins: (process.env.RUNNER_ALLOWED_ORIGINS ?? "http://localhost:3000")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  };
}

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}
