/**
 * Joins MP4 clips into one file without re-encoding. Flow renders every clip
 * with the same codec setup (H.264 High 720x1280 24fps + AAC 48kHz, one
 * non-fragmented mdat, each clip opening on an IDR frame), so the sample data
 * can be copied as-is and only the moov sample tables need rebuilding. Pure
 * ArrayBuffer code — runs in the service worker, where ffmpeg can't.
 *
 * Tracks are matched by handler type (vide/soun). A track type missing from
 * any clip is dropped rather than letting audio drift out of sync, and clips
 * whose codec setup differs are rejected rather than joined into a corrupt file.
 */

interface Box {
  type: string;
  start: number; // offset of the box header
  headerSize: number;
  size: number;
}

interface Sample {
  offset: number;
  size: number;
  delta: number; // decode duration, in the output track timescale
  ctsOffset: number;
  sync: boolean;
}

interface Chunk {
  offset: number; // original file offset, for preserving interleaving
  samples: Sample[];
}

interface ClipTrack {
  handler: string;
  timescale: number;
  trak: Box;
  sampleEntry: Uint8Array;
  sampleEntryKey: string;
  chunks: Chunk[];
  hasSyncTable: boolean;
  hasCtts: boolean;
  cttsVersion: number;
  editMediaTime: number; // first edit's media_time, in the track timescale; 0 if none
  editDuration: number | null; // first edit's segment_duration, in the clip's movie timescale
  mediaDuration: number;
}

interface ParsedClip {
  bytes: Uint8Array;
  view: DataView;
  ftyp: Uint8Array | null;
  movieTimescale: number;
  mvhd: Box;
  tracks: Map<string, ClipTrack>;
}

function readBoxes(view: DataView, start: number, end: number): Box[] {
  const boxes: Box[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = view.getUint32(offset);
    const type = String.fromCharCode(
      view.getUint8(offset + 4),
      view.getUint8(offset + 5),
      view.getUint8(offset + 6),
      view.getUint8(offset + 7),
    );
    let headerSize = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(offset + 8));
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < headerSize || offset + size > end) throw new Error(`กล่อง MP4 "${type}" เสียหาย`);
    boxes.push({ type, start: offset, headerSize, size });
    offset += size;
  }
  return boxes;
}

function child(view: DataView, parent: Box, type: string): Box | undefined {
  return readBoxes(view, parent.start + parent.headerSize, parent.start + parent.size).find((b) => b.type === type);
}

function path(view: DataView, parent: Box, ...types: string[]): Box | undefined {
  let current: Box | undefined = parent;
  for (const type of types) {
    if (!current) return undefined;
    current = child(view, current, type);
  }
  return current;
}

function fullBoxBody(box: Box): number {
  return box.start + box.headerSize + 4; // after version + flags
}

/** Identity of a sample entry for decoding purposes — ignores btrt bitrate hints, which differ per clip. */
function sampleEntryKey(view: DataView, entry: Box): string {
  const bytes = new Uint8Array(view.buffer, view.byteOffset + entry.start, entry.size);
  const parts: string[] = [entry.type];
  // Visual entries have 78 bytes of fields before child boxes, audio entries 28.
  const fixed = entry.type === "mp4a" ? 28 : 78;
  const fieldsEnd = entry.start + entry.headerSize + fixed;
  if (fieldsEnd <= entry.start + entry.size) {
    parts.push(Array.from(bytes.subarray(entry.headerSize, entry.headerSize + fixed)).join(","));
    for (const box of readBoxes(view, fieldsEnd, entry.start + entry.size)) {
      if (box.type === "btrt") continue;
      if (box.type === "esds") {
        // Only the DecoderSpecificInfo (tag 5) matters; the surrounding descriptors carry bitrates.
        const esds = new Uint8Array(view.buffer, view.byteOffset + box.start, box.size);
        const tag = esds.indexOf(0x05, box.headerSize + 4);
        parts.push(`esds:${tag >= 0 ? Array.from(esds.subarray(tag)).join(",") : ""}`);
        continue;
      }
      parts.push(`${box.type}:${Array.from(new Uint8Array(view.buffer, view.byteOffset + box.start, box.size)).join(",")}`);
    }
  }
  return parts.join("|");
}

