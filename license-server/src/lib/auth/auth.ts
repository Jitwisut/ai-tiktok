import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { prisma } from "@/lib/db/prisma";
import { validateServerEnvironment } from "@/lib/environment";

const { authOrigin } = validateServerEnvironment(process.env);
export const auth = betterAuth({
  baseURL: authOrigin,
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  trustedOrigins: [authOrigin],
  emailAndPassword: { enabled: true, disableSignUp: true },
  rateLimit: { enabled: true, storage: "database", window: 60, max: 60 },
});
