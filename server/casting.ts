import YouTubeCastReceiver, {
  Player,
  Constants,
  DataStore,
  PlaylistRequestHandler,
  type Playlist,
  type Video,
  type Volume,
} from "yt-cast-receiver";
import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { Store } from "./core";
import { Media, metadata } from "./media";

export class CastStorage extends DataStore {
  private values: Record<string, unknown> = {};
  constructor(private directory: string) {
    super();
    try {
      this.values = JSON.parse(
        readFileSync(join(directory, "cast.json"), "utf8"),
      );
    } catch {}
  }
  async get<T>(key: string): Promise<T | null> {
    return (this.values[key] as T) ?? null;
  }
  async set<T>(key: string, value: T) {
    this.values[key] = value;
    const path = join(this.directory, "cast.json");
    writeFileSync(path + ".tmp", JSON.stringify(this.values), { mode: 0o600 });
    renameSync(path + ".tmp", path);
  }
}
export class QueueNavigation extends PlaylistRequestHandler {
  async getPreviousNextVideos(target: Video, playlist: Playlist) {
    const index = playlist.videoIds.indexOf(target.id);
    const video = (i: number): Video | null =>
      playlist.videoIds[i]
        ? {
            id: playlist.videoIds[i],
            client: target.client,
            context: {
              ...target.context,
              index: i,
              playlistId: playlist.id || undefined,
            },
          }
        : null;
    return {
      previous: index > 0 ? video(index - 1) : null,
      next: index >= 0 ? video(index + 1) : null,
    };
  }
}

export class CastPlayer extends Player {
  constructor(
    private media: Media,
    private store: Store,
  ) {
    super();
    let previous = "";
    store.on("state", () => {
      const status = store.state.status;
      if (status === previous) return;
      previous = status;
      const mapped =
        status === "playing"
          ? Constants.PLAYER_STATUSES.PLAYING
          : status === "loading"
            ? Constants.PLAYER_STATUSES.LOADING
            : status === "paused"
              ? Constants.PLAYER_STATUSES.PAUSED
              : Constants.PLAYER_STATUSES.STOPPED;
      void this.notifyExternalStateChange(mapped);
    });
  }
  async doPlay(video: Video, position: number) {
    try {
      const item = await metadata(video.id);
      this.store.patch({
        queue: this.store.state.queue.filter((v) => v.id !== item.id),
      });
      return await this.media.play(item, position);
    } catch (error) {
      this.store.patch({ error: (error as Error).message, status: "error" });
      return false;
    }
  }
  async doPause() {
    return this.media.pause();
  }
  async doResume() {
    return this.media.resume();
  }
  async doStop() {
    this.media.stop();
    return true;
  }
  async doSeek(position: number) {
    return this.media.seek(position);
  }
  async doSetVolume(volume: Volume) {
    this.store.patch({ volume: volume.level / 100, muted: volume.muted });
    return true;
  }
  async doGetVolume() {
    return {
      level: this.store.state.volume * 100,
      muted: this.store.state.muted,
    };
  }
  async doGetPosition() {
    return this.media.position();
  }
  async doGetDuration() {
    return this.store.state.duration;
  }
}

