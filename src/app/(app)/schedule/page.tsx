import { headers } from "next/headers";
import { auth } from "@/lib/auth/auth";
import { listSchedules } from "@/services/scheduled-post.service";
import { listVideos } from "@/services/video.service";
import { ScheduleClient } from "./schedule-client";

export default async function SchedulePage() {
  const session = await auth.api.getSession({ headers: await headers() });
  const [scheduledPosts, videos] = await Promise.all([
    listSchedules(session!.user.id),
    listVideos(session!.user.id),
  ]);

  const completedVideos = videos.filter((v) => v.status === "completed");

  return (
    <ScheduleClient
      videos={completedVideos.map((v) => ({
        id: v.id,
        label: `${v.content.product.name} — ${v.content.hook}`,
      }))}
      scheduledPosts={scheduledPosts.map((p) => ({
        id: p.id,
        platform: p.platform,
        status: p.status,
        scheduledAt: p.scheduledAt.toISOString(),
        error: p.error,
        productName: p.video.content.product.name,
        hook: p.video.content.hook,
      }))}
    />
  );
}
