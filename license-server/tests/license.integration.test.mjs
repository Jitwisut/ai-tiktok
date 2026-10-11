import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { createLicenseService } from "../src/services/license.service.ts";
import { DAY_MS, secretHash } from "../src/lib/licensing/policy.ts";
const connectionString = process.env.LICENSE_TEST_DATABASE_URL;
test("PostgreSQL license transactions and lifecycle", { skip: !connectionString }, async t => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const service = createLicenseService(db); const ids = [];
  async function issue(days = 30) {
    const result = await service.command("admin-test", { requestId: randomUUID(), action: "create", name: "License integration test", contact: "test only", days });
    ids.push(result.license.id); return result;
  }
  const act = (action, licenseId, extra = {}) => service.command("admin-test", { requestId: randomUUID(), action, licenseId, ...extra });
  try {
    await t.test("1 and 30 days start on first activation and never restart", async () => {
      for (const days of [1, 30]) {
        const issued = await issue(days); assert.equal(issued.license.expiresAt, null);
        const installationId = randomUUID(); const first = await service.activate(issued.key, installationId);
        assert.equal(Date.parse(first.expiresAt) - Date.parse(first.serverTime), days * DAY_MS);
        const repeat = await service.activate(issued.key, installationId);
        assert.equal(repeat.expiresAt, first.expiresAt);
        assert.equal((await service.validate(repeat.token, installationId)).status, "active");
        const stored = await db.license.findUnique({ where: { id: issued.license.id }, include: { activation: true } });
        assert.equal(stored.keyHash, secretHash(issued.key));
        assert.equal(stored.activation.tokenHash, secretHash(repeat.token));
        assert.equal((await service.events(issued.license.id)).filter(e => e.action === "activate").length, 1);
      }
    });
    await t.test("two profiles activate simultaneously: exactly one wins", async () => {
      const issued = await issue();
      const results = await Promise.allSettled([service.activate(issued.key, randomUUID()), service.activate(issued.key, randomUUID())]);
      assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
      assert.equal(results.find(r => r.status === "rejected").reason.code, "profile_limit");
      assert.equal(await db.licenseActivation.count({ where: { licenseId: issued.license.id } }), 1);
    });
    await t.test("duplicate extension of a pending license is applied once", async () => {
      const issued = await issue(1);
      const command = { action: "extend", licenseId: issued.license.id, requestId: randomUUID(), days: 30, note: "payment test" };
      const results = await Promise.all([service.command("admin-test", command), service.command("admin-test", command)]);
      assert.equal(results.filter(r => r.replayed).length, 1);
      const license = await db.license.findUnique({ where: { id: issued.license.id } });
      assert.equal(license.durationDays, 31); assert.equal(license.expiresAt, null);
      await assert.rejects(service.command("admin-test", { ...command, days: 7 }), { code: "idempotency_conflict" });
      await assert.rejects(service.command("different-admin", command), { code: "idempotency_conflict" });
    });
    await t.test("extend preserves unused time; expired restart; suspend never freezes days", async () => {
      const issued = await issue(1); const installationId = randomUUID(); const active = await service.activate(issued.key, installationId);
      const extended = await act("extend", issued.license.id, { days: 30 });
      assert.equal(+extended.license.expiresAt, Date.parse(active.expiresAt) + 30 * DAY_MS);
      await act("suspend", issued.license.id);
      await assert.rejects(service.validate(active.token, installationId), { code: "suspended" });
      const past = new Date(Date.now() - 1000); await db.license.update({ where: { id: issued.license.id }, data: { expiresAt: past } });
      const restored = await act("restore", issued.license.id); assert.equal(+restored.license.expiresAt, +past);
      await assert.rejects(service.validate(active.token, installationId), { code: "expired" });
      const before = Date.now(); const renewed = await act("extend", issued.license.id, { days: 1 });
      assert.ok(+renewed.license.expiresAt >= before + DAY_MS && +renewed.license.expiresAt <= Date.now() + DAY_MS);
    });
    await t.test("rotate preserves entitlement and immediately invalidates old key/token", async () => {
      const issued = await issue(); const installationId = randomUUID(); const active = await service.activate(issued.key, installationId);
      const rotated = await act("rotate", issued.license.id);
      assert.equal(+rotated.license.expiresAt, Date.parse(active.expiresAt));
      await assert.rejects(service.validate(active.token, installationId), { code: "invalid_token" });
      await assert.rejects(service.activate(issued.key, installationId), { code: "invalid_key" });
      const moved = await service.activate(rotated.key, randomUUID()); assert.equal(moved.expiresAt, active.expiresAt);
      const events = await service.events(issued.license.id); assert.equal(events.filter(e => e.action === "activate").length, 1);
    });
    await t.test("validation on another profile or unknown secrets is rejected", async () => {
      const issued = await issue(); const active = await service.activate(issued.key, randomUUID());
      await assert.rejects(service.validate(active.token, randomUUID()), { code: "invalid_token" });
      await assert.rejects(service.activate("AAS_wrong", randomUUID()), { code: "invalid_key" });
    });
  } finally {
    // Delete only records created by this test, leaving every other database record alone.
    const customers = await db.license.findMany({ where: { id: { in: ids } }, select: { customerId: true } });
    await db.licenseEvent.deleteMany({ where: { licenseId: { in: ids } } });
    await db.licenseActivation.deleteMany({ where: { licenseId: { in: ids } } });
    await db.license.deleteMany({ where: { id: { in: ids } } });
    await db.licenseCustomer.deleteMany({ where: { id: { in: customers.map(c => c.customerId) } } });
    await db.$disconnect();
  }
});
