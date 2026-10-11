import { prisma } from "@/lib/db/prisma";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    await prisma.licenseRateBucket.count();
    return Response.json({ ok: true, service: "license-server" }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ ok: false, service: "license-server" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
