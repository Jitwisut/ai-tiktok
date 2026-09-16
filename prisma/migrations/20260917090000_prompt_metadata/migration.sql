ALTER TABLE "contents" ADD COLUMN "onScreenText" TEXT;
ALTER TABLE "contents" ADD COLUMN "onScreenCta" TEXT;
ALTER TABLE "contents" ADD COLUMN "angle" TEXT;

ALTER TABLE "scenes" ADD COLUMN "visual" TEXT;
ALTER TABLE "scenes" ADD COLUMN "cameraMotion" TEXT;
ALTER TABLE "scenes" ADD COLUMN "clip" INTEGER;
ALTER TABLE "scenes" ADD COLUMN "dialogue" TEXT;
ALTER TABLE "scenes" ADD COLUMN "voiceover" TEXT;
