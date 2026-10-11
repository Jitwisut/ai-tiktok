import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
const url = process.env.LICENSE_TEST_PRODUCTION_URL;
test("production disables legacy shared-token routes and requires secure licensing transport", { skip: !url }, async () => {
  for (const [path, methods] of [
    ["/api/products/extension", ["GET", "POST", "DELETE"]],
    ["/api/products/extension/test-id/analyze", ["POST"]],
    ["/api/contents/extension", ["GET", "POST"]],
    ["/api/contents/extension/generate", ["POST"]],
    ["/api/videos/extension/pending", ["GET"]],
    ["/api/videos/extension/test-id", ["PATCH"]],
    ["/api/videos/extension/test-id/cancel", ["POST"]],
    ["/api/videos/test-id/upload", ["POST"]],
    ["/api/posts/extension/pending", ["GET"]],
    ["/api/posts/extension/test-id", ["PATCH"]],
  ]) {
    for (const method of methods) {
      const response = await fetch(url + path, { method, headers: { "x-extension-token": "old-secret" } });
      assert.equal(response.status, 404, `${method} ${path}`);
      assert.equal((await response.json()).error, "Legacy extension endpoint disabled");
    }
  }
  for (const action of ["activate", "validate"]) {
    const body = JSON.stringify({ [action === "activate" ? "key" : "token"]: "AAS_" + randomUUID(), installationId: randomUUID() });
    const insecure = await fetch(url + `/api/licenses/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    assert.equal(insecure.status, 400); assert.equal((await insecure.json()).code, "https_required");
    // Simulates the trusted HTTPS reverse proxy on a local disposable server.
    const secure = await fetch(url + `/api/licenses/${action}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-Proto": "https" }, body });
    assert.equal(secure.status, 401); assert.equal((await secure.json()).code, action === "activate" ? "invalid_key" : "invalid_token");
  }
});
