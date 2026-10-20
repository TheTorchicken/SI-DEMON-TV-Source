import { expect, it } from "vitest";
import { BufferedLivePlayback, catchUpLiveVideo } from "../src/player";
import { forwardMediaChunk } from "../server/index";
import { WebSocket } from "ws";

it("consumes a second of queued live frames after a delayed paint, preserving their order", () => {
  const frames = Array.from({ length: 30 }, (_, i) => i);
  const decoded: number[] = [];
  catchUpLiveVideo({
    decode() {
      const frame = frames.shift();
      if (frame === undefined) return false;
      decoded.push(frame);
      return true;
    },
  });
  expect(decoded).toEqual(Array.from({ length: 30 }, (_, i) => i));
  expect(frames).toHaveLength(0);
});

it("bounds catch-up work rather than blocking indefinitely on a live source", () => {
  let decoded = 0;
  catchUpLiveVideo({
    decode() {
      decoded++;
      return true;
    },
  });
  expect(decoded).toBeLessThan(60);
  expect(decoded).toBeGreaterThanOrEqual(30);
});

function playbackFixture() {
  let now = 0;
  const rendered: number[] = [];
  const audioTimes: number[] = [];
  const player = {
    demuxer: { startTime: 1.4, currentTime: 1.4 },
    renderer: {
      render(frame: number) {
        rendered.push(frame);
      },
    },
    video: {
      decodedTime: 0,
      canPlay: true,
      decode() {
        player.renderer.render(Math.round(this.decodedTime * 30));
        this.decodedTime += 1 / 30;
        return true;
      },
    },
    audio: {
      decodedTime: 0,
      canPlay: true,
      decode() {
        audioTimes.push(this.decodedTime);
        this.decodedTime += 1152 / 44100;
        return true;
      },
    },
  };
  const playback = new BufferedLivePlayback(player, 0.65, () => now);
  return {
    player,
    playback,
    rendered,
    audioTimes,
    setNow: (value: number) => {
      now = value;
    },
  };
}

it("paces bursty half-second deliveries into continuous video and ordered audio", () => {
  const f = playbackFixture();
  for (let tick = 0; tick <= 180; tick++) {
    const seconds = tick / 60;
    f.setNow(seconds * 1000);
    f.player.demuxer.currentTime = 1.4 + (Math.floor(seconds / 0.5) + 1) * 0.5;
    const before = f.rendered.length;
    f.playback.update();
    expect(f.rendered.length - before).toBeLessThanOrEqual(1);
    if (seconds < 0.5) expect(f.rendered).toHaveLength(0);
  }
  expect(f.rendered.length).toBeGreaterThanOrEqual(74);
  expect(f.rendered.length).toBeLessThanOrEqual(76);
  for (let index = 1; index < f.rendered.length; index++)
    expect(f.rendered[index] - f.rendered[index - 1]).toBe(1);
  for (let index = 1; index < f.audioTimes.length; index++)
    expect(f.audioTimes[index] - f.audioTimes[index - 1]).toBeCloseTo(
      1152 / 44100,
    );
  expect(
    f.player.audio.decodedTime - f.player.video.decodedTime,
  ).toBeGreaterThan(0.1);
  expect(f.player.audio.decodedTime - f.player.video.decodedTime).toBeLessThan(
    0.22,
  );
});

it("re-buffers starvation without skipping ahead or dumping seconds of sound after a slow paint", () => {
  const f = playbackFixture();
  f.player.demuxer.currentTime = 2.2;
  for (let tick = 0; tick <= 90; tick++) {
    f.setNow((tick * 1000) / 60);
    f.playback.update();
  }
  const stalledVideo = f.player.video.decodedTime;
  const stalledAudio = f.player.audio.decodedTime;
  f.setNow(5000);
  f.playback.update();
  expect(f.player.video.decodedTime).toBe(stalledVideo);
  expect(f.player.audio.decodedTime).toBe(stalledAudio);
  f.player.demuxer.currentTime = 4;
  f.playback.update();
  expect(f.player.video.decodedTime - stalledVideo).toBeLessThan(0.05);
  f.setNow(10_000);
  const before = f.rendered.length;
  f.playback.update();
  expect(f.rendered.length - before).toBe(1);
  expect(f.player.video.decodedTime - stalledVideo).toBeLessThan(0.16);
  expect(f.player.audio.decodedTime - stalledAudio).toBeLessThan(0.3);
});

it("keeps every compressed chunk through temporary congestion and bounds stalled sockets", () => {
  const sent: Buffer[] = [];
  let terminated = false;
  const viewer = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 700 * 1024,
    send(data: Buffer) {
      sent.push(data);
    },
    terminate() {
      terminated = true;
    },
  } as unknown as WebSocket;
  const chunks = [Buffer.from([0x47, 1]), Buffer.from([0x47, 2])];
  for (const chunk of chunks) forwardMediaChunk([viewer], chunk);
  expect(sent).toEqual(chunks);
  expect(terminated).toBe(false);
  Object.defineProperty(viewer, "bufferedAmount", { value: 3 * 1024 * 1024 });
  forwardMediaChunk([viewer], Buffer.from([0x47, 3]));
  expect(terminated).toBe(true);
  expect(sent).toEqual(chunks);
});
