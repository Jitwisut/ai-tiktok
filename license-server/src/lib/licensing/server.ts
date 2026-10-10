import { headers } from "next/headers";
import { auth } from "@/lib/auth/auth";
import { prisma } from "@/lib/db/prisma";
import { createLicenseService } from "@/services/license.service";
import { isLicenseAdmin, LicenseError, secretHash } from "./policy";

export const licenseService = createLicenseService(prisma);
export async function requireLicenseAdmin(requestHeaders?: Headers) {
  const session = await auth.api.getSession({ headers: requestHeaders ?? await headers(), query: { disableCookieCache: true } });
  if (!session) throw new LicenseError("unauthorized", 401);
  if (!isLicenseAdmin(session.user.id)) throw new LicenseError("forbidden", 403);
  return session.user.id;
}
export function assertAdminOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const expected = new URL(process.env.BETTER_AUTH_URL ?? request.url).origin;
  if (origin !== expected) throw new LicenseError("invalid_origin", 403);
}
export function assertSecureTransport(request: Request) {
  if (process.env.NODE_ENV === "production" && new URL(request.url).protocol !== "https:") throw new LicenseError("https_required", 400);
}
export async function rateLimitLicense(action: string, credential: string) {
  // Database buckets work across workers. Never store credentials or IPs in the limiter.
  const minute = Math.floor(Date.now() / 60_000);
  for (const [label, limit] of [[`${action}:global`, 600], [`${action}:${secretHash(credential)}`, action === "activate" ? 10 : 120]] as const) {
    const id = `${label}:${minute}`;
    const expiresAt = new Date((minute + 2) * 60_000);
    const [bucket] = await prisma.$queryRaw<{ count: number }[]>`
      INSERT INTO license_rate_buckets (id, count, "expiresAt") VALUES (${id}, 1, ${expiresAt})
      ON CONFLICT (id) DO UPDATE SET count = license_rate_buckets.count + 1 RETURNING count`;
    if (bucket.count > limit) throw new LicenseError("rate_limited", 429);
  }
  await prisma.licenseRateBucket.deleteMany({ where: { expiresAt: { lt: new Date() } } });
}
export function licenseResponseError(error: unknown, operation: string) {
  if (error instanceof LicenseError) {
    console.info(JSON.stringify({ event: "license_denied", operation, code: error.code }));
    return Response.json({ ok: false, status: error.code, code: error.code, serverTime: error.timing?.serverTime ?? new Date().toISOString(), ...(error.timing ? { expiresAt: error.timing.expiresAt } : {}) }, { status: error.status, headers: { "Cache-Control": "no-store", ...(error.status === 429 ? { "Retry-After": "60" } : {}) } });
  }
  // No database error payloads: they can contain key hashes, contact information or SQL.
  console.error(JSON.stringify({ event: "license_error", operation }));
  return Response.json({ ok: false, code: "server_unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
}
