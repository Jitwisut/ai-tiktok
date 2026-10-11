import { z } from "zod";
import { assertSecureTransport, licenseService, licenseResponseError, rateLimitLicense } from "@/lib/licensing/server";
import { LicenseError } from "@/lib/licensing/policy";
export const runtime = "nodejs";
const schema = z.object({ token: z.string().min(20).max(128), installationId: z.uuid() }).strict();
export async function POST(request: Request) {
  try {
    assertSecureTransport(request);
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new LicenseError("invalid_request", 400);
    await rateLimitLicense("validate", parsed.data.token);
    const result = await licenseService.validate(parsed.data.token, parsed.data.installationId);
    console.info(JSON.stringify({ event: "license_validate_ok" }));
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return licenseResponseError(error, "validate"); }
}
