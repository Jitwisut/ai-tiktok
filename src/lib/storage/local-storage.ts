import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { StorageProvider, UploadResult } from "./types";

const ALLOWED_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

const MAX_FILE_SIZE = 5 * 1024 * 1024;

const UPLOAD_ROOT = path.join(process.cwd(), "public", "uploads");

export class LocalStorageProvider implements StorageProvider {
  async upload(file: File, pathPrefix: string): Promise<UploadResult> {
    const ext = ALLOWED_TYPES[file.type];
    if (!ext) {
      throw new Error("รองรับเฉพาะไฟล์ภาพ JPEG, PNG, WEBP, GIF");
    }
    if (file.size > MAX_FILE_SIZE) {
      throw new Error("ไฟล์มีขนาดใหญ่เกิน 5MB");
    }

    const safePrefix = pathPrefix
      .split("/")
      .map((segment) => segment.replace(/[^a-zA-Z0-9_-]/g, ""))
      .filter(Boolean)
      .join("/");
    const dir = path.join(UPLOAD_ROOT, safePrefix);
    await mkdir(dir, { recursive: true });

    const filename = `${randomUUID()}.${ext}`;
    const buffer = Buffer.from(await file.arrayBuffer());
    await writeFile(path.join(dir, filename), buffer);

    return { url: `/uploads/${safePrefix}/${filename}` };
  }
}

export const storage = new LocalStorageProvider();
