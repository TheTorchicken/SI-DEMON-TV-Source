import { expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRelay } from "../server/index";
import { Store } from "../server/core";

it("preserves the resume checkpoint when receiver shutdown resets playback", async () => {
  const directory = mkdtempSync(join(tmpdir(), "demon-shutdown-"));
  const relay = createRelay({ directory, token: "synthetic-lifecycle-key" });
  const current = {
    id: "aqz-KE-bpKQ",
    title: "Synthetic checkpoint",
    author: "",
    duration: 600,
    thumbnail: "",
    source: "youtube" as const,
  };
  const next = { ...current, id: "jNQXAC9IVRw", title: "Synthetic next" };
  relay.store.patch({
    current,
    queue: [next],
    position: 125,
    duration: 600,
    status: "paused",
  });
  // This is the receiver's observed teardown behavior, through its real adapter.
  vi.spyOn(relay.casting, "stop").mockImplementation(async () => {
    await relay.casting.player.doStop();
    relay.store.patch({ queue: [] });
  });
  try {
    await relay.close();
    const restored = new Store(directory).state;
    expect(restored.current?.id).toBe(current.id);
    expect(restored.queue.map((v) => v.id)).toEqual([next.id]);
    expect(restored.position).toBe(125);
    expect(restored.status).toBe("paused");
  } finally {
    relay.media.close();
    rmSync(directory, { recursive: true });
  }
});

it("keeps zero volume and mute after a cold start", () => {
  const directory = mkdtempSync(join(tmpdir(), "demon-audio-state-"));
  try {
    new Store(directory).patch({ volume: 0, muted: true });
    const restored = new Store(directory).state;
    expect(restored.volume).toBe(0);
    expect(restored.muted).toBe(true);
  } finally {
    rmSync(directory, { recursive: true });
  }
});
