import test from "node:test";
import assert from "node:assert/strict";
import { DAY_MS, extendExpiry, licenseState, isLicenseAdmin, newSecret, secretHash } from "../src/lib/licensing/policy.ts";
import { createLicenseClient, ExtensionLicenseError } from "../extension/src/lib/license-client.ts";

const now = new Date("2026-10-10T00:00:00Z");
test("exact 24-hour / 30-day boundary and suspension precedence", () => {
  assert.equal(extendExpiry(null, now, 1).getTime(), +now + DAY_MS);
  assert.equal(extendExpiry(null, now, 30).getTime(), +now + 30 * DAY_MS);
  assert.equal(licenseState({ suspended: false, expiresAt: now }, now), "expired");
  assert.equal(licenseState({ suspended: false, expiresAt: new Date(+now + 1) }, now), "active");
  assert.equal(licenseState({ suspended: true, expiresAt: now }, now), "suspended");
  assert.equal(licenseState({ suspended: false, expiresAt: null }, now), "pending");
});
test("renewal preserves unused time and restarts expired licenses from now", () => {
  assert.equal(+extendExpiry(new Date(+now + DAY_MS), now, 30), +now + 31 * DAY_MS);
  assert.equal(+extendExpiry(new Date(+now - DAY_MS), now, 30), +now + 30 * DAY_MS);
});
test("admin is fail-closed and exact IDs only; secrets have random 256-bit payloads", () => {
  assert.equal(isLicenseAdmin("admin", ""), false);
  assert.equal(isLicenseAdmin("admin", " admin , another "), true);
  assert.equal(isLicenseAdmin("adm", "admin"), false);
  const key = newSecret("AAS"); assert.match(key, /^AAS_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(newSecret("AAS"), key); assert.notEqual(secretHash(key), key);
  assert.equal(secretHash(key).length, 64);
});
function harness() {
  let stored; const requests = []; const published = [];
  let result = { ok: true, status: "active", token: "activation_secret", expiresAt: "2026-11-10T00:00:00Z", serverTime: now.toISOString() };
  let networkError = false;
  const deps = {
    read: async () => stored, write: async value => { stored = structuredClone(value); },
    fetch: async (url, options) => {
      requests.push({ url, options }); if (networkError) throw new Error("offline");
      return Response.json(result, { status: result.ok ? 200 : 403 });
    }, status: async value => { published.push(value); }, serverUrl: "https://licenses.test",
  };
  return { client: createLicenseClient(deps), deps, requests, published, stored: () => stored, result: value => { result = value; }, offline: () => { networkError = true; } };
}
test("activation vault is durable across worker restarts and contains no raw license key", async () => {
  const h = harness();
  await assert.rejects(h.client.check(), { code: "not_activated" });
  assert.equal(h.requests.length, 0);
  const activation = await h.client.activate("AAS_test_key");
  assert.equal(activation.token, undefined);
  assert.equal(h.stored().token, "activation_secret");
  assert.equal(JSON.stringify(h.stored()).includes("AAS_test_key"), false);
  const restarted = createLicenseClient(h.deps); await restarted.check();
  assert.equal(h.requests[0].options.cache, "no-store");
  assert.equal(h.requests[0].options.credentials, "omit");
  assert.equal(h.requests[0].options.redirect, "error");
  assert.equal(JSON.stringify(h.published).includes("activation_secret"), false);
});
test("no cached rights: offline, revoked and expired checks block each next action", async () => {
  const h = harness(); await h.client.activate("key"); await h.client.check();
  h.result({ ok: false, code: "expired" });
  await assert.rejects(h.client.check(), { code: "expired" });
  h.result({ ok: false, code: "invalid_token" });
  await assert.rejects(h.client.check(), { code: "invalid_token" });
  h.offline(); await assert.rejects(h.client.check(), { code: "server_unavailable" });
  assert.equal(h.requests.length, 5); assert.equal(h.published.at(-1).ok, false);
});
test("denied licenses keep the server expiry visible without granting usage", async () => {
  const h = harness(); await h.client.activate("key");
  const expiresAt = "2026-10-09T00:00:00Z";
  h.result({ ok: false, code: "expired", expiresAt, serverTime: now.toISOString() });
  await assert.rejects(h.client.check(), { code: "expired", expiresAt });
  assert.equal(h.published.at(-1).ok, false); assert.equal(h.published.at(-1).expiresAt, expiresAt);
  assert.equal(JSON.stringify(h.published).includes("activation_secret"), false);
});
test("modified local countdown and system clock do not grant access", async () => {
  const h = harness(); await h.client.activate("key");
  h.published.push({ ok: true, expiresAt: "2099-01-01T00:00:00Z" });
  const oldNow = Date.now; Date.now = () => 0;
  try { h.result({ ok: false, code: "expired" }); await assert.rejects(h.client.check(), ExtensionLicenseError); }
  finally { Date.now = oldNow; }
});
test("malformed success response cannot grant usage", async () => {
  const h = harness(); h.result({ ok: true, status: "active", token: "s", expiresAt: "2026-11-10T00:00:00Z", serverTime: "invalid" });
  await assert.rejects(h.client.activate("key"), { code: "server_unavailable" });
});
