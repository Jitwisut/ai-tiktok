-- CreateTable
CREATE TABLE "video_clips" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "video_clips_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "video_clips_videoId_idx" ON "video_clips"("videoId");

-- CreateIndex
CREATE UNIQUE INDEX "video_clips_videoId_index_key" ON "video_clips"("videoId", "index");

-- AddForeignKey
ALTER TABLE "video_clips" ADD CONSTRAINT "video_clips_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "videos"("id") ON DELETE CASCADE ON UPDATE CASCADE;
