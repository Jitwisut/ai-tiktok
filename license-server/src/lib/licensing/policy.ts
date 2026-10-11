import { createHash, randomBytes } from "node:crypto";

export const DAY_MS = 86_400_000;
export type LicenseState = "pending" | "active" | "expired" | "suspended";
export function licenseState(license: { suspended: boolean; expiresAt: Date | null }, now: Date): LicenseState {
  if (license.suspended) return "suspended";
  if (!license.expiresAt) return "pending";
  return license.expiresAt.getTime() <= now.getTime() ? "expired" : "active";
}
export function extendExpiry(expiresAt: Date | null, now: Date, days: number): Date {
  return new Date(Math.max(expiresAt?.getTime() ?? 0, now.getTime()) + days * DAY_MS);
}
export function secretHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
export function newSecret(prefix: string): string { return `${prefix}_${randomBytes(32).toString("base64url")}`; }
export function isLicenseAdmin(userId: string, configuredIds = process.env.LICENSE_ADMIN_USER_IDS ?? ""): boolean {
  return configuredIds.split(",").map(id => id.trim()).filter(Boolean).includes(userId);
}
export class LicenseError extends Error {
  constructor(public code: string, public status = 403, public timing?: { expiresAt: string | null; serverTime: string }) { super(code); }
}
