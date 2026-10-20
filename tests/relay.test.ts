import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { WebSocket } from "ws";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRelay } from "../server/index";
const directory = mkdtempSync(join(tmpdir(), "demon-relay-"));
const relay = createRelay({ directory, token: "synthetic-test-key" });
let base: string;
const sockets: WebSocket[] = [];
beforeAll(async () => {
  await new Promise<void>((resolve) =>
    relay.server.listen(0, "127.0.0.1", resolve),
  );
  base = `http://127.0.0.1:${(relay.server.address() as any).port}`;
});
afterAll(async () => {
  for (const ws of sockets) ws.terminate();
  await relay.close();
  rmSync(directory, { recursive: true });
});
function request(path: string, body?: unknown, key = "synthetic-test-key") {
  return fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function socket(channel: string) {
  const ws = new WebSocket(
    base.replace("http:", "ws:") + `/ws/${channel}?token=synthetic-test-key`,
  );
  sockets.push(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return ws;
}
describe("personal relay", () => {
  it("only issues phrases with the full key and exchanges each phrase once", async () => {
    expect((await request("/api/pairing", {}, "")).status).toBe(401);
    const { phrase } = await (await request("/api/pairing", {})).json();
    const blocked = await fetch(base + "/api/pair", {
      method: "POST",
      headers: {
        Origin: "https://attacker.test",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ phrase }),
    });
    expect(blocked.status).toBe(403);
    expect((await request("/api/state", undefined, phrase)).status).toBe(401);
    const accepted = await request("/api/pair", { phrase }, "");
    expect(accepted.status).toBe(200);
    expect((await accepted.json()).token).toBe("synthetic-test-key");
    expect((await request("/api/pair", { phrase }, "")).status).toBe(401);
  });
  it("rejects missing keys and untrusted origins", async () => {
    expect((await request("/api/state", undefined, "")).status).toBe(401);
    const denied = await fetch(base + "/api/bootstrap", {
      headers: { Origin: "https://attacker.test" },
    });
    expect(denied.status).toBe(403);
    expect((await request("/api/state")).status).toBe(200);
  });
  it("rejects invalid commands instead of mutating playback", async () => {
    for (const body of [
      { type: "mode", mode: "wrong" },
      { type: "volume", volume: -1 },
      { type: "seek", position: -5 },
      { type: "unknown" },
    ])
      expect((await request("/api/command", body)).status).toBe(400);
  });
  it("delivers authenticated Apple video and audio, and sends mode changes to the broadcaster", async () => {
    const viewer = await socket("mirror");
    viewer.send(JSON.stringify({ type: "format", format: "h264" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const producer = await socket("broadcast");
    const modePromise = new Promise<any>((resolve) =>
      producer.on("message", (data, binary) => {
        if (!binary) {
          const value = JSON.parse(data.toString());
          if (value.mode === "quality") resolve(value);
        }
      }),
    );
    await request("/api/command", { type: "mode", mode: "quality" });
    expect((await modePromise).width).toBe(1280);
    expect(relay.store.state.mirror.format).toBe("h264");
    const packet = Buffer.alloc(21);
    packet[0] = 2;
    packet.writeUInt32LE(44100, 1);
    packet.writeUInt32LE(1, 5);
    packet.writeFloatLE(0.25, 17);
    const received = new Promise<Buffer>((resolve) =>
      viewer.once("message", (data) => resolve(Buffer.from(data as Buffer))),
    );
    producer.send(packet);
    expect(await received).toEqual(packet);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(relay.store.state.mirror.connected).toBe(true);
    expect(relay.store.state.mirror.audio).toBe(true);
    let keyframes = 0;
    const requested = new Promise<void>((resolve) =>
      producer.on("message", (data, binary) => {
        if (!binary && JSON.parse(data.toString()).type === "keyframe") {
          keyframes++;
          resolve();
        }
      }),
    );
    viewer.send(JSON.stringify({ type: "keyframe" }));
    viewer.send(JSON.stringify({ type: "keyframe" }));
    await requested;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(keyframes).toBe(1);
    producer.close();
    viewer.close();
  });
  it("streams actual FFmpeg MPEG-TS bytes and pauses/resumes with a new generation", async () => {
    const viewer = await socket("youtube");
    const bytes = new Promise<Buffer>((resolve) =>
      viewer.once("message", (data) => resolve(Buffer.from(data as Buffer))),
    );
    await request("/api/command", { type: "test" });
    const data = await bytes;
    expect(data.length).toBeGreaterThan(188);
    expect(data[0]).toBe(0x47);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(relay.store.state.status).toBe("playing");
    const stream = relay.store.state.stream;
    await request("/api/command", { type: "pause" });
    expect(relay.store.state.status).toBe("paused");
    await request("/api/command", { type: "resume" });
    expect(relay.store.state.stream).toBeGreaterThan(stream);
    await request("/api/command", { type: "screen", screen: "mirror" });
    expect(relay.store.state.status).toBe("paused");
    await request("/api/command", { type: "stop" });
    expect(relay.store.state.current).toBeNull();
    viewer.close();
  });
});
