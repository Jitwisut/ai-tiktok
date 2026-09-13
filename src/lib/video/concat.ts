import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import ffmpegPath from "ffmpeg-static";

const run = promisify(execFile);

const FRAME_SIZES: Record<string, [number, number]> = {
  "9:16": [720, 1280],
  "16:9": [1280, 720],
};

/**
 * Joins clip files into one MP4. Re-encodes rather than stream-copying:
 * Veo clips are generated independently, so their encoder settings can
 * differ enough that a concat demuxer copy produces a broken file.
 *
 * Every clip is scaled/padded to the job's frame and resampled to one audio
 * format first — the concat filter rejects inputs that differ, and Flow
 * does not always honour the requested aspect ratio (a 9:16 job has come
 * back with 1280x720 clips next to 720x1280 ones, at 44.1 and 48 kHz).
 */
export async function concatClips(
  absoluteClipPaths: string[],
  outputDir: string,
  aspectRatio: string = "9:16",
): Promise<string> {
  if (!ffmpegPath) throw new Error("ffmpeg binary not available");
  if (absoluteClipPaths.length === 0) throw new Error("no clips to concat");
  const ffmpeg = ffmpegPath;

  const filename = `${randomUUID()}.mp4`;
  const outputPath = path.join(outputDir, filename);

  if (absoluteClipPaths.length === 1) {
    await run(ffmpeg, ["-y", "-i", absoluteClipPaths[0], "-c", "copy", outputPath]);
    return filename;
  }

  const [width, height] = FRAME_SIZES[aspectRatio] ?? FRAME_SIZES["9:16"];
  const inputs = absoluteClipPaths.flatMap((clip) => ["-i", clip]);
  const n = absoluteClipPaths.length;

  const videoChains = absoluteClipPaths.map(
    (_, i) =>
      `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,format=yuv420p[v${i}]`,
  );
  const audioChains = absoluteClipPaths.map(
    (_, i) => `[${i}:a]aresample=48000,aformat=channel_layouts=stereo[a${i}]`,
  );

  const encode = (filter: string, maps: string[]) =>
    run(
      ffmpeg,
      [
        "-y",
        ...inputs,
        "-filter_complex",
        filter,
        ...maps.flatMap((label) => ["-map", label]),
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        ...(maps.includes("[outa]") ? ["-c:a", "aac"] : []),
        outputPath,
      ],
      { maxBuffer: 32 * 1024 * 1024 },
    );

  const withAudio = [
    ...videoChains,
    ...audioChains,
    absoluteClipPaths.map((_, i) => `[v${i}][a${i}]`).join("") + `concat=n=${n}:v=1:a=1[outv][outa]`,
  ].join(";");

  try {
    await encode(withAudio, ["[outv]", "[outa]"]);
  } catch (err) {
    // Some Veo clips come back without an audio track; retry video-only
    // before giving up.
    const videoOnly = [
      ...videoChains,
      absoluteClipPaths.map((_, i) => `[v${i}]`).join("") + `concat=n=${n}:v=1:a=0[outv]`,
    ].join(";");
    try {
      await encode(videoOnly, ["[outv]"]);
    } catch {
      // ffmpeg creates the output before it fails; don't leave an empty
      // file behind in the public directory.
      await unlink(outputPath).catch(() => {});
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