function parseTrack(view: DataView, trak: Box, movieTimescale: number): ClipTrack | null {
  const mdia = child(view, trak, "mdia");
  const mdhd = mdia && child(view, mdia, "mdhd");
  const hdlr = mdia && child(view, mdia, "hdlr");
  const stbl = mdia && path(view, mdia, "minf", "stbl");
  if (!mdia || !mdhd || !hdlr || !stbl) return null;

  const handler = String.fromCharCode(
    ...[0, 1, 2, 3].map((i) => view.getUint8(fullBoxBody(hdlr) + 4 + i)),
  );
  if (handler !== "vide" && handler !== "soun") return null;

  const mdhdVersion = view.getUint8(mdhd.start + mdhd.headerSize);
  const timescale = view.getUint32(fullBoxBody(mdhd) + (mdhdVersion === 1 ? 16 : 8));

  const stsd = child(view, stbl, "stsd");
  const stts = child(view, stbl, "stts");
  const stsc = child(view, stbl, "stsc");
  const stsz = child(view, stbl, "stsz");
  const stco = child(view, stbl, "stco") ?? child(view, stbl, "co64");
  if (!stsd || !stts || !stsc || !stsz || !stco) throw new Error("คลิปไม่มีตารางตัวอย่างที่จำเป็น");

  const entries = readBoxes(view, fullBoxBody(stsd) + 4, stsd.start + stsd.size);
  if (entries.length !== 1) throw new Error("ยังไม่รองรับคลิปที่มี sample description หลายชุด");
  const entry = entries[0];

  // stsz
  const defaultSize = view.getUint32(fullBoxBody(stsz));
  const sampleCount = view.getUint32(fullBoxBody(stsz) + 4);
  const sizes = new Array<number>(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    sizes[i] = defaultSize || view.getUint32(fullBoxBody(stsz) + 8 + i * 4);
  }

  // stts
  const deltas: number[] = [];
  const sttsCount = view.getUint32(fullBoxBody(stts));
  for (let i = 0; i < sttsCount; i++) {
    const count = view.getUint32(fullBoxBody(stts) + 4 + i * 8);
    const delta = view.getUint32(fullBoxBody(stts) + 8 + i * 8);
    for (let j = 0; j < count; j++) deltas.push(delta);
  }

  // ctts
  const ctts = child(view, stbl, "ctts");
  const cttsVersion = ctts ? view.getUint8(ctts.start + ctts.headerSize) : 0;
  const ctsOffsets = new Array<number>(sampleCount).fill(0);
  if (ctts) {
    const count = view.getUint32(fullBoxBody(ctts));
    let n = 0;
    for (let i = 0; i < count; i++) {
      const runLength = view.getUint32(fullBoxBody(ctts) + 4 + i * 8);
      const value =
        cttsVersion === 1
          ? view.getInt32(fullBoxBody(ctts) + 8 + i * 8)
          : view.getUint32(fullBoxBody(ctts) + 8 + i * 8);
      for (let j = 0; j < runLength && n < sampleCount; j++) ctsOffsets[n++] = value;
    }
  }

  // stss
  const stss = child(view, stbl, "stss");
  const sync = new Array<boolean>(sampleCount).fill(!stss);
  if (stss) {
    const count = view.getUint32(fullBoxBody(stss));
    for (let i = 0; i < count; i++) {
      const n = view.getUint32(fullBoxBody(stss) + 4 + i * 4) - 1;
      if (n >= 0 && n < sampleCount) sync[n] = true;
    }
  }

  // stco / co64
  const chunkCount = view.getUint32(fullBoxBody(stco));
  const chunkOffsets = new Array<number>(chunkCount);
  for (let i = 0; i < chunkCount; i++) {
    chunkOffsets[i] =
      stco.type === "co64"
        ? Number(view.getBigUint64(fullBoxBody(stco) + 4 + i * 8))
        : view.getUint32(fullBoxBody(stco) + 4 + i * 4);
  }

  // stsc — expands to samples-per-chunk for every chunk
  const stscCount = view.getUint32(fullBoxBody(stsc));
  const runs = Array.from({ length: stscCount }, (_, i) => ({
    firstChunk: view.getUint32(fullBoxBody(stsc) + 4 + i * 12),
    samplesPerChunk: view.getUint32(fullBoxBody(stsc) + 8 + i * 12),
  }));

  const chunks: Chunk[] = [];
  let sampleIndex = 0;
  for (let c = 0; c < chunkCount; c++) {
    const run = [...runs].reverse().find((r) => r.firstChunk <= c + 1);
    const perChunk = run?.samplesPerChunk ?? 0;
    let offset = chunkOffsets[c];
    const samples: Sample[] = [];
    for (let s = 0; s < perChunk && sampleIndex < sampleCount; s++, sampleIndex++) {
      samples.push({
        offset,
        size: sizes[sampleIndex],
        delta: deltas[sampleIndex] ?? deltas[deltas.length - 1] ?? 0,
        ctsOffset: ctsOffsets[sampleIndex],
        sync: sync[sampleIndex],
      });
      offset += sizes[sampleIndex];
    }
    chunks.push({ offset: chunkOffsets[c], samples });
  }
  if (sampleIndex !== sampleCount) throw new Error("ตารางตัวอย่างในคลิปไม่ตรงกัน");

  // First edit's media_time (e.g. AAC priming / B-frame composition delay)
  let editMediaTime = 0;
  let editDuration: number | null = null;
  const elst = path(view, trak, "edts", "elst");
  if (elst && view.getUint32(fullBoxBody(elst)) === 1) {
    const version = view.getUint8(elst.start + elst.headerSize);
    const body = fullBoxBody(elst) + 4;
    const segment = version === 1 ? Number(view.getBigUint64(body)) : view.getUint32(body);
    const mediaTime = version === 1 ? Number(view.getBigInt64(body + 8)) : view.getInt32(body + 4);
    if (mediaTime >= 0) {
      editMediaTime = mediaTime;
      editDuration = segment / movieTimescale;
    }
  }

  return {
    handler,
    timescale,
    trak,
    sampleEntry: new Uint8Array(view.buffer, view.byteOffset + entry.start, entry.size),
    sampleEntryKey: sampleEntryKey(view, entry),
    chunks,
    hasSyncTable: !!stss,
    hasCtts: !!ctts,
    cttsVersion,
    editMediaTime,
    editDuration,
    mediaDuration: deltas.reduce((sum, d) => sum + d, 0),
  };
}

