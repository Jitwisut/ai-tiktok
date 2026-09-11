export interface UploadResult {
  url: string;
}

export interface StorageProvider {
  upload(file: File, pathPrefix: string): Promise<UploadResult>;
}
