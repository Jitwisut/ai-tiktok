"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { CreditPackage } from "@/lib/billing/packages";

export function BillingSection({
  credits,
  packages,
}: {
  credits: number;
  packages: CreditPackage[];
}) {
  const [loadingId, setLoadingId] = useState<string | null>(null);

  async function handleBuy(packageId: string) {
    setLoadingId(packageId);
    const res = await fetch("/api/billing/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ packageId }),
    });
    setLoadingId(null);

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      toast.error(body?.error ?? "ยังไม่ได้ตั้งค่าระบบชำระเงิน (Stripe)");
      return;
    }

    const { url } = await res.json();
    if (url) window.location.assign(url);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>เครดิตและการชำระเงิน</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm">
          เครดิตคงเหลือ: <span className="font-semibold">{credits}</span>
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {packages.map((pkg) => (
            <div key={pkg.id} className="flex flex-col gap-2 rounded-md border p-3">
              <p className="font-medium">{pkg.label}</p>
              <p className="text-sm text-muted-foreground">{pkg.credits} เครดิต</p>
              <p className="text-sm font-semibold">฿{pkg.priceThb}</p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => handleBuy(pkg.id)}
                disabled={loadingId === pkg.id}
              >
                {loadingId === pkg.id ? "กำลังโหลด..." : "ซื้อ"}
              </Button>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
