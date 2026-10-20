import type { Mode } from "../shared/types";

export const mirrorBufferSeconds = (mode: Mode) =>
  mode === "quality" ? 0.65 : 0.06;

/** One producer clock shared by picture and sound, independent of network arrival bursts. */
export class MirrorClock {
  private source: number | null = null;
  private wall = 0;
  revision = 0;
  constructor(public mode: Mode) {}
  reset() {
    this.source = null;
    this.revision++;
  }
  observe(timestamp: number, now: number) {
    const delay = mirrorBufferSeconds(this.mode) * 1000;
    if (this.source === null) {
      this.source = timestamp;
      this.wall = now + delay;
      this.revision++;
    } else {
      const due = this.time(timestamp);
      const slack = this.mode === "quality" ? 1000 : 120;
      if (due > now + delay + slack || due < now - slack) {
        this.source = timestamp;
        this.wall = now + delay;
        this.revision++;
      }
    }
  }
  time(timestamp: number) {
    return this.wall + timestamp - (this.source ?? timestamp);
  }
}

export interface MirrorFrame {
  image: CanvasImageSource;
  width: number;
  height: number;
  timestamp: number;
  close(): void;
}

/** Only decoded, independent images may be discarded; compressed H.264 references stay ordered. */
export class MirrorFrames {
  private frames: MirrorFrame[] = [];
  constructor(private clock: MirrorClock) {}
  push(frame: MirrorFrame) {
    this.frames.push(frame);
    const limit = this.clock.mode === "quality" ? 48 : 6;
    while (this.frames.length > limit) this.frames.shift()!.close();
  }
  due(now: number): MirrorFrame | null {
    let newest: MirrorFrame | null = null;
    while (
      this.frames.length &&
      this.clock.time(this.frames[0].timestamp) <= now
    ) {
      newest?.close();
      newest = this.frames.shift()!;
    }
    return newest;
  }
  clear() {
    for (const frame of this.frames) frame.close();
    this.frames = [];
  }
}
