import type { Connection } from "./connection";
import type { Mode, Capabilities } from "../shared/types";
import { MirrorClock, MirrorFrames } from "./mirror-playback";

export async function probe(): Promise<Capabilities> {
  const canvas = document.createElement("canvas");
  let h264 = false;
  if ("VideoDecoder" in window)
    try {
      h264 = (
        await (window as any).VideoDecoder.isConfigSupported({
          codec: "avc1.42E01E",
          optimizeForLatency: true,
        })
      ).supported;
    } catch {}
  return {
    secure: isSecureContext,
    canvas: !!canvas.getContext("2d"),
    webgl: !!document.createElement("canvas").getContext("webgl"),
    webcodecs: "VideoDecoder" in window,
    h264,
    audio: "AudioContext" in window || "webkitAudioContext" in window,
    websocket: "WebSocket" in window,
    userAgent: navigator.userAgent,
  };
}
// The stock live player decodes one frame per paint. Drain accumulated video
// after a slow paint so reference frames are not evicted from its input buffer.
export function catchUpLiveVideo(decoder: { decode: () => boolean }) {
  for (let count = 0; count < 31; count++) {
    if (!decoder.decode()) break;
  }
}

interface LiveDecoder {
  decodedTime: number;
  canPlay: boolean;
  decode(): boolean;
}
interface LivePlayer {
  demuxer: { startTime: number; currentTime: number };
  video?: LiveDecoder;
  audio?: LiveDecoder;
  renderer?: { render: (...args: any[]) => void };
}

// The source is a live relay, but YouTube needs a small jitter buffer and a
// media clock. Draining every received frame in one paint turns network bursts
// into visible jumps and lets the stock player discard queued audio.
export class BufferedLivePlayback {
  private latestInput = 0;
  private mediaTime = 0;
  private lastTick: number | null = null;
  private buffering = true;
  private lastInputAt = 0;
  constructor(
    private player: LivePlayer,
    private bufferSeconds = 0.65,
    private now = () => performance.now(),
  ) {}
  update() {
    const { demuxer, video, audio, renderer } = this.player;
    if (!video?.canPlay || demuxer.startTime < 0) return;
    const now = this.now();
    const input = demuxer.currentTime - demuxer.startTime;
    if (input > this.latestInput) {
      this.latestInput = input;
      this.lastInputAt = now;
    }
    if (this.buffering) {
      const headroom = this.latestInput - this.mediaTime;
      const shortClip =
        this.mediaTime === 0 &&
        headroom > 0.08 &&
        now - this.lastInputAt >= 1000;
      if (headroom < this.bufferSeconds && !shortClip) return;
      this.buffering = false;
      this.lastTick = now;
    }
    // A suspended/slow tab resumes from its media position rather than trying
    // to decode several seconds and enqueue all of their sound in one paint.
    const elapsed = Math.min((now - (this.lastTick ?? now)) / 1000, 0.1);
    this.lastTick = now;
    const target = this.mediaTime + elapsed;
    if (this.latestInput < target + 0.04) {
      this.buffering = true;
      return;
    }
    this.mediaTime = target;

    // Schedule sound ahead of the picture so a slow video decode cannot leave
    // the audio device empty. Never reset/drop already scheduled sound.
    const audioTarget = Math.min(target + 0.18, this.latestInput - 0.04);
    const audioStart = this.now();
    for (
      let count = 0;
      audio?.canPlay && audio.decodedTime < audioTarget && count < 16;
      count++
    ) {
      if (!audio.decode() || this.now() - audioStart >= 4) break;
    }

    // Keep reference frames in order, but render only the newest decoded frame
    // during a paint. This avoids repeated GPU uploads during catch-up.
    const render = renderer?.render;
    let latestFrame: any[] | null = null;
    if (renderer)
      renderer.render = (...args) => {
        latestFrame = args;
      };
    const videoStart = this.now();
    try {
      catchUpLiveVideo({
        decode: () => {
          if (video.decodedTime > target || this.now() - videoStart >= 10)
            return false;
          return video.decode();
        },
      });
    } finally {
      if (renderer && render) {
        renderer.render = render;
        if (latestFrame) render.apply(renderer, latestFrame);
      }
    }
  }
}

