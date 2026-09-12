import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import ffmpegPath from "ffmpeg-static";

const run = promisify(execFile);

/**
 * Joins clip files into one MP4. Re-encodes rather than stream-copying:
 * Veo clips are generated independently, so their encoder settings can
 * differ enough that a concat demuxer copy produces a broken file.
 */
export async function concatClips(
  absoluteClipPaths: string[],
  outputDir: string,
): Promise<string> {
  if (!ffmpegPath) throw new Error("ffmpeg binary not available");
  if (absoluteClipPaths.length === 0) throw new Error("no clips to concat");

  const filename = `${randomUUID()}.mp4`;
  const outputPath = path.join(outputDir, filename);

  if (absoluteClipPaths.length === 1) {
    await run(ffmpegPath, ["-y", "-i", absoluteClipPaths[0], "-c", "copy", outputPath]);
    return filename;
  }

  const args: string[] = ["-y"];
  for (const clip of absoluteClipPaths) args.push("-i", clip);

  const filter =
    absoluteClipPaths.map((_, i) => `[${i}:v][${i}:a]`).join("") +
    `concat=n=${absoluteClipPaths.length}:v=1:a=1[outv][outa]`;

  args.push(
    "-filter_complex",
    filter,
    "-map",
    "[outv]",
    "-map",
    "[outa]",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-c:a",
    "aac",
    outputPath,
  );

  try {
    await run(ffmpegPath, args, { maxBuffer: 32 * 1024 * 1024 });
  } catch (err) {
    // Some Veo clips come back without an audio track; retry video-only
    // before giving up.
    const videoOnlyFilter =
      absoluteClipPaths.map((_, i) => `[${i}:v]`).join("") +
      `concat=n=${absoluteClipPaths.length}:v=1:a=0[outv]`;
    try {
      await run(
        ffmpegPath,
        [
          "-y",
          ...absoluteClipPaths.flatMap((clip) => ["-i", clip]),
          "-filter_complex",
          videoOnlyFilter,
          "-map",
          "[outv]",
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          outputPath,
        ],
        { maxBuffer: 32 * 1024 * 1024 },
      );
    } catch {
      throw err;
    }
  }

  return filename;
}

export async function removeFiles(paths: string[]) {
  await Promise.all(paths.map((p) => unlink(p).catch(() => {})));

  const dirs = new Set(paths.map((p) => path.dirname(p)));
  await Promise.all([...dirs].map((dir) => rmdir(dir).catch(() => {})));
}
