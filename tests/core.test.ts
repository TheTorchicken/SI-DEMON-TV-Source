import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, youtubeId, validateMirrorPacket } from "../server/core";
const item = (id: string) => ({
  id,
  title: id,
  author: "test",
  duration: 10,
  thumbnail: "",
  source: "youtube" as const,
});
describe("YouTube identifiers", () => {
  it("accepts watch, share, shorts and live links", () => {
    for (const url of [
      "dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ?t=10",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtube.com/shorts/dQw4w9WgXcQ",
      "https://youtube.com/live/dQw4w9WgXcQ",
    ])
      expect(youtubeId(url)).toBe("dQw4w9WgXcQ");
  });
  it("rejects arbitrary hosts, malformed ids and insecure links", () => {
    for (const url of [
      "https://youtube.com.attacker.test/watch?v=dQw4w9WgXcQ",
      "file:///etc/passwd",
      "http://youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtube.com/watch?v=bad",
      "$(touch /tmp/no)",
    ])
      expect(() => youtubeId(url)).toThrow();
  });
});
describe("durable queue", () => {
  it("retains order, mode and resume position without resuming unexpectedly", () => {
    const directory = mkdtempSync(join(tmpdir(), "demon-store-"));
    try {
      const store = new Store(directory);
      store.enqueue(item("dQw4w9WgXcQ"));
      store.enqueue(item("aqz-KE-bpKQ"));
      store.enqueue(item("dQw4w9WgXcQ"));
      store.move("aqz-KE-bpKQ", -1);
      store.patch({
        current: item("dQw4w9WgXcQ"),
        position: 5,
        status: "playing",
        mode: "quality",
      });
      const restored = new Store(directory);
      expect(restored.state.queue.map((v) => v.id)).toEqual([
        "aqz-KE-bpKQ",
        "dQw4w9WgXcQ",
      ]);
      expect(restored.state.position).toBe(5);
      expect(restored.state.status).toBe("paused");
      expect(restored.state.mode).toBe("quality");
      restored.move("missing", -1);
      expect(restored.state.queue).toHaveLength(2);
    } finally {
      rmSync(directory, { recursive: true });
    }
  });
});
describe("mirroring wire protocol", () => {
  it("validates JPEG and exact PCM packet lengths and rejects malformed data", () => {
    const jpeg = Buffer.alloc(14);
    jpeg[0] = 1;
    jpeg[9] = 255;
    jpeg[10] = 216;
    expect(validateMirrorPacket(jpeg)).toBe("jpeg");
    const pcm = Buffer.alloc(17 + 16);
    pcm[0] = 2;
    pcm.writeUInt32LE(44100, 1);
    pcm.writeUInt32LE(4, 5);
    expect(validateMirrorPacket(pcm)).toBe("pcm");
    pcm.writeUInt32LE(1000000, 5);
    expect(validateMirrorPacket(pcm)).toBeNull();
    expect(validateMirrorPacket(Buffer.from([2]))).toBeNull();
  });
});
