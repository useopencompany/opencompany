import { Inngest } from "inngest";

export const inngest = new Inngest({
  id: "opencompany-web",
  ...(process.env.INNGEST_ENV ? { env: process.env.INNGEST_ENV } : {}),
});
