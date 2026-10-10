type Environment = Record<string, string | undefined>;
function parseUrl(value: string, message: string) {
  try { return new URL(value); } catch { throw new Error(message); }
}
export function validateServerEnvironment(env: Environment, production = env.NODE_ENV === "production") {
  const databaseError = "Set DATABASE_URL to your PostgreSQL connection URL.";
  const database = parseUrl(env.DATABASE_URL || "", databaseError);
  if (!["postgres:", "postgresql:"].includes(database.protocol) || !database.hostname) throw new Error(databaseError);
  const origin = parseUrl(env.BETTER_AUTH_URL || "http://localhost:3000", "BETTER_AUTH_URL must be a valid origin.");
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") throw new Error("BETTER_AUTH_URL must be an origin without a path, credentials or query.");
  if (production && (!env.BETTER_AUTH_URL || origin.protocol !== "https:")) throw new Error("Set BETTER_AUTH_URL to your public HTTPS origin.");
  if (!production && !["http:", "https:"].includes(origin.protocol)) throw new Error("BETTER_AUTH_URL must use HTTP or HTTPS.");
  if (production && (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32)) throw new Error("Set BETTER_AUTH_SECRET to a random secret of at least 32 characters.");
  return { databaseUrl: env.DATABASE_URL!, authOrigin: origin.origin };
}
