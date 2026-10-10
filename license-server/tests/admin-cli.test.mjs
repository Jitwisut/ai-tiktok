import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { verifyPassword } from "better-auth/crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
const connectionString = process.env.LICENSE_TEST_DATABASE_URL;
test("provision admin privately without public signup or overwriting existing credentials", { skip: !connectionString }, async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const email = `cli-${randomUUID()}@license-test.invalid`;
  const password = `Test!${randomUUID()}`;
  const run = input => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/create-admin.ts", email, "CLI test"], { env: { ...process.env, DATABASE_URL: connectionString, DIRECT_URL: connectionString }, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", data => { output += data; });
    child.stderr.on("data", data => { output += data; });
    child.on("error", reject);
    child.on("close", code => resolve({ code, output }));
    child.stdin.end(input + "\n");
  });
  try {
    assert.equal((await run("short")).code, 1);
    assert.equal(await db.user.count({ where: { email } }), 0);
    const first = await run(password);
    assert.equal(first.code, 0, first.output);
    const user = await db.user.findUnique({ where: { email }, include: { accounts: true } });
    assert.ok(first.output.includes(`LICENSE_ADMIN_USER_IDS=${user.id}`));
    assert.equal(first.output.includes(password), false);
    assert.equal(await verifyPassword({ hash: user.accounts[0].password, password }), true);
    const again = await run(`Different!${randomUUID()}`);
    assert.equal(again.code, 1);
    assert.equal((await db.account.findFirst({ where: { userId: user.id } })).password, user.accounts[0].password);
  } finally {
    await db.user.deleteMany({ where: { email } });
    await db.$disconnect();
  }
});