function parseClip(buffer: ArrayBuffer): ParsedClip {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const top = readBoxes(view, 0, bytes.length);
  const moov = top.find((b) => b.type === "moov");
  if (!moov) throw new Error("ไฟล์คลิปไม่ใช่ MP4 ที่ต่อได้ (ไม่มี moov)");
  if (top.some((b) => b.type === "moof")) throw new Error("ยังไม่รองรับ MP4 แบบ fragmented");
  const mvhd = child(view, moov, "mvhd");
  if (!mvhd) throw new Error("ไฟล์คลิปไม่มี mvhd");
  const ftypBox = top.find((b) => b.type === "ftyp");

  const mvhdVersion = view.getUint8(mvhd.start + mvhd.headerSize);
  const movieTimescale = view.getUint32(fullBoxBody(mvhd) + (mvhdVersion === 1 ? 16 : 8));

  const tracks = new Map<string, ClipTrack>();
  for (const box of readBoxes(view, moov.start + moov.headerSize, moov.start + moov.size)) {
    if (box.type !== "trak") continue;
    const track = parseTrack(view, box, movieTimescale);
    if (track && !tracks.has(track.handler)) tracks.set(track.handler, track);
  }
  if (!tracks.has("vide")) throw new Error("คลิปไม่มีแทร็กวิดีโอ");

  return {
    bytes,
    view,
    ftyp: ftypBox ? bytes.subarray(ftypBox.start, ftypBox.start + ftypBox.size) : null,
    movieTimescale,
    mvhd,
    tracks,
  };
}

/* ---------- writing ---------- */

class Writer {
  private parts: Uint8Array[] = [];
  length = 0;

  bytes(data: Uint8Array) {
    this.parts.push(data);
    this.length += data.length;
  }

  u8(value: number) {
    this.bytes(Uint8Array.of(value & 0xff));
  }

  u16(value: number) {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, value);
    this.bytes(b);
  }

  u32(value: number) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, value >>> 0);
    this.bytes(b);
  }

  i32(value: number) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, value);
    this.bytes(b);
  }

  concat(): Uint8Array {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const part of this.parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }
}

