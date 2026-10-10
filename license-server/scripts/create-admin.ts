import "dotenv/config";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { hashPassword } from "better-auth/crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  const name = process.argv[3]?.trim() || "License Admin";
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Usage: npm run admin:create -- "you@example.com" "Your name"');
  if (!process.env.DIRECT_URL && !process.env.DATABASE_URL) throw new Error("Set DIRECT_URL or DATABASE_URL in license-server/.env first.");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL }) });
  try {
    const existing = await db.user.findUnique({ where: { email }, select: { id: true } });
    if (existing) throw new Error(`This account already exists. Add its ID to LICENSE_ADMIN_USER_IDS: ${existing.id}`);
    let password: string;
    if (process.stdin.isTTY) {
      // The prompt is visible, but typed password characters are never echoed.
      const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
      const prompt = createInterface({ input: process.stdin, output, terminal: true });
      process.stdout.write("Admin password (12+ characters, hidden): ");
      password = await prompt.question(""); prompt.close(); process.stdout.write("\n");
    } else {
      // Allows password-manager piping without putting a secret in shell arguments.
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of process.stdin) {
        const bytes = Buffer.from(chunk); size += bytes.length;
        if (size > 1024) throw new Error("Password input is too long.");
        chunks.push(bytes);
      }
      password = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
    }
    if (password.length < 12 || password.length > 128) throw new Error("Password must contain 12–128 characters.");
    const id = randomUUID(); const hashed = await hashPassword(password);
    await db.$transaction(async tx => {
      await tx.user.create({ data: { id, email, name, emailVerified: true } });
      await tx.account.create({ data: { id: randomUUID(), accountId: id, providerId: "credential", userId: id, password: hashed } });
    });
    console.log(`Admin account created. Set LICENSE_ADMIN_USER_IDS=${id} on Vercel, then redeploy.`);
  } finally { await db.$disconnect(); }
}
main().catch(error => {
  // Prisma exceptions can contain SQL and personal data; only print deliberate validation errors.
  console.error(error instanceof Error && error.constructor === Error ? error.message : "Admin creation failed. Check database connectivity, migrations and whether the account already exists.");
  process.exitCode = 1;
});
