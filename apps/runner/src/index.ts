import "./load-env";
import { loadEnv } from "./env";
import { createServer } from "./server";

const env = loadEnv();
const server = createServer(env);

await server.listen({ host: "0.0.0.0", port: env.port });