function box(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, out.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  return out;
}

function fullBox(type: string, version: number, flags: number, fill: (w: Writer) => void): Uint8Array {
  const w = new Writer();
  w.u32(((version & 0xff) << 24) | (flags & 0xffffff));
  fill(w);
  return box(type, w.concat());
}

function joinBytes(parts: Uint8Array[]): Uint8Array {
  const w = new Writer();
  parts.forEach((p) => w.bytes(p));
  return w.concat();
}

/** Copies a version 0/1 header box (mvhd/tkhd/mdhd) with its duration field replaced. */
function withDuration(clip: ParsedClip, header: Box, duration: number): Uint8Array {
  const original = clip.bytes.subarray(header.start, header.start + header.size);
  const copy = new Uint8Array(original);
  const view = new DataView(copy.buffer);
  const version = copy[header.headerSize];
  const body = header.headerSize + 4;
  if (header.type === "tkhd") {
    // version 0: created(4) modified(4) track_id(4) reserved(4) duration(4)
    if (version === 1) view.setBigUint64(body + 8 + 8 + 4 + 4, BigInt(duration));
    else view.setUint32(body + 4 + 4 + 4 + 4, duration);
  } else if (version === 1) {
    view.setBigUint64(body + 8 + 8 + 4, BigInt(duration));
  } else {
    view.setUint32(body + 4 + 4 + 4, duration);
  }
  return copy;
}

function copyBox(clip: ParsedClip, b: Box | undefined): Uint8Array[] {
  return b ? [clip.bytes.subarray(b.start, b.start + b.size)] : [];
}

interface OutputTrack {
  handler: string;
  timescale: number;
  entries: Uint8Array[]; // stsd entries, deduplicated
  samples: (Sample & { entryIndex: number; clipIndex: number })[];
  chunkPlan: { clipIndex: number; samples: (Sample & { entryIndex: number })[]; order: number }[];
  editMediaTime: number;
  hasSyncTable: boolean;
  hasCtts: boolean;
  cttsVersion: number;
  mediaDuration: number;
  presentedDuration: number; // in movie timescale
}

function buildOutputTrack(clips: ParsedClip[], handler: string, movieTimescale: number): OutputTrack {
  const tracks = clips.map((c) => c.tracks.get(handler)!);
  const timescale = tracks[0].timescale;
  const entries: Uint8Array[] = [];
  const entryKeys: string[] = [];

  const out: OutputTrack = {
    handler,
    timescale,
    entries,
    samples: [],
    chunkPlan: [],
    editMediaTime: tracks[0].editMediaTime,
    hasSyncTable: tracks.some((t) => t.hasSyncTable),
    hasCtts: tracks.some((t) => t.hasCtts),
    cttsVersion: tracks.some((t) => t.cttsVersion === 1) ? 1 : 0,
    mediaDuration: 0,
    presentedDuration: 0,
  };

  let presentedSeconds = 0;
  tracks.forEach((track, clipIndex) => {
    let entryIndex = entryKeys.indexOf(track.sampleEntryKey);
    // Separate sample descriptions per clip are legal MP4, but decoders keep
    // the first clip's H.264/AAC state and the later clips come out corrupt
    // (verified with ffmpeg on a Flow + AI Studio pair) — so refuse instead.
    if (entryIndex < 0 && entryKeys.length > 0) {
      throw new Error("คลิปถูกเข้ารหัสไม่เหมือนกัน (เช่น มาจากคนละเว็บ) จึงต่อแบบไม่แปลงไฟล์ไม่ได้");
    }
    if (entryIndex < 0) {
      entryKeys.push(track.sampleEntryKey);
      entries.push(track.sampleEntry);
      entryIndex = entries.length - 1;
    }

    const scale = timescale / track.timescale;
    // Audio: every clip after the first skips its own priming samples (the
    // first edit's media_time), which the single output edit only covers
    // for clip one. Video keeps all frames — its media_time is a B-frame
    // composition delay that is identical in every clip.
    let toSkip = handler === "soun" && clipIndex > 0 ? track.editMediaTime : 0;
    let clipMedia = 0;
    for (const chunk of track.chunks) {
      const kept: (Sample & { entryIndex: number })[] = [];
      for (const sample of chunk.samples) {
        if (toSkip > 0 && sample.delta <= toSkip) {
          toSkip -= sample.delta;
          continue;
        }
        toSkip = 0;
        const scaled = {
          ...sample,
          delta: Math.round(sample.delta * scale),
          ctsOffset: Math.round(sample.ctsOffset * scale),
          entryIndex,
        };
        kept.push(scaled);
        out.samples.push({ ...scaled, clipIndex });
        clipMedia += scaled.delta;
      }
      if (kept.length) out.chunkPlan.push({ clipIndex, samples: kept, order: chunk.offset });
    }
    out.mediaDuration += clipMedia;
    // Each clip contributes what it presented on its own: its edit's
    // duration, or its whole media when it has no edit list.
    presentedSeconds += track.editDuration ?? track.mediaDuration / track.timescale;
  });

  // Never present past the end of the media the edit starts into.
  const availableSeconds = (out.mediaDuration - out.editMediaTime) / timescale + (handler === "vide" ? out.editMediaTime / timescale : 0);
  out.presentedDuration = Math.round(Math.min(presentedSeconds, availableSeconds) * movieTimescale);
  return out;
}