export class Casting {
  readonly name: string;
  player: CastPlayer;
  receiver: YouTubeCastReceiver | null = null;
  private editing = false;
  constructor(
    private store: Store,
    media: Media,
    private directory = ".data",
  ) {
    this.player = new CastPlayer(media, store);
    this.name = process.env.CAST_NAME?.trim() || "SI-DEMON-TV (Mac)";
    this.store.patch(
      { casting: { ...this.store.state.casting, name: this.name } },
      false,
    );
  }
  async start() {
    if (this.receiver || this.store.state.casting.status === "starting") return;
    this.store.patch(
      {
        casting: {
          ...this.store.state.casting,
          status: "starting",
          error: null,
        },
      },
      false,
    );
    try {
      const receiver = (this.receiver = new YouTubeCastReceiver(this.player, {
        device: {
          name: this.name,
          screenName: this.name,
          brand: "SI-DEMON-TV",
          model: "Self-hosted TV",
        },
        dial: {
          port: Number(process.env.CAST_PORT || 8790),
          bindToAddresses: ["127.0.0.1"],
        },
        app: {
          enableAutoplayOnConnect: false,
          playlistRequestHandler: new QueueNavigation(),
          resetPlayerOnDisconnectPolicy:
            Constants.RESET_PLAYER_ON_DISCONNECT_POLICIES
              .ALL_EXPLICITLY_DISCONNECTED,
        },
        dataStore: new CastStorage(this.directory),
        // Upstream error objects include private lounge URLs and tokens.
        // Pairing failures are surfaced through the app state instead.
        logLevel: Constants.LOG_LEVELS.NONE,
      }));
      const updateSenders = () =>
        this.store.patch(
          {
            casting: {
              ...this.store.state.casting,
              senders: receiver.getConnectedSenders().map((s) => s.name),
            },
          },
          false,
        );
      receiver.on("senderConnect", updateSenders);
      receiver.on("senderDisconnect", updateSenders);
      await receiver.start();
      if (this.receiver !== receiver) {
        await receiver.stop();
        return;
      }
      const service = receiver.getPairingCodeRequestService();
      service.on("response", (code) =>
        this.store.patch(
          {
            casting: {
              ...this.store.state.casting,
              code: String(code),
              status: "ready",
            },
          },
          false,
        ),
      );
      service.on("error", () =>
        this.store.patch(
          {
            casting: {
              ...this.store.state.casting,
              status: "error",
              error:
                "YouTube pairing is unavailable. Retry or add a link directly.",
            },
          },
          false,
        ),
      );
      service.start();
      this.store.patch(
        { casting: { ...this.store.state.casting, status: "ready" } },
        false,
      );
      for (const event of [
        "playlistUpdated",
        "playlistSet",
        "playlistAdded",
        "playlistCleared",
        "videoAdded",
        "videoRemoved",
        "videoSelected",
      ])
        (this.player.queue as EventEmitter).on(event, () => {
          if (!this.editing) void this.syncQueue();
        });
    } catch (error) {
      await this.stop();
      this.store.patch(
        {
          casting: {
            ...this.store.state.casting,
            status: "error",
            error:
              "Could not start YouTube pairing. Check the relay connection and try again.",
          },
        },
        false,
      );
      console.error("YouTube pairing could not start.");
    }
  }
  private async syncQueue() {
    const current =
      this.player.queue.current?.id || this.store.state.current?.id;
    const index = this.player.queue.videoIds.indexOf(current || "");
    const ids = this.player.queue.videoIds.slice(index + 1).slice(0, 100);
    const queue = ids.map(
      (id) =>
        this.store.state.queue.find((v) => v.id === id) || {
          id,
          title: "YouTube video",
          author: "",
          thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
          duration: 0,
          source: "youtube" as const,
        },
    );
    if (!this.receiver) return;
    this.store.patch({ queue });
    // Enrich a bounded batch without delaying the phone's queue command.
    for (const item of queue.slice(0, 8)) {
      if (item.title !== "YouTube video") continue;
      void metadata(item.id)
        .then((value) => {
          if (
            this.receiver &&
            this.store.state.queue.some((v) => v.id === value.id)
          )
            this.store.patch({
              queue: this.store.state.queue.map((v) =>
                v.id === value.id ? value : v,
              ),
            });
        })
        .catch(() => {});
    }
  }
  async publishQueue() {
    if (
      !this.receiver ||
      !this.store.state.current ||
      this.store.state.current.source !== "youtube"
    )
      return;
    this.editing = true;
    try {
      const current = this.store.state.current.id;
      await this.player.queue.updateByMessage(
        {
          AID: null,
          name: "setPlaylist",
          payload: {
            listId: this.player.queue.id || "SI-DEMON-QUEUE",
            videoId: current,
            currentIndex: "0",
            videoIds: [
              current,
              ...this.store.state.queue.map((v) => v.id),
            ].join(","),
          },
        },
        Constants.CLIENTS.YT,
      );
      await this.player.notifyExternalStateChange();
    } finally {
      this.editing = false;
    }
  }
  async stop() {
    const receiver = this.receiver;
    this.receiver = null;
    if (receiver) {
      receiver.getPairingCodeRequestService().stop();
      await receiver.stop().catch(() => {});
    }
    for (const event of [
      "playlistUpdated",
      "playlistSet",
      "playlistAdded",
      "playlistCleared",
      "videoAdded",
      "videoRemoved",
      "videoSelected",
    ])
      this.player.queue.removeAllListeners(event);
    this.store.patch(
      {
        casting: {
          name: this.name,
          status: "off",
          code: null,
          senders: [],
          error: null,
        },
      },
      false,
    );
  }
}
