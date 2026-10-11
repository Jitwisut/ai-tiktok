import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
const url = process.env.LICENSE_TEST_URL;
const connectionString = process.env.LICENSE_TEST_DATABASE_URL;
test("license HTTP endpoints with real Better Auth sessions", { skip: !url || !connectionString }, async t => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = randomUUID(); const ids = ["license-http-admin", `license-http-customer-${suffix}`]; const licenses = []; const createdUserIds = [];
  const password = `Test!${suffix}`;
  const request = async (path, body, cookie, origin = process.env.LICENSE_TEST_AUTH_ORIGIN || url) => fetch(url + path, { method: body ? "POST" : "GET", headers: { ...(process.env.LICENSE_TEST_AUTH_ORIGIN ? { "X-Forwarded-Proto": "https" } : {}), ...(body ? { "Content-Type": "application/json", Origin: origin } : {}), ...(cookie ? { Cookie: cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: "manual" });
  async function login(id) {
    const email = `${id}@license-test.invalid`;
    await db.user.create({ data: { id, name: "HTTP license test", email, emailVerified: true } });
    createdUserIds.push(id);
    await db.account.create({ data: { id: randomUUID(), accountId: id, providerId: "credential", userId: id, password: await hashPassword(password) } });
    const response = await request("/api/auth/sign-in/email", { email, password });
    assert.equal(response.status, 200, "test account can log in");
    return response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  }
  try {
    const admin = await login(ids[0]); const customer = await login(ids[1]);
    await t.test("public signup is disabled and database-backed login rate limiting is active", async () => {
      const response = await request("/api/auth/sign-up/email", { email: `signup-${suffix}@license-test.invalid`, password, name: "Blocked signup" });
      assert.equal(response.status, 400);
      assert.equal(await db.user.count({ where: { email: `signup-${suffix}@license-test.invalid` } }), 0);
      assert.ok(await db.rateLimit.count() > 0);
    });
    await t.test("anonymous, ordinary account and forged session cannot access admin APIs", async () => {
      assert.equal((await request("/api/admin/licenses")).status, 401);
      assert.equal((await request("/api/admin/licenses", null, customer)).status, 403);
      const customerPage = await request("/admin/licenses", null, customer);
      assert.match(await customerPage.text(), /ไม่มีสิทธิ์จัดการ License/);
      assert.equal((await request("/api/admin/licenses", null, "better-auth.session_token=fake")).status, 401);
      const input = { requestId: randomUUID(), action: "create", name: "Forbidden", days: 1 };
      assert.equal((await request("/api/admin/licenses", input, customer)).status, 403);
      assert.equal((await request("/api/admin/licenses", input, admin, "https://foreign.invalid")).status, 403);
    });
    await t.test("admin page renders and key activation validates one profile", async () => {
      const page = await request("/admin/licenses", null, admin); assert.equal(page.status, 200); assert.match(await page.text(), /จัดการ License/);
      const input = { requestId: randomUUID(), action: "create", name: "HTTP customer", contact: "test", days: 30, note: "paid test" };
      const createdResponse = await request("/api/admin/licenses", input, admin); assert.equal(createdResponse.status, 200);
      const created = await createdResponse.json(); licenses.push(created.license.id); assert.ok(created.key.startsWith("AAS_"));
      const replay = await request("/api/admin/licenses", input, admin); assert.equal((await replay.json()).key, null);
      const installationId = randomUUID();
      const activationResponse = await request("/api/licenses/activate", { key: created.key, installationId }); assert.equal(activationResponse.status, 200);
      assert.equal(activationResponse.headers.get("cache-control"), "no-store");
      const activation = await activationResponse.json();
      assert.equal(Date.parse(activation.expiresAt) - Date.parse(activation.serverTime), 30 * 86400000);
      assert.equal((await request("/api/licenses/activate", { key: created.key, installationId: randomUUID() })).status, 403);
      assert.equal((await request("/api/licenses/validate", { token: activation.token, installationId })).status, 200);
      const list = await (await request("/api/admin/licenses", null, admin)).text();
      assert.equal(list.includes(created.key), false); assert.equal(list.includes(activation.token), false); assert.equal(list.includes("keyHash"), false); assert.equal(list.includes("tokenHash"), false);
      const suspended = await request("/api/admin/licenses", { requestId: randomUUID(), action: "suspend", licenseId: created.license.id }, admin); assert.equal(suspended.status, 200);
      const denied = await request("/api/licenses/validate", { token: activation.token, installationId }); const deniedBody = await denied.json();
      assert.equal(deniedBody.code, "suspended"); assert.equal(deniedBody.expiresAt, activation.expiresAt); assert.ok(deniedBody.serverTime);
      const rotated = await request("/api/admin/licenses", { requestId: randomUUID(), action: "rotate", licenseId: created.license.id }, admin); assert.equal(rotated.status, 200);
      const invalid = await request("/api/licenses/validate", { token: activation.token, installationId }); assert.equal((await invalid.json()).code, "invalid_token");
    });
    await t.test("malformed body and unknown key return explicit errors without granting access", async () => {
      const invalid = await request("/api/licenses/activate", { key: "x", installationId: "bad" }); assert.equal(invalid.status, 400);
      const unknown = await request("/api/licenses/activate", { key: "AAS_" + "x".repeat(43), installationId: randomUUID() }); assert.equal(unknown.status, 401); assert.equal((await unknown.json()).code, "invalid_key");
    });
    await t.test("repeated invalid activation attempts are throttled", async () => {
      const input = { key: "AAS_" + randomUUID(), installationId: randomUUID() };
      let limited = false;
      for (let attempt = 0; attempt < 22; attempt++) {
        const response = await request("/api/licenses/activate", input);
        if (response.status === 429) {
          assert.equal(response.headers.get("retry-after"), "60");
          assert.equal((await response.json()).code, "rate_limited"); limited = true; break;
        }
        assert.equal(response.status, 401);
      }
      assert.equal(limited, true);
    });
  } finally {
    const customers = await db.license.findMany({ where: { id: { in: licenses } }, select: { customerId: true } });
    await db.licenseEvent.deleteMany({ where: { licenseId: { in: licenses } } });
    await db.licenseActivation.deleteMany({ where: { licenseId: { in: licenses } } });
    await db.license.deleteMany({ where: { id: { in: licenses } } });
    await db.licenseCustomer.deleteMany({ where: { id: { in: customers.map(c => c.customerId) } } });
    await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await db.$disconnect();
  }
});