function runLength<T>(values: T[], same: (a: T, b: T) => boolean): { value: T; count: number }[] {
  const runs: { value: T; count: number }[] = [];
  for (const value of values) {
    const last = runs[runs.length - 1];
    if (last && same(last.value, value)) last.count++;
    else runs.push({ value, count: 1 });
  }
  return runs;
}

function buildTrak(
  clip: ParsedClip,
  track: OutputTrack,
  chunkOffsets: number[],
): Uint8Array {
  const view = clip.view;
  const src = clip.tracks.get(track.handler)!;
  const trak = src.trak;
  const tkhd = child(view, trak, "tkhd")!;
  const mdia = child(view, trak, "mdia")!;
  const mdhd = child(view, mdia, "mdhd")!;
  const hdlr = child(view, mdia, "hdlr")!;
  const minf = child(view, mdia, "minf")!;
  const mediaHeader = child(view, minf, track.handler === "vide" ? "vmhd" : "smhd");
  const dinf = child(view, minf, "dinf");

  const stsd = fullBox("stsd", 0, 0, (w) => {
    w.u32(track.entries.length);
    track.entries.forEach((e) => w.bytes(e));
  });

  const sttsRuns = runLength(track.samples.map((s) => s.delta), (a, b) => a === b);
  const stts = fullBox("stts", 0, 0, (w) => {
    w.u32(sttsRuns.length);
    for (const run of sttsRuns) {
      w.u32(run.count);
      w.u32(run.value);
    }
  });

  const ctts = track.hasCtts
    ? fullBox("ctts", track.cttsVersion, 0, (w) => {
        const runs = runLength(track.samples.map((s) => s.ctsOffset), (a, b) => a === b);
        w.u32(runs.length);
        for (const run of runs) {
          w.u32(run.count);
          if (track.cttsVersion === 1) w.i32(run.value);
          else w.u32(run.value);
        }
      })
    : null;

  const syncNumbers = track.samples.flatMap((s, i) => (s.sync ? [i + 1] : []));
  const stss =
    track.hasSyncTable && syncNumbers.length !== track.samples.length
      ? fullBox("stss", 0, 0, (w) => {
          w.u32(syncNumbers.length);
          syncNumbers.forEach((n) => w.u32(n));
        })
      : null;

  const stscRuns: { firstChunk: number; perChunk: number; entry: number }[] = [];
  track.chunkPlan.forEach((chunk, i) => {
    const last = stscRuns[stscRuns.length - 1];
    const entry = chunk.samples[0].entryIndex + 1;
    if (!last || last.perChunk !== chunk.samples.length || last.entry !== entry) {
      stscRuns.push({ firstChunk: i + 1, perChunk: chunk.samples.length, entry });
    }
  });
  const stsc = fullBox("stsc", 0, 0, (w) => {
    w.u32(stscRuns.length);
    for (const run of stscRuns) {
      w.u32(run.firstChunk);
      w.u32(run.perChunk);
      w.u32(run.entry);
    }
  });

  const stsz = fullBox("stsz", 0, 0, (w) => {
    w.u32(0);
    w.u32(track.samples.length);
    track.samples.forEach((s) => w.u32(s.size));
  });

  const stco = fullBox("stco", 0, 0, (w) => {
    w.u32(chunkOffsets.length);
    chunkOffsets.forEach((o) => w.u32(o));
  });

  const stbl = box("stbl", joinBytes([stsd, stts, ...(ctts ? [ctts] : []), ...(stss ? [stss] : []), stsc, stsz, stco]));
  const minfOut = box("minf", joinBytes([...copyBox(clip, mediaHeader), ...copyBox(clip, dinf), stbl]));
  const mdiaOut = box(
    "mdia",
    joinBytes([withDuration(clip, mdhd, track.mediaDuration), clip.bytes.subarray(hdlr.start, hdlr.start + hdlr.size), minfOut]),
  );

  const elst = fullBox("elst", 0, 0, (w) => {
    w.u32(1);
    w.u32(track.presentedDuration);
    w.i32(track.editMediaTime);
    w.u16(1);
    w.u16(0);
  });

  return box(
    "trak",
    joinBytes([withDuration(clip, tkhd, track.presentedDuration), box("edts", elst), mdiaOut]),
  );
}

