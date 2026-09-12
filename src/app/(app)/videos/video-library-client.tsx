"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

type Video = {
  id: string;
  status: string;
  videoUrl: string | null;
  thumbnailUrl: string | null;
  errorMessage: string | null;
  productName: string;
  hook: string;
  createdAt: string;
};

const COLUMNS: { key: string; label: string; statuses: string[] }[] = [
  { key: "completed", label: "Completed", statuses: ["completed"] },
  { key: "processing", label: "Processing", statuses: ["queued", "processing"] },
  { key: "failed", label: "Failed", statuses: ["failed", "cancelled"] },
];

export function VideoLibraryClient({ videos }: { videos: Video[] }) {
  const router = useRouter();
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());

  const hasPending = useMemo(
    () => videos.some((v) => v.status === "queued" || v.status === "processing"),
    [videos],
  );

  useEffect(() => {
    if (!hasPending) return;
    const interval = setInterval(() => router.refresh(), 2500);
    return () => clearInterval(interval);
  }, [hasPending, router]);

  async function handleRegenerate(videoId: string) {
    setPendingIds((prev) => new Set(prev).add(videoId));
    const res = await fetch(`/api/videos/${videoId}/regenerate`, { method: "POST" });
    setPendingIds((prev) => {
      const next = new Set(prev);
      next.delete(videoId);
      return next;
    });

    if (!res.ok) {
      toast.error("สร้างวิดีโอใหม่ไม่สำเร็จ");
      return;
    }
    toast.success("กำลังสร้างวิดีโอใหม่");
    router.refresh();
  }

  async function handleDelete(videoId: string) {
    if (!confirm("ลบวิดีโอนี้ใช่หรือไม่?")) return;
    const res = await fetch(`/api/videos/${videoId}`, { method: "DELETE" });
    if (!res.ok) {
      toast.error("ลบไม่สำเร็จ");
      return;
    }
    toast.success("ลบวิดีโอแล้ว");
    router.refresh();
  }

  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
      {COLUMNS.map((col) => {
        const items = videos.filter((v) => col.statuses.includes(v.status));
        return (
          <div key={col.key} className="flex flex-col gap-3">
            <h2 className="text-sm font-medium text-muted-foreground">
              {col.label} ({items.length})
            </h2>
            {items.map((v) => (
              <Card key={v.id}>
                {v.status === "completed" && v.videoUrl ? (
                  <video
                    src={v.videoUrl}
                    controls
                    preload="metadata"
                    className="aspect-video w-full rounded-t-xl bg-black object-contain"
                  />
                ) : v.thumbnailUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={v.thumbnailUrl}
                    alt={v.productName}
                    className="aspect-video w-full rounded-t-xl object-cover"
                  />
                ) : (
                  <div className="flex aspect-video w-full items-center justify-center rounded-t-xl bg-muted text-xs text-muted-foreground">
                    {v.status === "processing" ? "กำลังสร้าง..." : "ไม่มีภาพตัวอย่าง"}
                  </div>
                )}
                <CardContent className="flex flex-col gap-2 pt-4">
                  <p className="line-clamp-1 text-sm font-medium">{v.productName}</p>
                  <p className="line-clamp-2 text-xs text-muted-foreground">{v.hook}</p>
                  {v.errorMessage && (
                    <p className="text-xs text-destructive">{v.errorMessage}</p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {v.status === "completed" &&
                      (v.videoUrl ? (
                        <Button
                          size="sm"
                          variant="outline"
                          nativeButton={false}
                          render={
                            <a href={v.videoUrl} download>
                              ดาวน์โหลด
                            </a>
                          }
                        />
                      ) : (
                        <Button size="sm" variant="outline" disabled>
                          ไม่มีไฟล์วิดีโอ
                        </Button>
                      ))}
                    {v.status === "failed" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleRegenerate(v.id)}
                        disabled={pendingIds.has(v.id)}
                      >
                        ลองใหม่
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => handleDelete(v.id)}>
                      ลบ
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
            {items.length === 0 && (
              <p className="text-xs text-muted-foreground">ไม่มีวิดีโอในสถานะนี้</p>
            )}
          </div>
        );
      })}
    </div>
  );
}
