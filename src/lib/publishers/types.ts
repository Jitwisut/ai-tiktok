export interface PublishInput {
  videoUrl: string;
  caption: string;
}

export interface PublishResult {
  platformPostId: string;
}

export interface Publisher {
  platform: string;
  publish(input: PublishInput): Promise<PublishResult>;
}
