import { redirect } from "next/navigation";
import { requireLicenseAdmin, licenseService } from "@/lib/licensing/server";
import { LicenseError } from "@/lib/licensing/policy";
import { LicenseAdmin } from "./license-admin";
export default async function LicensesPage() {
  try { await requireLicenseAdmin(); }
  catch (error) {
    if (error instanceof LicenseError && error.status === 401) redirect("/login?next=/admin/licenses");
    if (error instanceof LicenseError && error.status === 403) return <section className="card mx-auto mt-10 max-w-md p-8 text-center"><h1 className="text-lg font-semibold">ไม่มีสิทธิ์เข้าถึง</h1><p className="mt-2 text-sm text-muted">บัญชีนี้ไม่มีสิทธิ์จัดการ License ติดต่อผู้ดูแลระบบเพื่อขอสิทธิ์</p></section>;
    throw error;
  }
  const licenses = await licenseService.list();
  return <LicenseAdmin initialLicenses={JSON.parse(JSON.stringify(licenses))} />;
}
