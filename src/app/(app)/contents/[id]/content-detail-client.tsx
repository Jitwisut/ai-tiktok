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
import { Progress } from "@/components/ui/progress";

type Scene = {
  id: string;
  position: number;
  duration: number;
  description: string;
  visual: string | null;
  cameraMotion: string | null;
  clip: number | null;
  dialogue: string | null;
  voiceover: string | null;
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
  onScreenText: string | null;
  onScreenCta: string | null;
  angle: string | null;
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

const STATUS_PROGRESS: Record<string, number> = {
  queued: 20,
  processing: 65,
  completed: 100,
  failed: 100,
  cancelled: 100,
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
  const [onScreenText, setOnScreenText] = useState(content.onScreenText ?? "");
  const [onScreenCta, setOnScreenCta] = useState(content.onScreenCta ?? "");

  const [saving, setSaving] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [creatingVideo, setCreatingVideo] = useState(false);
  const [creatingViaExtension, setCreatingViaExtension] = useState(false);
  const [targetDuration, setTargetDuration] = useState(24);
  const [site, setSite] = useState<"aistudio" | "flow">("aistudio");
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
      body: JSON.stringify({ hook, script, caption, cta, onScreenText, onScreenCta }),
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
      body: JSON.stringify({ targetDuration }),
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
      body: JSON.stringify({
        contentId: content.id,
        settings: {
          style: content.style,
          onScreenText: onScreenText || undefined,
          onScreenCta: onScreenCta || undefined,
        },
      }),
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

  async function handleGenerateViaExtension() {
    // The extension answers this ping synchronously during dispatch, so the
    // result is known by the time dispatchEvent returns — no timeout race,
    // and nothing touches the DOM that React hydrates.
    let extensionPresent = false;
    const onPong = () => {
      extensionPresent = true;
    };
    window.addEventListener("ai-affiliate:pong", onPong);
    window.dispatchEvent(new CustomEvent("ai-affiliate:ping"));
    window.removeEventListener("ai-affiliate:pong", onPong);

    if (!extensionPresent) {
      toast.error("ไม่พบ Extension — ติดตั้งแล้วรีเฟรชหน้านี้ก่อนใช้ฟีเจอร์นี้");
      return;
    }

    setCreatingViaExtension(true);
    const res = await fetch("/api/videos/extension", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contentId: content.id,
        targetDuration,
        settings: {
          style: content.style,
          onScreenText: onScreenText || undefined,
          onScreenCta: onScreenCta || undefined,
        },
      }),
    });

    if (!res.ok) {
      setCreatingViaExtension(false);
      const body = await res.json().catch(() => null);
      toast.error(body?.error ?? "สร้างวิดีโอไม่สำเร็จ");
      return;
    }

    const { video, clips, imageUrl } = await res.json();

    window.dispatchEvent(
      new CustomEvent("ai-affiliate:generate-via-extension", {
        detail: {
          videoId: video.id,
          clips,
          duration: video.duration,
          aspectRatio: video.aspectRatio,
          imageUrl,
          site,
        },
      }),
    );

    setCreatingViaExtension(false);
    toast.success(
      `ส่งงานไปที่ ${site === "flow" ? "Google Flow" : "AI Studio"} แล้ว กำลังรอผลลัพธ์...`,
    );
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
          {content.angle && <p className="text-xs text-muted-foreground">มุมการขายที่ใช้: {content.angle}</p>}
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
            <div className="flex flex-col gap-2 rounded-md border border-dashed p-3">
              <div>
                <Label htmlFor="on-screen-text">ข้อความภาษาไทยบนวิดีโอ</Label>
                <p className="mt-1 text-xs text-muted-foreground">
                  ระบบจะส่งข้อความนี้ในเครื่องหมาย &quot;...&quot; และสั่งให้ AI คัดลอกทุกตัวอักษรตรงๆ เช่น ตัวอย่าง
                </p>
              </div>
              <Input
                id="on-screen-text"
                value={onScreenText}
                onChange={(e) => setOnScreenText(e.target.value)}
                placeholder="ตัวอย่าง"
                maxLength={12}
              />
              <Label htmlFor="on-screen-cta">ข้อความ CTA ภาษาไทยท้ายวิดีโอ</Label>
              <Input
                id="on-screen-cta"
                aria-label="ข้อความ CTA ภาษาไทยบนวิดีโอ"
                value={onScreenCta}
                onChange={(e) => setOnScreenCta(e.target.value)}
                placeholder="กดดูเลย"
                maxLength={10}
              />
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
                  {scene.clip === null ? "" : `คลิป ${scene.clip + 1} · `}{scene.duration}s
                </Badge>
                <div className="text-muted-foreground">
                  <p>{scene.description}</p>
                  {scene.visual && <p className="mt-1 text-xs opacity-80">ภาพ: {scene.visual}</p>}
                  {scene.dialogue && <p className="mt-1 text-xs">🗣️ {scene.dialogue}</p>}
                  {scene.voiceover && <p className="mt-1 text-xs">🎙️ {scene.voiceover}</p>}
                </div>
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
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              onClick={handleCreateVideo}
              disabled={creatingVideo || content.scenes.length === 0}
            >
              {creatingVideo ? "กำลังส่งงาน..." : "Generate Video (20 เครดิต)"}
            </Button>
            <Button
              variant="outline"
              onClick={handleGenerateViaExtension}
              disabled={creatingViaExtension || content.scenes.length === 0}
            >
              {creatingViaExtension ? "กำลังส่งงาน..." : "สร้างผ่าน Extension"}
            </Button>
            <select
              className="h-9 rounded-md border bg-transparent px-3 text-sm"
              value={site}
              onChange={(e) => setSite(e.target.value as "aistudio" | "flow")}
            >
              <option value="aistudio">AI Studio</option>
              <option value="flow">Google Flow</option>
            </select>
            <select
              className="h-9 rounded-md border bg-transparent px-3 text-sm"
              value={targetDuration}
              onChange={(e) => setTargetDuration(Number(e.target.value))}
            >
              <option value={8}>8 วินาที (1 คลิป)</option>
              <option value={16}>16 วินาที (2 คลิป)</option>
              <option value={24}>24 วินาที (3 คลิป)</option>
              <option value={32}>32 วินาที (4 คลิป)</option>
            </select>
          </div>
          <p className="text-xs text-muted-foreground">
            สร้างได้ครั้งละ 8 วินาที — ความยาวที่มากกว่านั้นจะสร้างเป็นหลายคลิปแล้วต่อเป็นไฟล์เดียว
            (ใช้ได้เฉพาะปุ่ม Extension)
            {site === "flow"
              ? " · Flow ต่อภาพระหว่างคลิปไม่ได้ แต่ละคลิปอาจเป็นคนละฉาก และต้องตั้ง Flow project URL ในหน้า Settings ของ Extension ก่อน"
              : " · AI Studio ส่งเฟรมสุดท้ายของคลิปก่อนหน้าไปต่อ ทำให้ภาพต่อเนื่องกว่า"}
          </p>
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
                    {(v.status === "queued" || v.status === "processing") && (
                      <Progress
                        value={STATUS_PROGRESS[v.status]}
                        className="mt-2 w-full max-w-40"
                      />
                    )}
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
