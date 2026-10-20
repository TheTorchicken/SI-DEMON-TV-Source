import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { Store, youtubeId } from "./core";
import type { Mode, VideoItem } from "../shared/types";
import { youtubeBufferSeconds } from "../shared/playback";

// MPEG-1 is decoded in the browser. Keep its network and CPU budget separate
// from the native H.264 mirroring profiles.
const youtubeProfiles: Record<
  Mode,
  {
    width: number;
    fps: number;
    bitrate: string;
    maxrate: string;
    bufsize: string;
  }
> = {
  latency: {
    width: 720,
    fps: 30,
    bitrate: "1800k",
    maxrate: "2400k",
    bufsize: "1200k",
  },
  quality: {
    width: 1280,
    fps: 30,
    bitrate: "5000k",
    maxrate: "6000k",
    bufsize: "3000k",
  },
};

export function run(
  binary: string,
  args: string[],
  timeout = 45000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const process = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "",
      error = "",
      settled = false;
    const timer = setTimeout(() => {
      process.kill("SIGKILL");
      finish(new Error(`${binary} timed out.`));
    }, timeout);
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      err ? reject(err) : resolve(output);
    };
    process.stdout.on("data", (data) => {
      output += data;
      if (output.length > 8 * 1024 * 1024) {
        process.kill();
        finish(new Error("Media response was too large."));
      }
    });
    process.stderr.on("data", (data) => {
      error = (error + data).slice(-2500);
    });
    process.on("error", () =>
      finish(new Error(`${binary} is missing. Run npm run doctor.`)),
    );
    process.on("close", (code) =>
      finish(
        code
          ? new Error(
              error.includes("Sign in")
                ? "YouTube requires sign-in for this video. Configure YTDLP_COOKIES or choose another video."
                : `${binary} could not load this media. ${error.replace(/https?:\/\/\S+/g, "[URL]").slice(-350)}`,
            )
          : undefined,
      ),
    );
  });
}
const ytdlp = process.env.YTDLP_PATH || "yt-dlp";
const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
const cookieArgs = () =>
  process.env.YTDLP_COOKIES ? ["--cookies", process.env.YTDLP_COOKIES] : [];
const cache = new Map<string, VideoItem>();

export async function metadata(input: string): Promise<VideoItem> {
  const id = youtubeId(input);
  if (cache.has(id)) return cache.get(id)!;
  const data = JSON.parse(
    await run(ytdlp, [
      "--skip-download",
      "--no-playlist",
      "--dump-single-json",
      ...cookieArgs(),
      `https://www.youtube.com/watch?v=${id}`,
    ]),
  );
  const item = toItem(data);
  cache.set(id, item);
  return item;
}
function toItem(data: Record<string, any>): VideoItem {
  return {
    id: youtubeId(data.id),
    title: String(data.title || "YouTube video"),
    author: String(data.uploader || data.channel || ""),
    duration: Number(data.duration) || 0,
    thumbnail: `https://i.ytimg.com/vi/${youtubeId(data.id)}/hqdefault.jpg`,
    source: "youtube",
  };
}
export async function search(query: string): Promise<VideoItem[]> {
  if (!query.trim() || query.length > 200)
    throw new Error("Enter a search of up to 200 characters.");
  const result = JSON.parse(
    await run(ytdlp, [
      "--flat-playlist",
      "--dump-single-json",
      ...cookieArgs(),
      `ytsearch8:${query}`,
    ]),
  );
  return (result.entries || []).map(toItem);
}

export interface StreamSource {
  url: string;
  headers?: Record<string, string>;
}
async function resolveYoutubeSources(id: string): Promise<StreamSource[]> {
  const data = JSON.parse(
    await run(ytdlp, [
      "--no-playlist",
      "--dump-single-json",
      "--format",
      "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720]/best",
      ...cookieArgs(),
      `https://www.youtube.com/watch?v=${id}`,
    ]),
  );
  return (data.requested_formats || [data]).map((format: any) => ({
    url: String(format.url),
    headers: { ...data.http_headers, ...format.http_headers },
  }));
}