/** Joins clips in the given order. Resolves to the merged MP4 bytes. */
export function concatMp4(buffers: ArrayBuffer[]): Uint8Array {
  if (buffers.length === 0) throw new Error("ไม่มีคลิปให้ต่อ");
  const clips = buffers.map(parseClip);
  const first = clips[0];

  const handlers = ["vide", "soun"].filter((h) => clips.every((c) => c.tracks.has(h)));
  const tracks = handlers.map((h) => buildOutputTrack(clips, h, first.movieTimescale));

  // Interleave chunks the way each source file did: clip by clip, and within
  // a clip in original file-offset order across tracks.
  const layout = tracks
    .flatMap((track, t) => track.chunkPlan.map((chunk, c) => ({ t, c, clipIndex: chunk.clipIndex, order: chunk.order })))
    .sort((a, b) => a.clipIndex - b.clipIndex || a.order - b.order);

  const chunkSizes = tracks.map((track) => track.chunkPlan.map((chunk) => chunk.samples.reduce((s, x) => s + x.size, 0)));
  const mdatPayload = chunkSizes.flat().reduce((s, x) => s + x, 0);
  if (mdatPayload + 8 > 0xffffffff) throw new Error("วิดีโอรวมใหญ่เกินไป");

  const ftyp = first.ftyp ?? box("ftyp", joinBytes([new TextEncoder().encode("isom"), Uint8Array.of(0, 0, 2, 0), new TextEncoder().encode("isomiso2avc1mp41")]));
  const movieDuration = Math.max(...tracks.map((t) => t.presentedDuration));

  const buildMoov = (offsets: number[][]) =>
    box(
      "moov",
      joinBytes([
        withDuration(first, first.mvhd, movieDuration),
        ...tracks.map((track, t) => buildTrak(first, track, offsets[t])),
      ]),
    );

  // stco offsets are fixed-width, so the moov size doesn't depend on their values.
  const placeholder = tracks.map((track) => track.chunkPlan.map(() => 0));
  const moovSize = buildMoov(placeholder).length;
  const dataStart = ftyp.length + moovSize + 8;

  const offsets = tracks.map((track) => new Array<number>(track.chunkPlan.length).fill(0));
  let cursor = dataStart;
  for (const { t, c } of layout) {
    offsets[t][c] = cursor;
    cursor += chunkSizes[t][c];
  }

  const moov = buildMoov(offsets);
  const out = new Uint8Array(ftyp.length + moov.length + 8 + mdatPayload);
  out.set(ftyp, 0);
  out.set(moov, ftyp.length);
  new DataView(out.buffer).setUint32(ftyp.length + moov.length, 8 + mdatPayload);
  out.set(new TextEncoder().encode("mdat"), ftyp.length + moov.length + 4);

  for (const { t, c } of layout) {
    const chunk = tracks[t].chunkPlan[c];
    const source = clips[chunk.clipIndex].bytes;
    let at = offsets[t][c];
    for (const sample of chunk.samples) {
      out.set(source.subarray(sample.offset, sample.offset + sample.size), at);
      at += sample.size;
    }
  }
  return out;
}
