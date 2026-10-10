import { redirect } from "next/navigation";
import { requireLicenseAdmin, licenseService } from "@/lib/licensing/server";
import { LicenseError } from "@/lib/licensing/policy";
import { LicenseAdmin } from "./license-admin";
export default async function LicensesPage() {
  try { await requireLicenseAdmin(); }
  catch (error) {
    if (error instanceof LicenseError && error.status === 401) redirect("/login?next=/admin/licenses");
    if (error instanceof LicenseError && error.status === 403) return <p>บัญชีนี้ไม่มีสิทธิ์จัดการ License</p>;
    throw error;
  }
  const licenses = await licenseService.list();
  return <LicenseAdmin initialLicenses={JSON.parse(JSON.stringify(licenses))} />;
}
