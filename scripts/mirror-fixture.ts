/** Synthetic protocol smoke test. This is not an Apple-device capture test. */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { WebSocket } from "ws";
const token = readFileSync(
  process.env.DEMON_FIXTURE_TOKEN_FILE || ".data/token",
  "utf8",
).trim();
const h264 = process.argv.includes("--h264");
const endpoint = new URL(
  process.env.DEMON_FIXTURE_URL || "ws://127.0.0.1:8787/ws/broadcast",
);
if (!["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname))
  throw new Error("Synthetic fixtures must use a loopback test relay.");
endpoint.searchParams.set("token", token);
const socket = new WebSocket(endpoint);
const seconds = Math.max(
  1,
  Math.min(120, Number(process.env.DEMON_FIXTURE_SECONDS) || 20),
);
let video: ReturnType<typeof spawn>,
  audio: ReturnType<typeof setInterval>,
  count = 0;
socket.on("open", () => {
  socket.send(
    JSON.stringify({
      type: "hello",
      device: h264 ? "Synthetic H.264 check" : "Synthetic JPEG check",
    }),
  );
  let buffer = Buffer.alloc(0);
  video = spawn("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-re",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=640x360:rate=15",
    "-t",
    String(seconds),
    ...(h264
      ? [
          "-c:v",
          "libx264",
          "-profile:v",
          "baseline",
          "-tune",
          "zerolatency",
          "-pix_fmt",
          "yuv420p",
          "-x264-params",
          "aud=1:repeat-headers=1:keyint=15",
          "-f",
          "h264",
        ]
      : ["-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", "5"]),
    "pipe:1",
  ]);
  video.stdout!.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (h264) {
      const aud = Buffer.from([0, 0, 0, 1, 9]);
      let next: number;
      while ((next = buffer.indexOf(aud, 5)) >= 0) {
        const frame = buffer.subarray(0, next);
        buffer = buffer.subarray(next);
        const nals: { offset: number; type: number }[] = [];
        for (let i = 0; i < frame.length - 5; i++) {
          if (frame[i] === 0 && frame[i + 1] === 0 && frame[i + 2] === 1) {
            nals.push({ offset: i + 3, type: frame[i + 3] & 31 });
            i += 3;
          }
        }
        const sps = nals.find((n) => n.type === 7);
        if (sps)
          socket.send(
            JSON.stringify({
              type: "codec",
              codec:
                "avc1." +
                frame.subarray(sps.offset + 1, sps.offset + 4).toString("hex"),
            }),
          );
        const header = Buffer.alloc(10);
        header[0] = 4;
        header[1] = nals.some((n) => n.type === 5) ? 1 : 0;
        header.writeDoubleLE(Date.now(), 2);
        if (socket.readyState === WebSocket.OPEN)
          socket.send(Buffer.concat([header, frame]));
      }
      return;
    }
    let end: number;
    while ((end = buffer.indexOf(Buffer.from([255, 217]))) >= 0) {
      const frame = buffer.subarray(0, end + 2);
      buffer = buffer.subarray(end + 2);
      const header = Buffer.alloc(9);
      header[0] = 1;
      header.writeDoubleLE(Date.now(), 1);
      if (socket.readyState === WebSocket.OPEN)
        socket.send(Buffer.concat([header, frame]));
    }
  });
  audio = setInterval(
    () => {
      const frames = 1024,
        packet = Buffer.alloc(17 + frames * 4);
      packet[0] = 2;
      packet.writeUInt32LE(44100, 1);
      packet.writeUInt32LE(frames, 5);
      packet.writeDoubleLE(Date.now(), 9);
      for (let i = 0; i < frames; i++)
        packet.writeFloatLE(
          Math.sin((count++ / 44100) * 440 * Math.PI * 2) * 0.1,
          17 + i * 4,
        );
      if (socket.readyState === WebSocket.OPEN) socket.send(packet);
    },
    (1024 / 44100) * 1000,
  );
  video.on("close", () => {
    clearInterval(audio);
    socket.close();
    console.log("Synthetic mirror smoke test finished.");
  });
});
socket.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
socket.on("close", () => {
  video?.kill();
  clearInterval(audio);
});
