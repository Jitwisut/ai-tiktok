import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
const url = process.env.LICENSE_TEST_PRODUCTION_URL;
test("isolated production app exposes only licenses/auth/admin and enforces HTTPS", { skip: !url }, async () => {
  for (const path of ["/api/products/extension", "/api/contents/extension/generate", "/api/videos/extension/pending", "/api/posts/extension/pending", "/api/extension/dev-bridge"]) {
    assert.equal((await fetch(url + path, { headers: { "x-extension-token": "old-secret" } })).status, 404, path);
  }
  const health = await fetch(url + "/api/health");
  assert.equal(health.status, 200);
  assert.equal(health.headers.get("cache-control"), "no-store");
  for (const action of ["activate", "validate"]) {
    const body = JSON.stringify({ [action === "activate" ? "key" : "token"]: "AAS_" + randomUUID(), installationId: randomUUID() });
    const insecure = await fetch(url + `/api/licenses/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    assert.equal(insecure.status, 400);
    assert.equal((await insecure.json()).code, "https_required");
    // Local test only: simulates Vercel's HTTPS termination.
    const secure = await fetch(url + `/api/licenses/${action}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-Proto": "https" }, body });
    assert.equal(secure.status, 401);
    assert.equal((await secure.json()).code, action === "activate" ? "invalid_key" : "invalid_token");
  }
});
