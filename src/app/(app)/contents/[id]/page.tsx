import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth/auth";
import { getContent } from "@/services/content.service";
import { listVideosForContent } from "@/services/video.service";
import { ContentDetailClient } from "./content-detail-client";

export default async function ContentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth.api.getSession({ headers: await headers() });
  const content = await getContent(session!.user.id, id);

  if (!content) {
    notFound();
  }

  const videos = await listVideosForContent(session!.user.id, id);

  return (
    <ContentDetailClient
      content={{
        id: content.id,
        hook: content.hook,
        script: content.script,
        caption: content.caption,
        cta: content.cta,
        style: content.style,
        onScreenText: content.onScreenText,
        onScreenCta: content.onScreenCta,
        angle: content.angle,
        productName: content.product.name,
        scenes: content.scenes.map((s) => ({
          id: s.id,
          position: s.position,
          duration: s.duration,
          description: s.description,
          visual: s.visual,
          cameraMotion: s.cameraMotion,
          clip: s.clip,
          dialogue: s.dialogue,
          voiceover: s.voiceover,
        })),
      }}
      videos={videos.map((v) => ({
        id: v.id,
        status: v.status,
        videoUrl: v.videoUrl,
        thumbnailUrl: v.thumbnailUrl,
        errorMessage: v.errorMessage,
        createdAt: v.createdAt.toISOString(),
      }))}
    />
  );
}
