# SI-DEMON-TV protocol

All authenticated HTTP requests use `Authorization: Bearer <key>`. WebSockets pass the same key as a URL parameter; keep proxy access logs private or redact query strings. Allowlisted browser origins are checked independently of credentials. A single Apple broadcaster feeds the personal front session; a new broadcaster replaces the old one.

## Endpoints

- `GET /api/health`: public readiness only.
- `GET /api/bootstrap`: key available only from a loopback peer with a localhost Host header.
- `GET /api/state`: state snapshot.
- `GET /api/search?q=`: up to eight YouTube results.
- `POST /api/command`: play/pause/resume/stop/seek/next/volume, queue edits, mode, screen, test and cast start/stop.
- `GET /api/diagnostics`: tool availability and relay state.
- `POST /api/probe`: save bounded browser-capability report locally.
- `/ws/state`: JSON state snapshots.
- `/ws/youtube`: binary MPEG-TS, MPEG1 picture and MP2 audio. No HTML video element.
- `/ws/mirror`: Apple capture messages to viewers; clients may request JPEG/H.264 format.
- `/ws/broadcast`: Apple producer; initial JSON `hello` with device name. Receives `configure` and `keyframe` commands.

## Apple binary packets (little endian)

| Type | Header                                                                 | Payload                                     |
| ---- | ---------------------------------------------------------------------- | ------------------------------------------- |
| 1    | type u8, producer timestamp f64 milliseconds                           | JPEG bytes                                  |
| 2    | type u8, sample rate u32, sample count u32, timestamp f64 milliseconds | mono float32 PCM, exactly `count * 4` bytes |
| 4    | type u8, keyframe flag u8, timestamp f64 milliseconds                  | Annex-B H.264 access unit                   |

Before H.264 keyframes the producer sends JSON `{ "type": "codec", "codec": "avc1.42E01E" }` using the actual SPS profile/level. Codec JSON is retained for new viewers. Repeated identical codec messages do not reset the browser decoder. JPEG packets must have JPEG SOI; PCM lengths/rates are checked; payloads are bounded at 4 MiB. Compressed frames and PCM stay ordered through temporary congestion; viewer sockets queued beyond 2 MiB reconnect rather than silently dropping reference frames. Viewers may send `{ "type": "keyframe" }`, rate-limited to one request per 250 ms, to recover from sustained decode overload. Clients fall back to JPEG when H.264 is unavailable. No captured screen/audio is written to disk by the relay.

Audio is explicitly unlocked by a user gesture. Picture and audio use one producer timestamp clock. Low latency targets 60 ms with bounded catch-up toward fresh frames; Quality targets 650 ms to absorb packet bursts. These are buffering targets, **not measured end-to-end latency guarantees**. H.264 references decode in order with bounded decoder work, while decoded images present once per browser paint and release superseded frames. PCM packets schedule continuously from capture timestamps, without clearing ordinary bursts at a 300 ms audio threshold. iOS packets use sample presentation timestamps, a bounded latest-capture slot, reusable pixel buffers, and peak-rate limits while retaining the selected resolution, 30 fps cap, and average bitrate.
