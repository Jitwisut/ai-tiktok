import type { PrismaClient, Prisma } from "../generated/prisma/client";
import { DAY_MS, extendExpiry, licenseState, LicenseError, newSecret, secretHash } from "../lib/licensing/policy";

type Tx = Prisma.TransactionClient;
export type LicenseCommand = {
  requestId: string; action: "create" | "extend" | "suspend" | "restore" | "rotate";
  licenseId?: string; days?: number; name?: string; contact?: string; note?: string;
};
const safeSelect = {
  id: true, keyHint: true, durationDays: true, activatedAt: true, expiresAt: true,
  suspended: true, createdAt: true, customer: true,
  activation: { select: { installationId: true, createdAt: true, lastSeenAt: true } },
} satisfies Prisma.LicenseSelect;
async function serverTime(tx: Tx): Promise<Date> {
  // Epoch avoids driver conversion of timestamptz using the database server timezone.
  const [row] = await tx.$queryRaw<{ milliseconds: number }[]>`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::double precision AS milliseconds`;
  return new Date(row.milliseconds);
}
async function lockLicense(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM licenses WHERE id = ${id} FOR UPDATE`;
}

export function createLicenseService(db: PrismaClient) {
  async function activate(key: string, installationId: string) {
    const keyHash = secretHash(key);
    const result = await db.$transaction(async tx => {
      const found = await tx.license.findUnique({ where: { keyHash }, select: { id: true } });
      if (!found) throw new LicenseError("invalid_key", 401);
      await lockLicense(tx, found.id);
      const license = await tx.license.findUniqueOrThrow({ where: { id: found.id }, include: { activation: true } });
      // A key could have been rotated while this request waited for the lock.
      if (license.keyHash !== keyHash) throw new LicenseError("invalid_key", 401);
      const now = await serverTime(tx);
      const state = licenseState(license, now);
      if (state === "suspended" || state === "expired") throw new LicenseError(state, 403, { expiresAt: license.expiresAt?.toISOString() ?? null, serverTime: now.toISOString() });
      if (license.activation && license.activation.installationId !== installationId) throw new LicenseError("profile_limit");
      const token = newSecret("activation");
      await tx.licenseActivation.upsert({
        where: { licenseId: license.id },
        create: { licenseId: license.id, installationId, tokenHash: secretHash(token), lastSeenAt: now },
        update: { tokenHash: secretHash(token), lastSeenAt: now },
      });
      const expiresAt = license.expiresAt ?? new Date(now.getTime() + license.durationDays * DAY_MS);
      if (!license.activatedAt) {
        await tx.license.update({ where: { id: license.id }, data: { activatedAt: now, expiresAt } });
        await tx.licenseEvent.create({ data: {
          licenseId: license.id, requestId: newSecret("activation_event"), requestHash: keyHash,
          actorId: `installation:${installationId}`, action: "activate", newExpiry: expiresAt,
        } });
      }
      return { ok: true as const, status: "active" as const, token, expiresAt: expiresAt.toISOString(), serverTime: now.toISOString() };
    });
    return result;
  }

  async function validate(token: string, installationId: string) {
    return db.$transaction(async tx => {
      const tokenHash = secretHash(token);
      const found = await tx.licenseActivation.findUnique({ where: { tokenHash } });
      if (!found || found.installationId !== installationId) throw new LicenseError("invalid_token", 401);
      await lockLicense(tx, found.licenseId);
      const activation = await tx.licenseActivation.findUnique({ where: { tokenHash }, include: { license: true } });
      if (!activation || activation.installationId !== installationId) throw new LicenseError("invalid_token", 401);
      const now = await serverTime(tx);
      const state = licenseState(activation.license, now);
      if (state !== "active") throw new LicenseError(state, 403, { expiresAt: activation.license.expiresAt?.toISOString() ?? null, serverTime: now.toISOString() });
      await tx.licenseActivation.update({ where: { id: activation.id }, data: { lastSeenAt: now } });
      return { ok: true as const, status: state, expiresAt: activation.license.expiresAt!.toISOString(), serverTime: now.toISOString() };
    });
  }

  async function command(actorId: string, input: LicenseCommand) {
    if (["create", "extend"].includes(input.action) && (!Number.isSafeInteger(input.days) || input.days! < 1 || input.days! > 3650)) throw new LicenseError("invalid_days", 400);
    if (input.action === "create" && !input.name?.trim()) throw new LicenseError("invalid_customer", 400);
    const requestHash = secretHash(JSON.stringify({ actorId, ...input }));
    return db.$transaction(async tx => {
      // Serializes duplicate admin submissions even across different server instances.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${input.requestId}))::text`;
      const previous = await tx.licenseEvent.findUnique({ where: { requestId: input.requestId } });
      if (previous) {
        if (previous.actorId !== actorId || previous.requestHash !== requestHash) throw new LicenseError("idempotency_conflict", 409);
        return { ok: true, replayed: true, license: await tx.license.findUnique({ where: { id: previous.licenseId }, select: safeSelect }), key: null };
      }
      let rawKey: string | null = null;
      let id = input.licenseId;
      let previousExpiry: Date | null = null;
      if (input.action === "create") {
        rawKey = newSecret("AAS");
        const created = await tx.license.create({ data: {
          customer: { create: { name: input.name!.trim(), contact: input.contact?.trim() || null } },
          keyHash: secretHash(rawKey), keyHint: rawKey.slice(-8), durationDays: input.days!,
        } });
        id = created.id;
      } else {
        if (!id) throw new LicenseError("missing_license", 400);
        await lockLicense(tx, id);
        const license = await tx.license.findUnique({ where: { id } });
        if (!license) throw new LicenseError("not_found", 404);
        previousExpiry = license.expiresAt;
        const now = await serverTime(tx);
        if (input.action === "extend") {
          await tx.license.update({ where: { id }, data: license.expiresAt
            ? { expiresAt: extendExpiry(license.expiresAt, now, input.days!) }
            : { durationDays: { increment: input.days! } } });
        } else if (input.action === "rotate") {
          rawKey = newSecret("AAS");
          await tx.licenseActivation.deleteMany({ where: { licenseId: id } });
          await tx.license.update({ where: { id }, data: { keyHash: secretHash(rawKey), keyHint: rawKey.slice(-8) } });
        } else {
          await tx.license.update({ where: { id }, data: { suspended: input.action === "suspend" } });
        }
      }
      const license = await tx.license.findUniqueOrThrow({ where: { id }, select: safeSelect });
      await tx.licenseEvent.create({ data: {
        licenseId: license.id, requestId: input.requestId, requestHash, actorId, action: input.action,
        days: input.days, note: input.note?.trim() || null, previousExpiry, newExpiry: license.expiresAt,
      } });
      return { ok: true, replayed: false, license, key: rawKey };
    });
  }

  async function list(query = "") {
    const q = query.trim().slice(0, 160);
    const now = new Date();
    const licenses = await db.license.findMany({
      where: q ? { OR: [
        { keyHint: { contains: q, mode: "insensitive" } },
        { id: q }, { keyHash: secretHash(q) },
        { customer: { name: { contains: q, mode: "insensitive" } } },
        { customer: { contact: { contains: q, mode: "insensitive" } } },
      ] } : {},
      orderBy: { createdAt: "desc" }, take: 100, select: safeSelect,
    });
    return licenses.map(license => ({ ...license, status: licenseState(license, now) }));
  }
  async function events(licenseId: string) {
    return db.licenseEvent.findMany({ where: { licenseId }, orderBy: { createdAt: "desc" }, take: 100,
      select: { id: true, actorId: true, action: true, days: true, note: true, previousExpiry: true, newExpiry: true, createdAt: true } });
  }
  return { activate, validate, command, list, events };
}
