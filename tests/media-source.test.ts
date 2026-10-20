import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Media } from "../server/media";
import { Store } from "../server/core";

it("refreshes a rejected signed source once and reuses its valid URL when resuming", async () => {
  const directory = mkdtempSync(join(tmpdir(), "demon-source-"));
  const clip = join(directory, "synthetic.mp4");
  const generated = spawnSync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=30",
    "-t",
    "4",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    clip,
  ]);
  expect(generated.status).toBe(0);
  const bytes = readFileSync(clip);
  let rejected = 0,
    resolutions = 0,
    headersReceived = 0;
  const upstream = createServer((request, response) => {
    if (request.headers["user-agent"] === "SI-DEMON synthetic source")
      headersReceived++;
    if (request.url?.includes("version=1")) {
      rejected++;
      response.writeHead(403);
      response.end();
      return;
    }
    const range = /bytes=(\d+)-(\d*)/.exec(request.headers.range || "");
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2]
      ? Math.min(Number(range[2]), bytes.length - 1)
      : bytes.length - 1;
    response.writeHead(range ? 206 : 200, {
      "Content-Type": "video/mp4",
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      ...(range
        ? { "Content-Range": `bytes ${start}-${end}/${bytes.length}` }
        : {}),
    });
    response.end(bytes.subarray(start, end + 1));
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const port = (upstream.address() as { port: number }).port;
  const store = new Store();
  store.patch({ mode: "quality" });
  const media = new Media(store, async () => [
    {
      url: `http://127.0.0.1:${port}/clip.mp4?version=${++resolutions}`,
      headers: { "User-Agent": "SI-DEMON synthetic source" },
    },
  ]);
  const item = {
    id: "aqz-KE-bpKQ",
    title: "Synthetic HTTP source",
    author: "",
    thumbnail: "",
    duration: 4,
    source: "youtube" as const,
  };
  const nextChunk = () =>
    new Promise<Buffer>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("No transcoded packet arrived")),
        8000,
      );
      media.once("chunk", (data) => {
        clearTimeout(timeout);
        resolve(data);
      });
    });
  try {
    const first = nextChunk();
    await media.play(item);
    expect((await first)[0]).toBe(0x47);
    expect(rejected).toBeGreaterThan(0);
    expect(resolutions).toBe(2);
    media.pause();
    const resumed = nextChunk();
    await media.seek(0.5);
    expect((await resumed)[0]).toBe(0x47);
    expect(resolutions).toBe(2);
    expect(headersReceived).toBeGreaterThan(0);
    expect(store.state.status).toBe("playing");
    expect(media.position()).toBeCloseTo(0.5, 1);
    let ended = false;
    media.onEnded = () => {
      ended = true;
    };
    await new Promise<void>((resolve) =>
      media.child!.once("close", () => resolve()),
    );
    expect(ended).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(store.state.status).toBe("playing");
    expect(ended).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 1450));
    expect(ended).toBe(true);
    expect(store.state.status).toBe("paused");
    expect(store.state.position).toBeLessThanOrEqual(item.duration);
  } finally {
    media.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    rmSync(directory, { recursive: true });
  }
});
