import test from "node:test";
import assert from "node:assert/strict";
import { validateServerEnvironment } from "../src/lib/environment.ts";
const valid = { DATABASE_URL: "postgresql://user:secret@localhost:5432/license", BETTER_AUTH_URL: "https://license.example.com", BETTER_AUTH_SECRET: "x".repeat(32) };
test("Vercel settings require PostgreSQL, HTTPS origin and a strong auth secret", () => {
  assert.equal(validateServerEnvironment(valid, true).authOrigin, valid.BETTER_AUTH_URL);
  for (const changes of [{ DATABASE_URL: "" }, { DATABASE_URL: "sqlite://file" }, { BETTER_AUTH_URL: "http://localhost:3000" }, { BETTER_AUTH_URL: "" }, { BETTER_AUTH_URL: "https://license.example.com/path" }, { BETTER_AUTH_URL: "https://user:password@license.example.com" }, { BETTER_AUTH_SECRET: "short" }]) {
    assert.throws(() => validateServerEnvironment({ ...valid, ...changes }, true));
  }
  assert.equal(validateServerEnvironment({ DATABASE_URL: valid.DATABASE_URL }, false).authOrigin, "http://localhost:3000");
});
test("bad connection URLs never echo credentials in errors", () => {
  for (const setting of ["DATABASE_URL", "BETTER_AUTH_URL"]) {
    assert.throws(() => validateServerEnvironment({ ...valid, [setting]: "broken-secret-connection-value" }, true), error => !error.message.includes("broken-secret"));
  }
});
