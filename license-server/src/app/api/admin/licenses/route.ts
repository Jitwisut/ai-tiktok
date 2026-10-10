import { z } from "zod";
import { assertAdminOrigin, requireLicenseAdmin, licenseService, licenseResponseError } from "@/lib/licensing/server";
import { LicenseError } from "@/lib/licensing/policy";
const schema = z.object({
  requestId: z.uuid(), action: z.enum(["create", "extend", "suspend", "restore", "rotate"]),
  licenseId: z.string().max(100).optional(), days: z.number().int().min(1).max(3650).optional(),
  name: z.string().trim().min(1).max(160).optional(), contact: z.string().max(200).optional(), note: z.string().max(1000).optional(),
}).strict();
export async function GET(request: Request) {
  try {
    await requireLicenseAdmin(request.headers);
    const url = new URL(request.url);
    const id = url.searchParams.get("licenseId");
    const result = id ? { events: await licenseService.events(id) } : { licenses: await licenseService.list(url.searchParams.get("q") ?? "") };
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return licenseResponseError(error, "admin_list"); }
}
export async function POST(request: Request) {
  try {
    const actor = await requireLicenseAdmin(request.headers);
    assertAdminOrigin(request);
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new LicenseError("invalid_request", 400);
    return Response.json(await licenseService.command(actor, parsed.data), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return licenseResponseError(error, "admin_command"); }
}
