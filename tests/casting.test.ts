import { it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Constants, DefaultLogger } from "yt-cast-receiver";
import { CastStorage, CastPlayer, QueueNavigation } from "../server/casting";
import { Store } from "../server/core";
import { Media } from "../server/media";
it("persists receiver identity immediately without an asynchronous initialization race", async () => {
  const directory = mkdtempSync(join(tmpdir(), "demon-cast-"));
  try {
    const storage = new CastStorage(directory);
    await storage.set("screen.id", "synthetic-id");
    expect(await new CastStorage(directory).get("screen.id")).toBe(
      "synthetic-id",
    );
  } finally {
    rmSync(directory, { recursive: true });
  }
});
it("uses the actual receiver playlist parser to maintain phone queue order and next selection", async () => {
  const store = new Store(),
    media = new Media(store),
    player = new CastPlayer(media, store);
  try {
    player.queue.setLogger(new DefaultLogger());
    player.queue.setRequestHandler(new QueueNavigation());
    await player.queue.updateByMessage(
      {
        AID: null,
        name: "setPlaylist",
        payload: {
          listId: "synthetic",
          videoId: "dQw4w9WgXcQ",
          currentIndex: "0",
          videoIds: "dQw4w9WgXcQ,aqz-KE-bpKQ,jNQXAC9IVRw",
        },
      },
      Constants.CLIENTS.YT,
    );
    expect(player.queue.getState().next?.id).toBe("aqz-KE-bpKQ");
    await player.queue.updateByMessage(
      {
        AID: null,
        name: "updatePlaylist",
        payload: {
          listId: "synthetic",
          videoIds: "dQw4w9WgXcQ,jNQXAC9IVRw,aqz-KE-bpKQ",
        },
      },
      Constants.CLIENTS.YT,
    );
    expect((await player.queue.next())?.id).toBe("jNQXAC9IVRw");
    expect(player.queue.getState().next?.id).toBe("aqz-KE-bpKQ");
  } finally {
    media.close();
  }
});
