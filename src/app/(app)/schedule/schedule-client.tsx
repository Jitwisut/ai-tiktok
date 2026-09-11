"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const PLATFORMS = [
  { value: "tiktok", label: "TikTok" },
  { value: "instagram", label: "Instagram Reels" },
  { value: "youtube", label: "YouTube Shorts" },
];

const STATUS_LABEL: Record<string, string> = {
  scheduled: "ตั้งเวลาไว้",
  posted: "โพสต์แล้ว",
  failed: "ล้มเหลว",
  cancelled: "ยกเลิกแล้ว",
};

type VideoOption = { id: string; label: string };
type ScheduledPost = {
  id: string;
  platform: string;
  status: string;
  scheduledAt: string;
  error: string | null;
  productName: string;
  hook: string;
};

export function ScheduleClient({
  videos,
  scheduledPosts,
}: {
  videos: VideoOption[];
  scheduledPosts: ScheduledPost[];
}) {
  const router = useRouter();
  const [videoId, setVideoId] = useState(videos[0]?.id ?? "");
  const [platform, setPlatform] = useState("tiktok");
  const [scheduledAt, setScheduledAt] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!videoId || !scheduledAt) return;

    setSubmitting(true);
    const res = await fetch("/api/scheduled-posts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        videoId,
        platform,
        scheduledAt: new Date(scheduledAt).toISOString(),
      }),
    });
    setSubmitting(false);

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      toast.error(body?.error ?? "ตั้งเวลาโพสต์ไม่สำเร็จ");
      return;
    }

    toast.success("ตั้งเวลาโพสต์แล้ว");
    setScheduledAt("");
    router.refresh();
  }

  async function handleCancel(id: string) {
    const res = await fetch(`/api/scheduled-posts/${id}`, { method: "DELETE" });
    if (!res.ok) {
      toast.error("ยกเลิกไม่สำเร็จ");
      return;
    }
    toast.success("ยกเลิกแล้ว");
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Schedule</h1>

      <Card>
        <CardHeader>
          <CardTitle>ตั้งเวลาโพสต์วิดีโอ</CardTitle>
        </CardHeader>
        <CardContent>
          {videos.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              ยังไม่มีวิดีโอที่สร้างเสร็จให้ตั้งเวลาโพสต์
            </p>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col gap-4 sm:flex-row sm:items-end sm:flex-wrap">
              <div className="flex min-w-48 flex-1 flex-col gap-2">
                <Label>วิดีโอ</Label>
                <Select value={videoId} onValueChange={(v) => v && setVideoId(v)}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {videos.map((v) => (
                      <SelectItem key={v.id} value={v.id}>
                        {v.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-2">
                <Label>แพลตฟอร์ม</Label>
                <Select value={platform} onValueChange={(v) => v && setPlatform(v)}>
                  <SelectTrigger className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PLATFORMS.map((p) => (
                      <SelectItem key={p.value} value={p.value}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="scheduledAt">วันเวลาที่โพสต์</Label>
                <Input
                  id="scheduledAt"
                  type="datetime-local"
                  value={scheduledAt}
                  onChange={(e) => setScheduledAt(e.target.value)}
                  required
                />
              </div>
              <Button type="submit" disabled={submitting}>
                {submitting ? "กำลังตั้งเวลา..." : "ตั้งเวลาโพสต์"}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>

      {scheduledPosts.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            ยังไม่มีโพสต์ที่ตั้งเวลาไว้
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-2">
          {scheduledPosts.map((p) => (
            <Card key={p.id}>
              <CardContent className="flex items-center justify-between gap-3 py-4">
                <div>
                  <p className="text-sm font-medium">
                    {p.productName} — {p.hook}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {PLATFORMS.find((x) => x.value === p.platform)?.label ?? p.platform} ·{" "}
                    {new Date(p.scheduledAt).toLocaleString("th-TH")}
                  </p>
                  {p.error && <p className="text-xs text-destructive">{p.error}</p>}
                </div>
                <div className="flex items-center gap-2">
                  <Badge
                    variant={
                      p.status === "posted"
                        ? "default"
                        : p.status === "failed"
                          ? "destructive"
                          : "secondary"
                    }
                  >
                    {STATUS_LABEL[p.status] ?? p.status}
                  </Badge>
                  {p.status === "scheduled" && (
                    <Button size="sm" variant="ghost" onClick={() => handleCancel(p.id)}>
                      ยกเลิก
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
