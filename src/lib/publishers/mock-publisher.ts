import { randomUUID } from "node:crypto";
import type { Publisher, PublishInput, PublishResult } from "./types";

export class MockPublisher implements Publisher {
  constructor(public platform: string) {}

  async publish(_input: PublishInput): Promise<PublishResult> {
    await new Promise((resolve) => setTimeout(resolve, 500));
    return { platformPostId: `mock_${this.platform}_${randomUUID()}` };
  }
}
