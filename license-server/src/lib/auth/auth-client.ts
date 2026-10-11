import { createAuthClient } from "better-auth/react";
// Admin browser requests use the same origin; no public env variable is needed.
export const authClient = createAuthClient();
