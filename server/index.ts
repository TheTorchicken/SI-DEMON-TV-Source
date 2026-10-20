import express from "express";
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { Store, profiles, validateMirrorPacket } from "./core";
import { Media, metadata, search, run } from "./media";
import { Casting } from "./casting";
import { Pairing } from "./pairing";
import type { Command } from "../shared/types";

export function forwardMediaChunk(
  viewers: Iterable<WebSocket>,
  data: Buffer | string,
) {
  for (const socket of viewers) {
    if (socket.readyState !== WebSocket.OPEN) continue;
    // Dropping compressed media packets corrupts reference frames and audio.
    // Preserve every byte in order; bound stalled connections by reconnecting.
    if (socket.bufferedAmount > 2 * 1024 * 1024) socket.terminate();
    else socket.send(data, { binary: Buffer.isBuffer(data) });
  }
}

export function createRelay(
  options: { directory?: string; token?: string } = {},
) {
  const directory = options.directory || resolve(".data");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let token = options.token || process.env.DEMON_TOKEN;
  if (!token) {
    try {
      token = readFileSync(join(directory, "token"), "utf8").trim();
    } catch {
      token = randomBytes(24).toString("base64url");
      writeFileSync(join(directory, "token"), token, { mode: 0o600 });
    }
  }
  const secret = token;
  const pairing = new Pairing(join(directory, "pairing.json"));
  const allowedOrigins = new Set(
    (
      process.env.FRONTEND_ORIGINS ||
      "http://localhost:5173,http://127.0.0.1:5173"
    )
      .split(",")
      .map((s) => s.trim()),
  );
  const app = express(),
    server = createServer(app),
    sockets = new WebSocketServer({
      noServer: true,
      maxPayload: 4 * 1024 * 1024,
    });
  const store = new Store(directory),
    media = new Media(store),
    casting = new Casting(store, media, directory);
  const channels = {
    state: new Set<WebSocket>(),
    youtube: new Set<WebSocket>(),
    mirror: new Set<WebSocket>(),
  };
  let broadcaster: WebSocket | null = null,
    mirrorConfig: string | null = null;
  const authorized = (candidate: string) => {
    const a = Buffer.from(candidate),
      b = Buffer.from(secret);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const trustedOrigin = (
    origin: string | undefined,
    host: string | undefined,
  ) =>
    !origin ||
    allowedOrigins.has(origin) ||
    origin === `http://${host}` ||
    origin === `https://${host}`;
  const sendState = () => {
    for (const socket of channels.state)
      if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify(store.snapshot()));
  };
  store.on("state", sendState);
  media.on("chunk", (data: Buffer) =>
    forwardMediaChunk(channels.youtube, data),
  );
  const configureMirror = () =>
    broadcaster?.readyState === WebSocket.OPEN &&
    broadcaster.send(
      JSON.stringify({
        type: "configure",
        mode: store.state.mode,
        ...profiles[store.state.mode],
        format: store.state.mirror.format,
      }),
    );

  app.disable("x-powered-by");
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (!trustedOrigin(origin, req.headers.host)) {
      res.status(403).json({ error: "This dashboard origin is not allowed." });
      return;
    }
    if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });
  app.use(express.json({ limit: "64kb" }));
  app.get("/api/health", (_req, res) =>
    res.json({ app: "SI-DEMON-TV", version: "1.0.0", ready: true }),
  );
  app.get("/api/bootstrap", (req, res) => {
    const peer = req.socket.remoteAddress;
    const local =
      peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
    const host = req.headers.host?.split(":")[0];
    if (!local || !["127.0.0.1", "localhost"].includes(host || "")) {
      res.status(403).json({
        error: "Open the relay locally to obtain its connection key.",
      });
      return;
    }
    res.json({ token: secret });
  });
  app.post("/api/pair", (req, res) => {
    const result = pairing.redeem(req.body?.phrase);
    if (result === "limited") {
      res.setHeader("Retry-After", "60");
      res
        .status(429)
        .json({ error: "Wait a minute before trying the phrase again." });
    } else if (result === "invalid") {
      res.status(401).json({
        error: "Pairing phrase is incorrect, expired, or already used.",
      });
    } else {
      res.json({ token: secret });
    }
  });
  app.use("/api", (req, res, next) => {
    if (
      !authorized((req.headers.authorization || "").replace(/^Bearer /, ""))
    ) {
      res.status(401).json({ error: "Connect with your relay key." });
      return;
    }
    next();
  });
  app.post("/api/pairing", (_req, res) => res.json(pairing.issue()));
  app.get("/api/state", (_req, res) => res.json(store.snapshot()));
  app.get("/api/search", async (req, res) => {
    try {
      res.json(await search(String(req.query.q || "")));
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });
  app.get("/api/diagnostics", async (_req, res) => {
    const results = await Promise.all(
      ["ffmpeg", "yt-dlp"].map(async (binary) => {
        try {
          return {
            name: binary,
            available: true,
            version: (
              await run(
                binary,
                [binary === "ffmpeg" ? "-version" : "--version"],
                5000,
              )
            ).split("\n")[0],
          };
        } catch {
          return { name: binary, available: false, version: "Not found" };
        }
      }),
    );
    res.json({
      tools: results,
      viewers: channels.youtube.size + channels.mirror.size,
      mirrorConnected: !!broadcaster,
      uptime: process.uptime(),
    });
  });
  async function next() {
    if (casting.receiver && casting.player.queue.videoIds.length) {
      if (casting.player.queue.hasNext) return casting.player.next();
      media.stop();
      return;
    }
    const item = store.state.queue[0];
    if (!item) {
      media.stop();
      return;
    }
    store.patch({ queue: store.state.queue.slice(1) });
    return media.play(item);
  }
  media.onEnded = () => {
    void next();
  };
  app.post("/api/command", async (req, res) => {
    try {
      const command = req.body as Command;
      switch (command.type) {
        case "enqueue":
          store.enqueue(await metadata(command.id));
          break;
        case "play": {
          const item = command.id
            ? store.state.queue.find((v) => v.id === command.id) ||
              (await metadata(command.id))
            : store.state.current || store.state.queue[0];
          if (!item) throw new Error("Add a video or pair your phone first.");
          store.patch({
            queue: store.state.queue.filter((v) => v.id !== item.id),
          });
          await media.play(
            item,
            item.id === store.state.current?.id ? store.state.position : 0,
          );
          break;
        }
        case "pause":
          casting.receiver ? await casting.player.pause() : media.pause();
          break;
        case "resume":
          casting.receiver
            ? await casting.player.resume()
            : await media.resume();
          break;
        case "stop":
          media.stop();
          break;
        case "next":
          await next();
          break;
        case "seek":
          if (casting.receiver) await casting.player.seek(command.position);
          else await media.seek(command.position);
          break;
        case "volume": {
          if (
            !Number.isFinite(command.volume) ||
            command.volume < 0 ||
            command.volume > 1
          )
            throw new Error("Invalid volume.");
          if (casting.receiver)
            await casting.player.setVolume({
              level: command.volume * 100,
              muted: command.muted ?? store.state.muted,
            });
          else
            store.patch({
              volume: command.volume,
              muted: command.muted ?? store.state.muted,
            });
          break;
        }
        case "remove":
          store.patch({
            queue: store.state.queue.filter((v) => v.id !== command.id),
          });
          break;
        case "move":
          if (command.direction !== 1 && command.direction !== -1)
            throw new Error("Invalid queue direction.");
          store.move(command.id, command.direction);
          break;
        case "screen":
          if (!["youtube", "mirror"].includes(command.screen))
            throw new Error("Invalid screen.");
          if (
            command.screen === "mirror" &&
            ["playing", "loading"].includes(store.state.status)
          )
            media.pause();
          store.patch({ screen: command.screen });
          break;
        case "mode": {
          if (!["latency", "quality"].includes(command.mode))
            throw new Error("Invalid mode.");
          store.patch({ mode: command.mode });
          configureMirror();
          if (store.state.status === "playing" && store.state.current)
            await media.play(store.state.current, media.position());
          break;
        }
        case "test":
          await media.play({
            id: "test-pattern",
            title: "Screen + sound check",
            author: "SI-DEMON-TV",
            thumbnail: "",
            duration: 30,
            source: "test",
          });
          break;
        case "cast-start":
          await casting.start();
          break;
        case "cast-stop":
          await casting.stop();
          break;
        default:
          throw new Error("Unknown command.");
      }
      if (["enqueue", "remove", "move", "play"].includes(command.type))
        await casting.publishQueue();
      res.json(store.snapshot());
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });
  app.post("/api/probe", (req, res) => {
    const allowed = [
      "secure",
      "canvas",
      "webgl",
      "webcodecs",
      "h264",
      "audio",
      "websocket",
      "userAgent",
    ];
    const report = Object.fromEntries(
      allowed
        .filter((key) => key in req.body)
        .map((key) => [key, String(req.body[key]).slice(0, 500)]),
    );
    writeFileSync(
      join(directory, "last-probe.json"),
      JSON.stringify({ at: new Date().toISOString(), report }, null, 2),
      { mode: 0o600 },
    );
    res.json({ saved: true });
  });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (
      !authorized(url.searchParams.get("token") || "") ||
      !trustedOrigin(req.headers.origin, req.headers.host)
    ) {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }
    const channel = url.pathname.split("/")[2];
    if (!["state", "youtube", "mirror", "broadcast"].includes(channel)) {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => {
      ws.on("pong", () => {
        (ws as any).alive = true;
      });
      if (channel === "broadcast") {
        broadcaster?.close(4001, "Another broadcast connected.");
        broadcaster = ws;
        mirrorConfig = null;
        store.patch(
          {
            mirror: {
              connected: true,
              device: "Apple device",
              format: store.state.mirror.format,
              lastFrame: 0,
              audio: false,
            },
          },
          false,
        );
        configureMirror();
        ws.on("message", (data, binary) => {
          if (broadcaster !== ws) return;
          if (!binary) {
            try {
              const message = JSON.parse(data.toString());
              if (message.type === "hello")
                store.patch(
                  {
                    mirror: {
                      ...store.state.mirror,
                      device: String(message.device || "Apple device").slice(
                        0,
                        80,
                      ),
                    },
                  },
                  false,
                );
              if (
                message.type === "codec" &&
                typeof message.codec === "string" &&
                /^avc1\.[\da-f]{6}$/i.test(message.codec)
              ) {
                mirrorConfig = JSON.stringify({
                  type: "codec",
                  codec: message.codec,
                });
                forwardMediaChunk(channels.mirror, mirrorConfig);
              }
            } catch {
              ws.close(1003, "Invalid broadcast message.");
            }
            return;
          }
          const buffer = Buffer.from(data as Buffer);
          const kind = validateMirrorPacket(buffer);
          if (!kind) return;
          if (
            Date.now() - store.state.mirror.lastFrame > 1000 ||
            (kind === "pcm" && !store.state.mirror.audio)
          )
            store.patch(
              {
                mirror: {
                  ...store.state.mirror,
                  lastFrame: Date.now(),
                  audio: store.state.mirror.audio || kind === "pcm",
                },
              },
              false,
            );
          forwardMediaChunk(channels.mirror, buffer);
        });
        ws.on("close", () => {
          if (broadcaster === ws) {
            broadcaster = null;
            mirrorConfig = null;
            store.patch(
              {
                mirror: {
                  ...store.state.mirror,
                  connected: false,
                  audio: false,
                },
              },
              false,
            );
          }
        });
      } else {
        const set = channels[channel as keyof typeof channels];
        set.add(ws);
        ws.on("close", () => set.delete(ws));
        if (channel === "state") ws.send(JSON.stringify(store.snapshot()));
        if (channel === "mirror") {
          let lastKeyframeRequest = 0;
          if (mirrorConfig) ws.send(mirrorConfig);
          ws.on("message", (data) => {
            try {
              const msg = JSON.parse(data.toString());
              if (
                msg.type === "keyframe" &&
                Date.now() - lastKeyframeRequest > 250
              ) {
                lastKeyframeRequest = Date.now();
                if (broadcaster?.readyState === WebSocket.OPEN)
                  broadcaster.send(JSON.stringify({ type: "keyframe" }));
              }
              if (
                msg.type === "format" &&
                ["jpeg", "h264"].includes(msg.format)
              ) {
                store.patch(
                  { mirror: { ...store.state.mirror, format: msg.format } },
                  false,
                );
                configureMirror();
              }
            } catch {}
          });
          broadcaster?.send(JSON.stringify({ type: "keyframe" }));
        }
      }
      ws.on("error", () => {});
    });
  });
  const heartbeat = setInterval(() => {
    for (const client of sockets.clients) {
      if ((client as any).alive === false) {
        client.terminate();
        continue;
      }
      (client as any).alive = false;
      client.ping();
    }
  }, 15000);
  heartbeat.unref();
  const dist = resolve("dist");
  if (existsSync(dist)) {
    app.use(express.static(dist, { index: "index.html" }));
    app.get("/", (_req, res) => res.sendFile(join(dist, "index.html")));
  }
  const close = async () => {
    clearInterval(heartbeat);
    const checkpoint = store.snapshot();
    checkpoint.position = media.position();
    media.close();
    await casting.stop();
    // Receiver teardown resets its player. Preserve the owner's checkpoint
    // rather than persisting that transport-level reset as a user stop.
    store.patch({
      current: checkpoint.current,
      queue: checkpoint.queue,
      position: checkpoint.position,
      duration: checkpoint.duration,
      volume: checkpoint.volume,
      muted: checkpoint.muted,
      mode: checkpoint.mode,
      status: checkpoint.current ? "paused" : "idle",
    });
    for (const ws of sockets.clients) ws.terminate();
    await new Promise<void>((r) =>
      server.listening ? server.close(() => r()) : r(),
    );
  };
  return { app, server, store, media, casting, close, token: secret };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const relay = createRelay();
  const port = Number(process.env.PORT || 8787),
    host = process.env.HOST || "127.0.0.1";
  relay.server.listen(port, host, () =>
    console.log(
      `SI-DEMON-TV relay http://${host}:${port}\nOpen the dashboard locally to get your connection key. Run npm run doctor for setup checks.`,
    ),
  );
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, () => {
      void relay.close().then(() => process.exit());
    });
}