export class MirrorPlayer {
  socket: WebSocket | null = null;
  private audio: AudioContext | null = null;
  private gain: GainNode | null = null;
  private decoder: any = null;
  private needsKeyframe = true;
  private h264 = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private reconnects = 0;
  private nextAudio = 0;
  private destroyed = false;
  private decoding = false;
  private jpegQueue: { data: ArrayBuffer; timestamp: number }[] = [];
  private encoded: { data: ArrayBuffer; timestamp: number; key: boolean }[] =
    [];
  private codec: string | null = null;
  private animation: number | null = null;
  private clock: MirrorClock;
  private pictures: MirrorFrames;
  private playbackGeneration = 0;
  private sources = new Set<AudioBufferSourceNode>();
  frames = 0;
  constructor(
    private canvas: HTMLCanvasElement,
    private connection: Pick<Connection, "ws">,
    public mode: Mode,
    private stats: (frames: number) => void,
    private onError: (message: string) => void,
  ) {
    this.clock = new MirrorClock(mode);
    this.pictures = new MirrorFrames(this.clock);
  }
  async start() {
    const supports = await probe();
    if (this.destroyed) return;
    this.h264 = supports.h264;
    this.tick();
    this.connect();
  }
  private connect() {
    if (this.destroyed) return;
    const socket = new WebSocket(this.connection.ws("/ws/mirror"));
    this.socket = socket;
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      this.reconnects = 0;
      socket.send(
        JSON.stringify({
          type: "format",
          format: this.h264 ? "h264" : "jpeg",
        }),
      );
    };
    socket.onerror = () => socket.close();
    socket.onmessage = (event) => {
      if (this.destroyed || this.socket !== socket) return;
      if (typeof event.data === "string") {
        try {
          const config = JSON.parse(event.data);
          if (config.type === "codec" && this.h264)
            this.configure(config.codec);
        } catch {
          this.fallback();
        }
        return;
      }
      const bytes = event.data as ArrayBuffer,
        view = new DataView(bytes);
      if (bytes.byteLength < 2) return;
      if (view.getUint8(0) === 1 && bytes.byteLength > 11) {
        const timestamp = view.getFloat64(1, true);
        if (!Number.isFinite(timestamp)) return;
        this.observe(timestamp);
        this.jpegQueue.push({ data: bytes.slice(9), timestamp });
        const limit = this.mode === "quality" ? 24 : 1;
        if (this.jpegQueue.length > limit)
          this.jpegQueue.splice(0, this.jpegQueue.length - limit);
        void this.drawJPEG();
      }
      if (view.getUint8(0) === 2 && this.audio && bytes.byteLength >= 21)
        this.playAudio(bytes);
      if (
        view.getUint8(0) === 4 &&
        this.decoder?.state === "configured" &&
        bytes.byteLength > 10
      ) {
        const key = view.getUint8(1) === 1;
        const timestamp = view.getFloat64(2, true);
        if (!Number.isFinite(timestamp)) return;
        this.observe(timestamp);
        if (this.needsKeyframe && !key) return;
        if (key) this.needsKeyframe = false;
        if (this.encoded.length >= (this.mode === "quality" ? 90 : 30)) {
          // An actual sustained overload needs a fresh reference frame, rather
          // than corrupting the dependency chain by dropping a few packets.
          this.encoded = [];
          this.needsKeyframe = true;
          this.requestKeyframe();
          if (!key) return;
          this.needsKeyframe = false;
        }
        this.encoded.push({ data: bytes.slice(10), timestamp, key });
        this.pumpDecoder();
      }
    };
    socket.onclose = () => {
      if (this.destroyed || this.socket !== socket) return;
      this.closeDecoder();
      this.resetPlayback();
      this.frames = 0;
      this.stats(0);
      this.clearAudio();
      if (this.reconnects === 0)
        this.onError("Mirroring disconnected. Reconnecting…");
      const delay = Math.min(500 * 2 ** Math.min(this.reconnects++, 4), 5000);
      this.retry = setTimeout(() => {
        this.retry = null;
        this.connect();
      }, delay);
    };
  }
  configure(codec: string) {
    // The sender repeats its SPS codec on every keyframe, usually once/sec.
    if (this.codec === codec && this.decoder?.state === "configured") return;
    if (this.codec && this.codec !== codec) this.resetPlayback();
    this.needsKeyframe = true;
    this.closeDecoder();
    this.codec = codec;
    const generation = this.playbackGeneration;
    this.decoder = new (window as any).VideoDecoder({
      output: (frame: any) => {
        if (this.destroyed || generation !== this.playbackGeneration) {
          frame.close();
          return;
        }
        this.pictures.push({
          image: frame,
          width: frame.displayWidth,
          height: frame.displayHeight,
          timestamp: frame.timestamp / 1000,
          close: () => frame.close(),
        });
        this.pumpDecoder();
      },
      error: () => this.fallback(),
    });
    this.decoder.ondequeue = () => this.pumpDecoder();
    this.decoder.configure({
      codec,
      optimizeForLatency: this.mode === "latency",
    });
  }
  private closeDecoder() {
    try {
      this.decoder?.close();
    } catch {}
    this.decoder = null;
    this.codec = null;
    this.encoded = [];
    this.needsKeyframe = true;
  }
  private requestKeyframe() {
    if (this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify({ type: "keyframe" }));
  }
  private pumpDecoder() {
    while (
      this.decoder?.state === "configured" &&
      this.decoder.decodeQueueSize < 4 &&
      this.encoded.length
    ) {
      const packet = this.encoded.shift()!;
      try {
        this.decoder.decode(
          new (window as any).EncodedVideoChunk({
            type: packet.key ? "key" : "delta",
            timestamp: packet.timestamp * 1000,
            data: packet.data,
          }),
        );
      } catch {
        this.fallback();
        return;
      }
    }
  }
  private observe(timestamp: number) {
    const revision = this.clock.revision;
    this.clock.observe(timestamp, performance.now());
    if (this.clock.revision !== revision) this.clearAudio();
  }
  private tick = () => {
    if (this.destroyed) return;
    this.pumpDecoder();
    const frame = this.pictures.due(performance.now());
    if (frame) {
      try {
        this.draw(frame.image, frame.width, frame.height);
      } finally {
        frame.close();
      }
    }
    this.animation = requestAnimationFrame(this.tick);
  };
  setMode(mode: Mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    this.clock.mode = mode;
    const codec = this.codec;
    this.resetPlayback();
    this.closeDecoder();
    if (codec && this.h264) this.configure(codec);
    this.requestKeyframe();
  }
  private resetPlayback() {
    this.playbackGeneration++;
    this.pictures.clear();
    this.jpegQueue = [];
    this.encoded = [];
    this.clock.reset();
    this.clearAudio();
  }
  fallback() {
    this.h264 = false;
    this.closeDecoder();
    this.resetPlayback();
    if (this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify({ type: "format", format: "jpeg" }));
  }
  private clearAudio() {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {}
    }
    this.sources.clear();
    this.nextAudio = 0;
  }
  async drawJPEG() {
    if (this.decoding || this.destroyed) return;
    this.decoding = true;
    const generation = this.playbackGeneration;
    try {
      while (
        this.jpegQueue.length &&
        !this.destroyed &&
        generation === this.playbackGeneration
      ) {
        const { data, timestamp } = this.jpegQueue.shift()!;
        const blob = new Blob([data], { type: "image/jpeg" });
        if ("createImageBitmap" in window) {
          const bitmap = await createImageBitmap(blob);
          if (!this.destroyed && generation === this.playbackGeneration)
            this.pictures.push({
              image: bitmap,
              width: bitmap.width,
              height: bitmap.height,
              timestamp,
              close: () => bitmap.close(),
            });
          else bitmap.close();
        } else {
          const url = URL.createObjectURL(blob),
            image = new Image();
          await new Promise<void>((resolve, reject) => {
            image.onload = () => resolve();
            image.onerror = reject;
            image.src = url;
          });
          if (!this.destroyed && generation === this.playbackGeneration)
            this.pictures.push({
              image,
              width: image.width,
              height: image.height,
              timestamp,
              close: () => {},
            });
          URL.revokeObjectURL(url);
        }
      }
    } catch {
      this.onError("A mirrored frame could not be decoded.");
    } finally {
      this.decoding = false;
      if (this.jpegQueue.length && !this.destroyed) void this.drawJPEG();
    }
  }
  draw(image: CanvasImageSource, width: number, height: number) {
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.canvas.getContext("2d")!.drawImage(image, 0, 0, width, height);
    this.frames++;
    if (this.frames === 1 || this.frames % 10 === 0) this.stats(this.frames);
  }
  async unlockAudio(volume: number) {
    if (!this.audio) {
      this.audio = new AudioContext({ latencyHint: "interactive" });
      this.gain = this.audio.createGain();
      this.gain.connect(this.audio.destination);
    }
    this.gain!.gain.value = volume;
    await this.audio.resume();
  }
  setVolume(volume: number) {
    if (this.gain) this.gain.gain.value = volume;
  }
  playAudio(bytes: ArrayBuffer) {
    if (!this.audio || this.audio.state !== "running") return;
    const view = new DataView(bytes),
      rate = view.getUint32(1, true),
      count = view.getUint32(5, true);
    if (
      rate < 8000 ||
      rate > 96000 ||
      count < 1 ||
      bytes.byteLength !== 17 + count * 4
    )
      return;
    const timestamp = view.getFloat64(9, true);
    if (!Number.isFinite(timestamp)) return;
    this.observe(timestamp);
    const buffer = this.audio.createBuffer(1, count, rate),
      samples = buffer.getChannelData(0);
    for (let i = 0; i < count; i++)
      samples[i] = view.getFloat32(17 + i * 4, true);
    const now = this.audio.currentTime;
    const target =
      now + (this.clock.time(timestamp) - performance.now()) / 1000;
    const offset = Math.max(0, now - target);
    if (offset >= buffer.duration) return;
    // Keep timestamped audio continuous across ordinary packet bursts. Only
    // clock resync, reconnect, or a mode change clears scheduled sound.
    const continuous =
      this.nextAudio > now && Math.abs(this.nextAudio - target) < 0.04;
    const start = Math.max(now, continuous ? this.nextAudio : target);
    const source = this.audio.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain!);
    this.sources.add(source);
    source.onended = () => this.sources.delete(source);
    source.start(start, offset);
    this.nextAudio = start + buffer.duration - offset;
  }
  destroy() {
    this.destroyed = true;
    if (this.animation !== null) cancelAnimationFrame(this.animation);
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.socket?.close();
    this.closeDecoder();
    this.clearAudio();
    void this.audio?.close();
    this.resetPlayback();
  }
}
