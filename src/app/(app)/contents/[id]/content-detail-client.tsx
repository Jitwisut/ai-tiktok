"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Scene = {
  id: string;
  position: number;
  duration: number;
  description: string;
};

type Video = {
  id: string;
  status: string;
  videoUrl: string | null;
  thumbnailUrl: string | null;
  errorMessage: string | null;
  createdAt: string;
};

type ContentDetail = {
  id: string;
  hook: string;
  script: string;
  caption: string;
  cta: string;
  style: string;
  productName: string;
  scenes: Scene[];
};

const STATUS_LABEL: Record<string, string> = {
  queued: "รอคิว",
  processing: "กำลังสร้าง",
  completed: "เสร็จแล้ว",
  failed: "ล้มเหลว",
  cancelled: "ยกเลิก",
};

export function ContentDetailClient({
  content,
  videos,
}: {
  content: ContentDetail;
  videos: Video[];
}) {
  const router = useRouter();

  const [hook, setHook] = useState(content.hook);
  const [script, setScript] = useState(content.script);
  const [caption, setCaption] = useState(content.caption);
  const [cta, setCta] = useState(content.cta);

  const [saving, setSaving] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [creatingVideo, setCreatingVideo] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const hasPending = videos.some(
    (v) => v.status === "queued" || v.status === "processing",
  );

  useEffect(() => {
    if (!hasPending) return;
    const interval = setInterval(() => router.refresh(), 2500);
    return () => clearInterval(interval);
  }, [hasPending, router]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const res = await fetch(`/api/contents/${content.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hook, script, caption, cta }),
    });
    setSaving(false);

    if (!res.ok) {
      toast.error("บันทึกไม่สำเร็จ");
      return;
    }
    toast.success("บันทึกแล้ว");
    router.refresh();
  }

  async function handlePlanScenes() {
    setPlanning(true);
    const res = await fetch(`/api/contents/${content.id}/scenes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetDuration: 8 }),
    });
    setPlanning(false);

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      toast.error(body?.error ?? "สร้างฉากไม่สำเร็จ");
      return;
    }
    toast.success("สร้างฉากแล้ว");
    router.refresh();
  }

  async function handleCreateVideo() {
    setCreatingVideo(true);
    const res = await fetch("/api/videos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contentId: content.id }),
    });
    setCreatingVideo(false);

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      toast.error(body?.error ?? "สร้างวิดีโอไม่สำเร็จ");
      return;
    }
    toast.success("เริ่มสร้างวิดีโอแล้ว กำลังประมวลผล...");
    router.refresh();
  }

  async function handleRegenerate(videoId: string) {
    const res = await fetch(`/api/videos/${videoId}/regenerate`, {
      method: "POST",
    });
    if (!res.ok) {
      toast.error("สร้างวิดีโอใหม่ไม่สำเร็จ");
      return;
    }
    toast.success("กำลังสร้างวิดีโอใหม่");
    router.refresh();
  }

  async function handleDeleteContent() {
    if (!confirm("ลบคอนเทนต์นี้ใช่หรือไม่?")) return;
    setDeleting(true);
    const res = await fetch(`/api/contents/${content.id}`, { method: "DELETE" });
    setDeleting(false);

    if (!res.ok) {
      toast.error("ลบไม่สำเร็จ");
      return;
    }
    toast.success("ลบคอนเทนต์แล้ว");
    router.push("/contents");
    router.refresh();
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold">{content.productName}</h1>
          <Badge variant="secondary">{content.style}</Badge>
        </div>
        <Button variant="destructive" onClick={handleDeleteContent} disabled={deleting}>
          {deleting ? "กำลังลบ..." : "ลบคอนเทนต์"}
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Hook / Script / Caption / CTA</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSave} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="hook">Hook</Label>
              <Textarea id="hook" value={hook} onChange={(e) => setHook(e.target.value)} rows={2} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="script">Script</Label>
              <Textarea id="script" value={script} onChange={(e) => setScript(e.target.value)} rows={4} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="caption">Caption</Label>
              <Textarea id="caption" value={caption} onChange={(e) => setCaption(e.target.value)} rows={2} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="cta">CTA</Label>
              <Input id="cta" value={cta} onChange={(e) => setCta(e.target.value)} />
            </div>
            <Button type="submit" disabled={saving}>
              {saving ? "กำลังบันทึก..." : "บันทึก"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Scenes</CardTitle>
            <Button size="sm" variant="outline" onClick={handlePlanScenes} disabled={planning}>
              {planning ? "กำลังสร้าง..." : content.scenes.length ? "สร้างฉากใหม่" : "สร้างฉาก"}
            </Button>
          </div>
        </CardHeader>
        {content.scenes.length > 0 && (
          <CardContent className="flex flex-col gap-2">
            {content.scenes.map((scene) => (
              <div key={scene.id} className="flex gap-3 rounded-md border p-3 text-sm">
                <Badge variant="outline" className="shrink-0">
                  {scene.duration}s
                </Badge>
                <p className="text-muted-foreground">{scene.description}</p>
              </div>
            ))}
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>สร้างวิดีโอ</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Button
            onClick={handleCreateVideo}
            disabled={creatingVideo || content.scenes.length === 0}
          >
            {creatingVideo ? "กำลังส่งงาน..." : "Generate Video (20 เครดิต)"}
          </Button>
          {content.scenes.length === 0 && (
            <p className="text-xs text-muted-foreground">ต้องสร้างฉากก่อนจึงจะสร้างวิดีโอได้</p>
          )}

          {videos.length > 0 && (
            <div className="flex flex-col gap-2">
              {videos.map((v) => (
                <div key={v.id} className="flex items-center gap-3 rounded-md border p-3">
                  {v.thumbnailUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={v.thumbnailUrl} alt="" className="h-12 w-8 rounded object-cover" />
                  ) : (
                    <div className="h-12 w-8 rounded bg-muted" />
                  )}
                  <div className="flex-1">
                    <Badge
                      variant={
                        v.status === "completed"
                          ? "default"
                          : v.status === "failed"
                            ? "destructive"
                            : "secondary"
                      }
                    >
                      {STATUS_LABEL[v.status] ?? v.status}
                    </Badge>
                    {v.errorMessage && (
                      <p className="mt-1 text-xs text-destructive">{v.errorMessage}</p>
                    )}
                  </div>
                  {v.status === "failed" && (
                    <Button size="sm" variant="outline" onClick={() => handleRegenerate(v.id)}>
                      ลองใหม่
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
