import { headers } from "next/headers";
import { auth } from "@/lib/auth/auth";
import { getAnalytics } from "@/services/analytics.service";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default async function AnalyticsPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  const stats = await getAnalytics(session!.user.id);

  const tiles = [
    { label: "สินค้าที่เพิ่ม", value: stats.productsCount },
    { label: "คอนเทนต์ที่สร้าง", value: stats.contentsCount },
    { label: "วิดีโอทั้งหมด", value: stats.videosTotal },
    { label: "วิดีโอสำเร็จ", value: stats.videosCompleted },
    { label: "วิดีโอล้มเหลว", value: stats.videosFailed },
    { label: "อัตราความสำเร็จ", value: `${stats.successRate.toFixed(0)}%` },
    { label: "เครดิตที่ใช้ไป", value: stats.creditsUsed },
    {
      label: "เวลาสร้างวิดีโอเฉลี่ย",
      value: stats.videosCompleted > 0 ? `${stats.avgGenerationSeconds}s` : "-",
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Analytics</h1>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((t) => (
          <Card key={t.label}>
            <CardHeader>
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {t.label}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-semibold">{t.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
