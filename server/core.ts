import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { State, VideoItem, Mode } from "../shared/types";

export function youtubeId(input: string): string {
  if (/^[\w-]{11}$/.test(input)) return input;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Paste a YouTube video link.");
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (
    !["youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"].includes(
      host,
    ) ||
    url.protocol !== "https:"
  )
    throw new Error("Only HTTPS YouTube video links are supported.");
  const id =
    host === "youtu.be"
      ? url.pathname.split("/")[1]
      : url.searchParams.get("v") ||
        (/^\/(shorts|live|embed)\//.test(url.pathname)
          ? url.pathname.split("/")[2]
          : "");
  if (!id || !/^[\w-]{11}$/.test(id))
    throw new Error("That link doesn’t contain a YouTube video.");
  return id;
}

export const profiles: Record<
  Mode,
  { width: number; fps: number; bitrate: string; jpeg: number; buffer: number }
> = {
  latency: { width: 720, fps: 30, bitrate: "1800k", jpeg: 0.52, buffer: 0.06 },
  quality: { width: 1280, fps: 30, bitrate: "5000k", jpeg: 0.82, buffer: 0.65 },
};

export class Store extends EventEmitter {
  state: State = {
    queue: [],
    current: null,
    status: "idle",
    position: 0,
    duration: 0,
    volume: 0.7,
    muted: false,
    screen: "youtube",
    mode: "latency",
    error: null,
    revision: 0,
    stream: 0,
    mirror: {
      connected: false,
      device: null,
      format: "jpeg",
      lastFrame: 0,
      audio: false,
    },
    casting: { status: "off", code: null, senders: [], error: null },
  };
  constructor(private directory?: string) {
    super();
    if (directory) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      try {
        const saved = JSON.parse(
          readFileSync(join(directory, "state.json"), "utf8"),
        );
        this.state.queue = Array.isArray(saved.queue)
          ? saved.queue.filter(validVideo).slice(0, 100)
          : [];
        this.state.current = validVideo(saved.current) ? saved.current : null;
        this.state.duration = this.state.current?.duration ?? 0;
        this.state.position = Math.max(0, Number(saved.position) || 0);
        this.state.mode = saved.mode === "quality" ? "quality" : "latency";
        this.state.volume = Number.isFinite(saved.volume)
          ? Math.min(1, Math.max(0, saved.volume))
          : 0.7;
        this.state.muted = saved.muted === true;
        this.state.status = this.state.current ? "paused" : "idle";
      } catch {
        /* First launch or a malformed state file: start clean. */
      }
    }
  }
  patch(patch: Partial<State>, persist = true) {
    Object.assign(this.state, patch);
    this.state.revision++;
    if (persist) this.save();
    this.emit("state", this.snapshot());
  }
  snapshot(): State {
    return structuredClone(this.state);
  }
  save() {
    if (!this.directory) return;
    const { queue, current, position, volume, muted, mode } = this.state;
    const path = join(this.directory, "state.json");
    writeFileSync(
      path + ".tmp",
      JSON.stringify({ queue, current, position, volume, muted, mode }),
      { mode: 0o600 },
    );
    renameSync(path + ".tmp", path);
  }
  enqueue(item: VideoItem) {
    if (this.state.queue.some((v) => v.id === item.id)) return;
    if (this.state.queue.length >= 100)
      throw new Error("The queue is full. Remove a video first.");
    this.patch({ queue: [...this.state.queue, item] });
  }
  move(id: string, direction: -1 | 1) {
    const queue = [...this.state.queue];
    const from = queue.findIndex((v) => v.id === id),
      to = from + direction;
    if (from < 0 || to < 0 || to >= queue.length) return;
    [queue[from], queue[to]] = [queue[to], queue[from]];
    this.patch({ queue });
  }
}
function validVideo(value: unknown): value is VideoItem {
  const v = value as VideoItem | null;
  return (
    !!v &&
    typeof v.id === "string" &&
    (v.id === "test-pattern" || /^[\w-]{11}$/.test(v.id)) &&
    typeof v.title === "string" &&
    Number.isFinite(v.duration) &&
    (v.source === "youtube" || v.source === "test")
  );
}

export function validateMirrorPacket(
  data: Buffer,
): "jpeg" | "pcm" | "h264" | null {
  if (data.length < 2 || data.length > 4 * 1024 * 1024) return null;
  if (
    data[0] === 1 &&
    data.length > 11 &&
    data[9] === 0xff &&
    data[10] === 0xd8
  )
    return "jpeg";
  if (data[0] === 2 && data.length >= 21) {
    const rate = data.readUInt32LE(1),
      frames = data.readUInt32LE(5);
    return rate >= 8000 &&
      rate <= 96000 &&
      frames > 0 &&
      frames <= 96000 &&
      data.length === 17 + frames * 4
      ? "pcm"
      : null;
  }
  if (data[0] === 4 && data.length > 14 && (data[1] === 0 || data[1] === 1))
    return "h264";
  return null;
}
