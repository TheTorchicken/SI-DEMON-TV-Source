import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MirrorPlayer } from "../src/player";
import type { Connection } from "../src/connection";

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen?: () => void;
  onclose?: () => void;
  onerror?: () => void;
  onmessage?: (event: { data: unknown }) => void;
  constructor(public url: string) {
    Socket.instances.push(this);
  }
  send(value: string) {
    this.sent.push(value);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

class Decoder {
  static instances: Decoder[] = [];
  static async isConfigSupported() {
    return { supported: true };
  }
  state = "unconfigured";
  decodeQueueSize = 0;
  decoded: unknown[] = [];
  ondequeue?: () => void;
  constructor(_callbacks: unknown) {
    Decoder.instances.push(this);
  }
  configure() {
    this.state = "configured";
  }
  decode(chunk: unknown) {
    this.decoded.push(chunk);
    this.decodeQueueSize++;
  }
  complete() {
    this.decodeQueueSize--;
    this.ondequeue?.();
  }
  close() {
    this.state = "closed";
  }
}

let player: MirrorPlayer;
beforeEach(() => {
  vi.useFakeTimers();
  Socket.instances = [];
  Decoder.instances = [];
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("window", {
    VideoDecoder: Decoder,
    EncodedVideoChunk: class {
      constructor(public value: unknown) {}
    },
  });
  vi.stubGlobal("document", {
    createElement: () => ({ getContext: () => ({}) }),
  });
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("navigator", { userAgent: "synthetic mirror lifecycle test" });
  vi.stubGlobal("requestAnimationFrame", (callback: (now: number) => void) =>
    setTimeout(() => callback(performance.now()), 16),
  );
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  const connection = {
    ws: () => "ws://localhost/ws/mirror?token=synthetic",
  } satisfies Pick<Connection, "ws">;
  player = new MirrorPlayer(
    {} as HTMLCanvasElement,
    connection,
    "latency",
    vi.fn(),
    vi.fn(),
  );
});
afterEach(() => {
  player.destroy();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("reconnects after a drop, renegotiates format and waits for a new keyframe", async () => {
  await player.start();
  const first = Socket.instances[0];
  first.open();
  first.onmessage?.({
    data: JSON.stringify({ type: "codec", codec: "avc1.42e01e" }),
  });
  const decoder = Decoder.instances[0];
  first.close();
  expect(decoder.state).toBe("closed");
  await vi.advanceTimersByTimeAsync(500);
  const second = Socket.instances[1];
  second.open();
  expect(JSON.parse(second.sent[0]).format).toBe("h264");
  second.onmessage?.({
    data: JSON.stringify({ type: "codec", codec: "avc1.42e01e" }),
  });
  const packet = new ArrayBuffer(11);
  const view = new DataView(packet);
  view.setUint8(0, 4);
  view.setFloat64(2, 100, true);
  second.onmessage?.({ data: packet });
  const replacement = Decoder.instances[1];
  expect(replacement.decoded).toHaveLength(0);
  view.setUint8(1, 1);
  second.onmessage?.({ data: packet });
  expect(replacement.decoded).toHaveLength(1);
});

it("preserves JPEG fallback across reconnects and cancels retries when leaving Mirror", async () => {
  await player.start();
  const first = Socket.instances[0];
  first.open();
  player.fallback();
  first.close();
  await vi.advanceTimersByTimeAsync(500);
  const second = Socket.instances[1];
  second.open();
  expect(JSON.parse(second.sent[0]).format).toBe("jpeg");
  second.close();
  player.destroy();
  await vi.advanceTimersByTimeAsync(10000);
  expect(Socket.instances).toHaveLength(2);
});

it("keeps the decoder alive when the sender repeats the same codec at each keyframe", async () => {
  await player.start();
  const socket = Socket.instances[0];
  socket.open();
  const config = JSON.stringify({ type: "codec", codec: "avc1.42e01e" });
  socket.onmessage?.({ data: config });
  socket.onmessage?.({ data: config });
  expect(Decoder.instances).toHaveLength(1);
  expect(Decoder.instances[0].state).toBe("configured");
});

it("feeds a burst of H264 reference frames in order without dropping deltas or waiting for a new keyframe", async () => {
  await player.start();
  const socket = Socket.instances[0];
  socket.open();
  socket.onmessage?.({
    data: JSON.stringify({ type: "codec", codec: "avc1.42e01e" }),
  });
  const decoder = Decoder.instances[0];
  for (let frame = 0; frame < 18; frame++) {
    const packet = new ArrayBuffer(11),
      view = new DataView(packet);
    view.setUint8(0, 4);
    view.setUint8(1, frame === 0 ? 1 : 0);
    view.setFloat64(2, (frame * 1000) / 30, true);
    socket.onmessage?.({ data: packet });
  }
  expect(decoder.decoded).toHaveLength(4);
  for (let frame = 0; frame < 18; frame++) decoder.complete();
  expect(decoder.decoded).toHaveLength(18);
  const timestamps = decoder.decoded.map((chunk: any) => chunk.value.timestamp);
  expect(timestamps).toEqual(
    Array.from({ length: 18 }, (_, frame) => ((frame * 1000) / 30) * 1000),
  );
  expect(socket.sent.map((value) => JSON.parse(value).type)).not.toContain(
    "keyframe",
  );
});

it("schedules a Quality audio burst continuously without chopping the queued sound at 300 ms", async () => {
  const sources: {
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }[] = [];
  vi.stubGlobal(
    "AudioContext",
    class {
      state = "running";
      currentTime = 0;
      destination = {};
      createGain() {
        return { gain: { value: 1 }, connect() {} };
      }
      createBuffer(_channels: number, count: number, rate: number) {
        return {
          duration: count / rate,
          getChannelData: () => new Float32Array(count),
        };
      }
      createBufferSource() {
        const source = {
          buffer: null,
          connect() {},
          onended: null,
          start: vi.fn(),
          stop: vi.fn(),
        };
        sources.push(source);
        return source;
      }
      async resume() {}
      async close() {}
    },
  );
  player.setMode("quality");
  await player.unlockAudio(0.8);
  for (let index = 0; index < 48; index++) {
    const packet = new ArrayBuffer(17 + 512 * 4),
      view = new DataView(packet);
    view.setUint8(0, 2);
    view.setUint32(1, 44100, true);
    view.setUint32(5, 512, true);
    view.setFloat64(9, ((index * 512) / 44100) * 1000, true);
    player.playAudio(packet);
  }
  expect(sources).toHaveLength(48);
  for (const source of sources) expect(source.stop).not.toHaveBeenCalled();
  for (let index = 1; index < sources.length; index++)
    expect(
      sources[index].start.mock.calls[0][0] -
        sources[index - 1].start.mock.calls[0][0],
    ).toBeCloseTo(512 / 44100);
});
