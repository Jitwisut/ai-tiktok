import { headers } from "next/headers";
import { auth } from "@/lib/auth/auth";
import { listVideos } from "@/services/video.service";
import { Card, CardContent } from "@/components/ui/card";
import { VideoLibraryClient } from "./video-library-client";

export default async function VideosPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  const videos = await listVideos(session!.user.id);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Videos</h1>

      {videos.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            ยังไม่มีวิดีโอ — ไปที่หน้าคอนเทนต์แล้วกด &quot;Generate Video&quot;
          </CardContent>
        </Card>
      ) : (
        <VideoLibraryClient
          videos={videos.map((v) => ({
            id: v.id,
            status: v.status,
            videoUrl: v.videoUrl,
            thumbnailUrl: v.thumbnailUrl,
            errorMessage: v.errorMessage,
            productName: v.content.product.name,
            hook: v.content.hook,
            createdAt: v.createdAt.toISOString(),
          }))}
        />
      )}
    </div>
  );
}
