import { headers } from "next/headers";
import { auth } from "@/lib/auth/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CREDIT_PACKAGES } from "@/lib/billing/packages";
import { BillingSection } from "./billing-section";

export default async function SettingsPage() {
  const session = await auth.api.getSession({ headers: await headers() });

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <Card>
        <CardHeader>
          <CardTitle>บัญชีผู้ใช้</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1 text-sm">
          <p>ชื่อ: {session?.user.name}</p>
          <p>อีเมล: {session?.user.email}</p>
        </CardContent>
      </Card>
      <BillingSection
        credits={(session?.user as { credits?: number })?.credits ?? 0}
        packages={CREDIT_PACKAGES}
      />
    </div>
  );
}