export class Media extends EventEmitter {
  child: ChildProcess | null = null;
  private generation = 0;
  private startTime = 0;
  private startPosition = 0;
  private bufferSeconds = 0.4;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private timer: ReturnType<typeof setInterval>;
  private sources: {
    id: string;
    expires: number;
    formats: StreamSource[];
  } | null = null;
  onEnded: (() => void) | null = null;
  constructor(
    public store: Store,
    private resolveSources: (
      id: string,
    ) => Promise<StreamSource[]> = resolveYoutubeSources,
  ) {
    super();
    this.timer = setInterval(() => {
      if (store.state.status === "playing")
        store.patch({ position: this.position() }, false);
    }, 1000);
    this.timer.unref();
  }
  position() {
    const position =
      this.store.state.status === "playing"
        ? this.startPosition + Math.max(0, (Date.now() - this.startTime) / 1000)
        : this.store.state.position;
    return this.store.state.duration > 0
      ? Math.min(position, this.store.state.duration)
      : position;
  }
  cancel() {
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.drainTimer = null;
    this.generation++;
    this.child?.kill("SIGTERM");
    this.child = null;
  }
  async play(item: VideoItem, position = 0, refreshAttempt = 0) {
    this.cancel();
    const generation = this.generation;
    this.store.patch({
      current: item,
      duration: item.duration,
      position,
      status: "loading",
      error: null,
      screen: "youtube",
    });
    try {
      const profile = youtubeProfiles[this.store.state.mode];
      this.bufferSeconds = youtubeBufferSeconds(
        this.store.state.mode,
        item.duration > 0 ? item.duration - position : undefined,
      );
      let args: string[];
      if (item.source === "test") {
        args = [
          "-re",
          "-f",
          "lavfi",
          "-i",
          `testsrc2=size=${profile.width}x${Math.round((profile.width * 9) / 32) * 2}:rate=${profile.fps}`,
          "-re",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:sample_rate=44100",
          "-t",
          "30",
        ];
        // A deterministic clip exercises the real demuxer, decoder and audio path.
      } else {
        let formats =
          this.sources?.id === item.id && this.sources.expires > Date.now()
            ? this.sources.formats
            : null;
        if (!formats) {
          formats = await this.resolveSources(item.id);
          if (generation !== this.generation) return false;
          const deadlines = formats.map((format) => {
            const expiry = Number(
              new URL(format.url).searchParams.get("expire"),
            );
            return expiry > 0 ? expiry * 1000 - 30000 : Date.now() + 300000;
          });
          this.sources = {
            id: item.id,
            formats,
            expires: Math.min(Date.now() + 300000, ...deadlines),
          };
        }
        args = formats.flatMap((format) => {
          const headers = Object.entries(format.headers || {})
            .filter(
              ([name, value]) =>
                /^[\w-]+$/.test(name) &&
                typeof value === "string" &&
                !/[\r\n]/.test(value),
            )
            .map(([name, value]) => `${name}: ${value}\r\n`)
            .join("");
          return [
            "-re",
            ...(headers ? ["-headers", headers] : []),
            ...(position > 0 ? ["-ss", String(position)] : []),
            "-i",
            format.url,
          ];
        });
        args.push(
          "-map",
          "0:v:0",
          "-map",
          formats.length > 1 ? "1:a:0?" : "0:a:0?",
        );
      }
      if (generation !== this.generation) return false;
      args.push(
        "-vf",
        `scale=${profile.width}:-2`,
        "-c:v",
        "mpeg1video",
        "-b:v",
        profile.bitrate,
        "-maxrate",
        profile.maxrate,
        "-bufsize",
        profile.bufsize,
        "-r",
        String(profile.fps),
        "-g",
        String(Math.floor(profile.fps / 2)),
        "-bf",
        "0",
        "-c:a",
        "mp2",
        "-b:a",
        "128k",
        "-ar",
        "44100",
        "-ac",
        "2",
        "-f",
        "mpegts",
        "-muxdelay",
        "0.001",
        "-flush_packets",
        "1",
        "pipe:1",
      );
      const child = (this.child = spawn(
        ffmpeg,
        ["-hide_banner", "-loglevel", "error", ...args],
        { stdio: ["ignore", "pipe", "pipe"] },
      ));
      let gotData = false,
        error = "";
      this.startPosition = position;
      this.startTime = Date.now();
      this.store.patch({ stream: this.store.state.stream + 1 });
      child.stdout!.on("data", (data) => {
        if (generation !== this.generation) return;
        if (!gotData) {
          gotData = true;
          this.startTime = Date.now() + this.bufferSeconds * 1000;
          this.store.patch({ status: "playing" });
        }
        this.emit("chunk", data);
      });
      child.stderr!.on("data", (data) => {
        error = (error + data).slice(-1500);
      });
      child.on("error", () => {
        if (generation === this.generation)
          this.store.patch({
            status: "error",
            error: "FFmpeg could not start. Run npm run doctor.",
          });
      });
      child.on("close", (code) => {
        if (generation !== this.generation) return;
        this.child = null;
        if (
          code &&
          !gotData &&
          /403|Forbidden/i.test(error) &&
          refreshAttempt < 1 &&
          item.source === "youtube"
        ) {
          this.sources = null;
          setTimeout(() => {
            if (generation === this.generation)
              void this.play(item, position, refreshAttempt + 1);
          }, 500);
          return;
        }
        if (code && !gotData)
          this.store.patch({
            status: "error",
            error:
              "The stream could not start. Try another video or check relay diagnostics.",
          });
        else if (code)
          this.store.patch({
            status: "error",
            error: "The stream stopped unexpectedly. Tap play to reconnect.",
          });
        else {
          // Let the browser play the buffered tail before replacing its player
          // with the next video (or clearing it when the queue is empty).
          this.drainTimer = setTimeout(
            () => {
              this.drainTimer = null;
              if (generation !== this.generation) return;
              this.store.patch({ status: "paused", position: this.position() });
              this.onEnded?.();
            },
            Math.ceil((this.bufferSeconds + 0.3) * 1000),
          );
        }
        if (code)
          console.error(
            "Stream exited:",
            error.replace(/https?:\/\/\S+/g, "[URL]").slice(-300),
          );
      });
      return true;
    } catch (error) {
      if (generation === this.generation)
        this.store.patch({ status: "error", error: (error as Error).message });
      return false;
    }
  }
  pause() {
    const position = this.position();
    this.cancel();
    this.store.patch({ status: "paused", position });
    return true;
  }
  resume() {
    return this.store.state.current
      ? this.play(this.store.state.current, this.store.state.position)
      : Promise.resolve(false);
  }
  seek(position: number) {
    if (!Number.isFinite(position) || position < 0)
      throw new Error("Invalid playback position.");
    const bounded = this.store.state.duration
      ? Math.min(position, this.store.state.duration)
      : position;
    return this.store.state.current
      ? this.play(this.store.state.current, bounded)
      : Promise.resolve(false);
  }
  stop() {
    this.cancel();
    this.store.patch({
      status: "idle",
      current: null,
      position: 0,
      duration: 0,
    });
  }
  close() {
    clearInterval(this.timer);
    this.cancel();
  }
}
