import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import type { Capabilities, Command, State, VideoItem } from "../shared/types";
import {
  Connection,
  defaultConnection,
  type ConnectionSettings,
} from "./connection";
import { MirrorPlayer, probe, BufferedLivePlayback } from "./player";
import { Icon } from "./icons";
import { youtubeBufferSeconds } from "../shared/playback";

const initial: State = {
  queue: [],
  current: null,
  status: "idle",
  position: 0,
  duration: 0,
  volume: 0.7,
  muted: false,
  screen: "youtube",
  mode: "latency",
  error: null,
  revision: 0,
  stream: 0,
  mirror: {
    connected: false,
    device: null,
    format: "jpeg",
    lastFrame: 0,
    audio: false,
  },
  casting: { status: "off", code: null, senders: [], error: null },
};
const time = (seconds: number) => {
  const n = Math.floor(Math.max(0, seconds));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
};
const loadSaved = (): VideoItem[] => {
  try {
    const data = JSON.parse(localStorage.getItem("demon.saved") || "[]");
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
};
function Button({
  icon,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon?: string }) {
  return (
    <button {...props}>
      {icon && <Icon name={icon} />} {children}
    </button>
  );
}

export function App() {
  const [settings, setSettings] = useState(defaultConnection);
  const [state, setState] = useState<State>(initial);
  const [status, setStatus] = useState<"connecting" | "online" | "offline">(
    "connecting",
  );
  const [connectionError, setConnectionError] = useState("");
  const [modal, setModal] = useState<"connection" | "cast" | "mirror" | null>(
    null,
  );
  const [section, setSection] = useState<"youtube" | "mirror" | "diagnostics">(
    "youtube",
  );
  const [toast, setToast] = useState("");
  const [saved, setSaved] = useState(loadSaved);
  const [tab, setTab] = useState<"queue" | "saved">("queue");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<VideoItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [frames, setFrames] = useState(0);
  const [youtubeReconnect, setYoutubeReconnect] = useState(0);
  const [sound, setSound] = useState(false);
  const player = useRef<any>(null),
    mirror = useRef<MirrorPlayer | null>(null),
    canvas = useRef<HTMLCanvasElement>(null),
    display = useRef<HTMLDivElement>(null);
  const connection = useRef<Connection | null>(null);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [diagnostics, setDiagnostics] = useState<any>(null);
  const [clock, setClock] = useState(new Date());

  useEffect(() => {
    const c = new Connection({ ...settings }, setState, (s, error) => {
      setStatus(s);
      setConnectionError(error || "");
      if (s === "online" && c.settings.token !== settings.token)
        setSettings({ ...c.settings });
    });
    connection.current = c;
    void c.connect();
    return () => c.close();
  }, [settings]);
  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 30000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 6000);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    localStorage.setItem("demon.saved", JSON.stringify(saved));
  }, [saved]);
  const command = useCallback(
    async (action: Command) => {
      try {
        if (!connection.current || status !== "online")
          throw new Error("Connect the relay first.");
        await connection.current.command(action);
      } catch (error) {
        setToast((error as Error).message);
      }
    },
    [status],
  );
  const select = (screen: "youtube" | "mirror") => {
    setSection(screen);
    if (status === "online") void command({ type: "screen", screen });
  };
  useEffect(() => {
    if (
      status !== "online" ||
      !canvas.current ||
      !connection.current ||
      section === "diagnostics"
    )
      return;
    setFrames(0);
    setSound(false);
    if (section === "mirror") {
      const m = new MirrorPlayer(
        canvas.current,
        connection.current,
        state.mode,
        setFrames,
        setToast,
      );
      mirror.current = m;
      void m.start();
      return () => {
        m.destroy();
        mirror.current = null;
      };
    }
    if (!state.current || !state.stream) return;
    let disposed = false;
    const start = async () => {
      if (!(window as any).JSMpeg)
        await new Promise<void>((resolve, reject) => {
          const script = document.createElement("script");
          script.src = `${import.meta.env.BASE_URL}vendor/jsmpeg.min.js`;
          script.onload = () => resolve();
          script.onerror = () =>
            reject(
              new Error("The video decoder could not load. Reload the page."),
            );
          document.head.appendChild(script);
        });
      if (disposed || !canvas.current) return;
      let count = 0;
      let established = false;
      const p = (player.current = new (window as any).JSMpeg.Player(
        connection.current!.ws("/ws/youtube"),
        {
          canvas: canvas.current,
          autoplay: true,
          audio: true,
          video: true,
          streaming: true,
          pauseWhenHidden: false,
          preserveDrawingBuffer: false,
          decodeFirstFrame: false,
          reconnectInterval: 1,
          onSourceEstablished: () => {
            if (established) setYoutubeReconnect((value) => value + 1);
            established = true;
          },
          videoBufferSize: 2 * 1024 * 1024,
          audioBufferSize: 256 * 1024,
          onVideoDecode: () => {
            count++;
            if (count % 10 === 0 || count === 1) setFrames(count);
          },
        },
      ));
      const buffer = youtubeBufferSeconds(
        state.mode,
        state.duration > 0 ? state.duration - state.position : undefined,
      );
      const playback = new BufferedLivePlayback(p, buffer);
      p.updateForStreaming = () => playback.update();
      p.volume = state.muted ? 0 : state.volume;
    };
    void start().catch((error) => setToast(error.message));
    return () => {
      disposed = true;
      player.current?.destroy();
      player.current = null;
    };
  }, [
    status,
    section,
    state.stream,
    state.current?.id,
    settings,
    youtubeReconnect,
  ]);
  useEffect(() => {
    if (player.current) player.current.volume = state.muted ? 0 : state.volume;
    if (mirror.current) {
      mirror.current.setMode(state.mode);
      mirror.current.setVolume(state.muted ? 0 : state.volume);
    }
  }, [state.volume, state.muted, state.mode]);
  useEffect(() => {
    if (section === "youtube" && state.status === "paused")
      player.current?.pause();
  }, [state.status, section]);
  async function enableSound() {
    try {
      if (section === "mirror")
        await mirror.current?.unlockAudio(state.muted ? 0 : state.volume);
      else {
        const output = player.current?.audioOut;
        if (!output) throw new Error("Start a video before enabling sound.");
        await output.context?.resume();
        if (output.unlock) output.unlock(() => {});
      }
      setSound(true);
    } catch (error) {
      setToast((error as Error).message);
    }
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!query.trim()) return;
    if (status !== "online") {
      setModal("connection");
      return;
    }
    setSearching(true);
    try {
      if (
        /^https?:\/\//.test(query.trim()) ||
        /^[\w-]{11}$/.test(query.trim())
      ) {
        await connection.current!.command({
          type: "enqueue",
          id: query.trim(),
        });
        setToast("Added to queue.");
        setQuery("");
        setTab("queue");
      } else
        setResults(
          await connection.current!.request<VideoItem[]>(
            `/api/search?q=${encodeURIComponent(query.trim())}`,
          ),
        );
    } catch (error) {
      setToast((error as Error).message);
    } finally {
      setSearching(false);
    }
  }
  async function pair() {
    setModal("cast");
    if (status === "online") {
      setBusy(true);
      await command({ type: "cast-start" });
      setBusy(false);
    }
  }
  async function inspect() {
    setSection("diagnostics");
    const report = await probe();
    setCapabilities(report);
    if (status === "online") {
      try {
        setDiagnostics(await connection.current!.request("/api/diagnostics"));
        await connection.current!.request("/api/probe", report);
      } catch (error) {
        setToast((error as Error).message);
      }
    }
  }
  const toggleSave = (item: VideoItem) =>
    setSaved((list) =>
      list.some((v) => v.id === item.id)
        ? list.filter((v) => v.id !== item.id)
        : [item, ...list].slice(0, 100),
    );
  const videoActions = (item: VideoItem, inQueue = false) => (
    <div className="item-actions">
      <Button
        className={inQueue ? "icon-button" : "result-play"}
        title="Play now"
        aria-label={`Play ${item.title}`}
        icon="play"
        onClick={() => void command({ type: "play", id: item.id })}
      >
        {!inQueue && "Play"}
      </Button>
      {!inQueue && (
        <Button
          className="icon-button"
          title="Add to queue"
          aria-label={`Queue ${item.title}`}
          icon="plus"
          onClick={() => void command({ type: "enqueue", id: item.id })}
        />
      )}
      <Button
        className={`icon-button ${saved.some((v) => v.id === item.id) ? "selected" : ""}`}
        title="Save video"
        aria-label={`Save ${item.title}`}
        icon="heart"
        onClick={() => toggleSave(item)}
      />
      {inQueue && (
        <>
          <Button
            className="icon-button small"
            aria-label={`Move ${item.title} up`}
            icon="arrow"
            onClick={() =>
              void command({ type: "move", id: item.id, direction: -1 })
            }
          />
          <Button
            className="icon-button small"
            aria-label={`Move ${item.title} down`}
            icon="arrow"
            style={{ transform: "rotate(180deg)" }}
            onClick={() =>
              void command({ type: "move", id: item.id, direction: 1 })
            }
          />
          <Button
            className="icon-button small"
            aria-label={`Remove ${item.title}`}
            icon="close"
            onClick={() => void command({ type: "remove", id: item.id })}
          />
        </>
      )}
    </div>
  );
  const isPlaying = state.status === "playing" || state.status === "loading";
  const hasVideo = !!state.current || state.queue.length > 0;
  const showPicture =
    frames > 0 && (section !== "mirror" || state.mirror.connected);
  const fullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await display.current?.requestFullscreen();
    } catch {
      setToast("Fullscreen is unavailable in this browser.");
    }
  };

  return (
    <div className="app-shell">
      <aside className="rail">
        <img
          src={`${import.meta.env.BASE_URL}demon-tesla-logo-v1.png`}
          className="brand-icon"
          alt="SI-DEMON-TV demon Tesla"
        />
        <nav aria-label="Main navigation">
          <Button
            className={`nav-button ${section === "youtube" ? "active" : ""}`}
            icon="youtube"
            onClick={() => select("youtube")}
          >
            YouTube
          </Button>
          <Button
            className={`nav-button ${section === "mirror" ? "active" : ""}`}
            icon="mirror"
            onClick={() => select("mirror")}
          >
            Mirror
          </Button>
        </nav>
        <div className="rail-bottom">
          <Button
            className={`nav-button ${section === "diagnostics" ? "active" : ""}`}
            icon="diagnose"
            onClick={() => void inspect()}
          >
            Screen check
          </Button>
          <Button
            className="nav-button"
            icon="gear"
            onClick={() => setModal("connection")}
          >
            Connection
          </Button>
        </div>
      </aside>
      <main>
        <header className="app-header">
          <div className="wordmark">
            SI-DEMON<span>TV</span>
          </div>
          <div className="header-right">
            <button
              className={`connection-pill ${status}`}
              onClick={() => setModal("connection")}
            >
              <i />
              {status === "online"
                ? "Relay connected"
                : status === "connecting"
                  ? "Connecting"
                  : "Connect relay"}
            </button>
            <time>
              {clock.toLocaleTimeString([], {
                hour: "numeric",
                minute: "2-digit",
              })}
            </time>
          </div>
        </header>
        {section === "diagnostics" ? (
          <section className="diagnostics">
            <div className="section-heading">
              <div>
                <h1>Screen check</h1>
              </div>
              <Button
                className="secondary"
                icon="diagnose"
                onClick={() => void inspect()}
              >
                Run again
              </Button>
            </div>
            <div className="capability-grid">
              {capabilities &&
                Object.entries(capabilities)
                  .filter(([key]) => key !== "userAgent")
                  .map(([key, value]) => (
                    <div className="capability" key={key}>
                      <Icon name={value ? "check" : "close"} />
                      <span>
                        {{
                          secure: "Secure connection",
                          canvas: "Canvas playback",
                          webgl: "WebGL rendering",
                          webcodecs: "Video decoder",
                          h264: "H.264 support",
                          audio: "Audio output",
                          websocket: "Live connection",
                        }[key] || key}
                      </span>
                      <strong>{value ? "Available" : "Unavailable"}</strong>
                    </div>
                  ))}
            </div>
            <div className="diagnostic-panel">
              <h2>Relay tools</h2>
              {diagnostics?.tools?.map((tool: any) => (
                <p key={tool.name}>
                  <span className={tool.available ? "good" : "bad"}>
                    {tool.available ? "✓" : "×"}
                  </span>{" "}
                  <strong>{tool.name}</strong> <span>{tool.version}</span>
                </p>
              )) || <p>Connect the relay to check its playback tools.</p>}
            </div>
            <div className="diagnostic-panel acceptance">
              <h2>Playback test</h2>
              <p>
                Confirm picture and sound on the Tesla, then test mirroring and
                phone queuing.
              </p>
              <Button
                className="primary"
                icon="play"
                onClick={() => {
                  select("youtube");
                  void command({ type: "test" });
                }}
              >
                Play screen + sound check
              </Button>
            </div>
            <p className="browser-info">{capabilities?.userAgent}</p>
          </section>
        ) : (
          <>
            <div className="section-heading">
              <div>
                <h1>{section === "youtube" ? "YouTube" : "Mirror"}</h1>
              </div>
              <div className="heading-actions">
                {section === "youtube" ? (
                  <Button
                    className="secondary"
                    icon="cast"
                    onClick={() => void pair()}
                  >
                    Pair YouTube app
                  </Button>
                ) : (
                  <Button
                    className="secondary"
                    icon="link"
                    onClick={() => setModal("mirror")}
                  >
                    Connect device
                  </Button>
                )}
              </div>
            </div>
            <div className="workspace">
              <section className="watch-area">
                <div className="display" ref={display}>
                  <canvas
                    key={section}
                    ref={canvas}
                    aria-label={
                      section === "mirror"
                        ? "Mirrored Apple device screen"
                        : "YouTube video canvas"
                    }
                    className={showPicture ? "visible" : ""}
                  />
                  {!showPicture && (
                    <div className="display-empty">
                      <div className="display-orbit">
                        <Icon
                          name={section === "mirror" ? "mirror" : "play"}
                          size={48}
                        />
                      </div>
                      <h2>
                        {section === "mirror"
                          ? state.mirror.connected
                            ? "Waiting for broadcast…"
                            : "No device connected"
                          : state.status === "loading"
                            ? "Loading…"
                            : state.status === "error"
                              ? "Playback failed"
                              : state.current
                                ? state.status === "paused"
                                  ? "Paused"
                                  : "Connecting…"
                                : state.queue.length
                                  ? "Queue ready"
                                  : "No video selected"}
                      </h2>
                      {(section === "mirror" || !hasVideo) && (
                        <p>
                          {section === "mirror"
                            ? "Start a broadcast from SI-DEMON-TV on your iPhone or iPad."
                            : "Search, paste a link, or pair the YouTube app."}
                        </p>
                      )}
                      <Button
                        className="display-action"
                        icon={
                          section === "mirror"
                            ? "link"
                            : hasVideo
                              ? "play"
                              : "cast"
                        }
                        disabled={
                          section === "youtube" && state.status === "loading"
                        }
                        onClick={() => {
                          if (section === "mirror") setModal("mirror");
                          else if (hasVideo)
                            void command({
                              type: "play",
                              id: state.current?.id,
                            });
                          else void pair();
                        }}
                      >
                        {section === "mirror"
                          ? "Connect iPhone / iPad"
                          : hasVideo
                            ? "Play video"
                            : "Pair YouTube app"}
                      </Button>
                    </div>
                  )}
                  {state.status === "loading" && section === "youtube" && (
                    <div className="loading-bar" />
                  )}
                  <div className="display-top">
                    {section === "mirror" && state.mirror.connected && (
                      <span className="display-badge">
                        <i className="good-dot" />
                        {state.mirror.device || "Connected"}
                      </span>
                    )}
                    <Button
                      className="glass icon-button"
                      aria-label="Toggle fullscreen"
                      icon="full"
                      onClick={() => void fullscreen()}
                    />
                  </div>
                  {showPicture && !sound && (
                    <Button
                      className="sound-unlock"
                      icon="sound"
                      onClick={() => void enableSound()}
                    >
                      Enable sound
                    </Button>
                  )}
                </div>
                <div className="transport">
                  {section === "youtube" ? (
                    <>
                      <Button
                        className="play-button"
                        aria-label={isPlaying ? "Pause" : "Play"}
                        icon={isPlaying ? "pause" : "play"}
                        onClick={() =>
                          void command(
                            isPlaying
                              ? { type: "pause" }
                              : state.current
                                ? { type: "resume" }
                                : { type: "play" },
                          )
                        }
                      />
                      <Button
                        className="icon-button"
                        aria-label="Next video"
                        icon="next"
                        onClick={() => void command({ type: "next" })}
                      />
                      <div className="timeline">
                        <input
                          aria-label="Playback position"
                          type="range"
                          min="0"
                          max={state.duration || 1}
                          step="1"
                          value={Math.min(state.position, state.duration || 1)}
                          onChange={(e) =>
                            setState((s) => ({
                              ...s,
                              position: Number(e.target.value),
                            }))
                          }
                          onPointerUp={(e) =>
                            void command({
                              type: "seek",
                              position: Number(e.currentTarget.value),
                            })
                          }
                          onKeyUp={(e) =>
                            void command({
                              type: "seek",
                              position: Number(e.currentTarget.value),
                            })
                          }
                        />
                        <span>
                          {time(state.position)}{" "}
                          <em>/ {time(state.duration)}</em>
                        </span>
                      </div>
                    </>
                  ) : (
                    <div className="mirror-live">
                      <i className={state.mirror.connected ? "good-dot" : ""} />
                      {state.mirror.connected
                        ? "Broadcast connected"
                        : "No device connected"}
                      <small>
                        {frames
                          ? `${frames.toLocaleString()} frames received`
                          : "No frames received"}
                      </small>
                    </div>
                  )}
                  <Button
                    className="icon-button"
                    aria-label={state.muted ? "Unmute" : "Mute"}
                    icon={state.muted ? "mute" : "sound"}
                    onClick={() =>
                      void command({
                        type: "volume",
                        volume: state.volume,
                        muted: !state.muted,
                      })
                    }
                  />
                  <input
                    className="volume"
                    aria-label="Volume"
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={state.volume}
                    onChange={(e) =>
                      void command({
                        type: "volume",
                        volume: Number(e.target.value),
                      })
                    }
                  />
                </div>
                {state.error && section === "youtube" && (
                  <div className="inline-error" role="alert">
                    {state.error}
                  </div>
                )}
                <div className="now-playing">
                  <div>
                    <span>
                      {section === "mirror"
                        ? "Screen mirroring"
                        : state.current
                          ? "Now playing"
                          : "Ready to play"}
                    </span>
                    <h2>
                      {section === "mirror"
                        ? state.mirror.device || "iPhone + iPad"
                        : state.current?.title || "No video selected"}
                    </h2>
                    {section === "youtube" && state.current?.author && (
                      <p>{state.current.author}</p>
                    )}
                  </div>
                  <div
                    className="mode-switch"
                    role="group"
                    aria-label="Playback mode"
                  >
                    <button
                      className={state.mode === "latency" ? "active" : ""}
                      onClick={() =>
                        void command({ type: "mode", mode: "latency" })
                      }
                    >
                      <Icon name="bolt" size={17} />
                      Low latency
                    </button>
                    <button
                      className={state.mode === "quality" ? "active" : ""}
                      onClick={() =>
                        void command({ type: "mode", mode: "quality" })
                      }
                    >
                      <Icon name="screen" size={17} />
                      Quality
                    </button>
                  </div>
                </div>
                {section === "youtube" ? (
                  <>
                    <form className="search-bar" onSubmit={submit}>
                      <Icon name="search" />
                      <input
                        aria-label="Search YouTube or paste a link"
                        placeholder="Search YouTube or paste a video link"
                        value={query}
                        maxLength={200}
                        onChange={(e) => setQuery(e.target.value)}
                      />
                      <button className="primary" disabled={searching}>
                        {searching ? "Searching…" : "Search"}
                      </button>
                    </form>
                    {results.length > 0 && (
                      <section className="search-results">
                        <div className="results-title">
                          <h2>Search results</h2>
                          <Button
                            className="icon-button"
                            aria-label="Clear results"
                            icon="close"
                            onClick={() => setResults([])}
                          />
                        </div>
                        {results.map((item) => (
                          <div className="result-item" key={item.id}>
                            <img src={item.thumbnail} alt="" loading="lazy" />
                            <div>
                              <h3>{item.title}</h3>
                              <p>
                                {item.author} <span>{time(item.duration)}</span>
                              </p>
                            </div>
                            {videoActions(item)}
                          </div>
                        ))}
                      </section>
                    )}
                  </>
                ) : null}
              </section>
              <aside className="queue-panel">
                {section === "youtube" ? (
                  <>
                    <div className="queue-tabs">
                      <button
                        className={tab === "queue" ? "active" : ""}
                        onClick={() => setTab("queue")}
                      >
                        Up next <span>{state.queue.length}</span>
                      </button>
                      <button
                        className={tab === "saved" ? "active" : ""}
                        onClick={() => setTab("saved")}
                      >
                        Saved <Icon name="heart" size={16} />
                      </button>
                    </div>
                    <div className="queue-list">
                      {(tab === "queue" ? state.queue : saved).length ? (
                        (tab === "queue" ? state.queue : saved).map(
                          (item, index) => (
                            <article className="queue-item" key={item.id}>
                              <div className="queue-thumb">
                                <img
                                  src={item.thumbnail}
                                  alt=""
                                  loading="lazy"
                                />
                                <span>{time(item.duration)}</span>
                              </div>
                              <div className="queue-text">
                                <span>
                                  {String(index + 1).padStart(2, "0")}
                                </span>
                                <h3>{item.title}</h3>
                                <p>{item.author}</p>
                              </div>
                              {videoActions(item, tab === "queue")}
                            </article>
                          ),
                        )
                      ) : (
                        <div className="queue-empty">
                          <Icon
                            name={tab === "queue" ? "next" : "heart"}
                            size={32}
                          />
                          <h3>
                            {tab === "queue"
                              ? "Queue empty"
                              : "No saved videos"}
                          </h3>
                          <p>
                            {tab === "queue"
                              ? "Add videos here or queue them from the YouTube app on your phone."
                              : "Tap the heart on a video to save it on this screen."}
                          </p>
                        </div>
                      )}
                    </div>
                    {state.casting.senders.length > 0 && (
                      <div className="queue-footer">
                        <Icon name="cast" size={18} />
                        <span>{state.casting.senders.join(", ")}</span>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="mirror-steps">
                    <div className="device-sketch">
                      <div />
                      <div />
                    </div>
                    <h2>Device setup</h2>
                    <ol>
                      <li>Open SI-DEMON-TV on your iPhone or iPad.</li>
                      <li>Connect it to this relay.</li>
                      <li>Tap Start broadcast.</li>
                    </ol>
                    <Button
                      className="primary"
                      icon="link"
                      onClick={() => setModal("mirror")}
                    >
                      Device setup
                    </Button>
                  </div>
                )}
              </aside>
            </div>
          </>
        )}
      </main>
      {toast && (
        <div className="toast" role="status">
          {toast}
          <Button
            className="icon-button"
            aria-label="Dismiss message"
            icon="close"
            onClick={() => setToast("")}
          />
        </div>
      )}
      {modal && (
        <Modal
          title={
            modal === "connection"
              ? "Connection"
              : modal === "cast"
                ? "Pair YouTube app"
                : "Connect device"
          }
          onClose={() => setModal(null)}
        >
          {modal === "connection" ? (
            <ConnectionForm
              settings={connection.current?.settings || settings}
              error={connectionError}
              status={status}
              save={(value) => {
                setSettings(value);
                setModal(null);
              }}
            />
          ) : modal === "cast" ? (
            <>
              <p>
                YouTube → Cast → Link with TV code.
                <br />
                Receiver: <strong>{state.casting.name || "SI-DEMON-TV"}</strong>
              </p>
              <div className="pair-code">
                {state.casting.code
                  ? state.casting.code.match(/.{1,3}/g)?.join(" ")
                  : busy || state.casting.status === "starting"
                    ? "Getting code…"
                    : status !== "online"
                      ? "Connect relay first"
                      : "Waiting for YouTube…"}
              </div>
              {state.casting.error && (
                <p className="bad">{state.casting.error}</p>
              )}
              <div className="modal-actions">
                <Button
                  className="primary"
                  icon="cast"
                  disabled={busy || status !== "online"}
                  onClick={() => void pair()}
                >
                  Get TV code
                </Button>
                <Button
                  className="secondary"
                  onClick={() => void command({ type: "cast-stop" })}
                >
                  Disconnect phones
                </Button>
              </div>
              <p className="quiet">
                Paired: {state.casting.senders.join(", ") || "No phones yet"}
              </p>
            </>
          ) : (
            <DeviceSetup
              connection={connection.current?.settings || settings}
            />
          )}
        </Modal>
      )}
    </div>
  );
}
function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === dialog.current) onClose();
      }}
    >
      <div className="modal-header">
        <h2>{title}</h2>
        <Button
          className="icon-button"
          aria-label="Close dialog"
          icon="close"
          onClick={onClose}
        />
      </div>
      {children}
    </dialog>
  );
}
function ConnectionForm({
  settings,
  save,
  error,
  status,
}: {
  settings: ConnectionSettings;
  save: (s: ConnectionSettings) => void;
  error: string;
  status: string;
}) {
  const [url, setURL] = useState(settings.url),
    [token, setToken] = useState(settings.token);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  return (
    <form
      className="connection-form"
      onSubmit={(e) => {
        e.preventDefault();
        save({ url: url.trim().replace(/\/$/, ""), token: token.trim() });
      }}
    >
      <label>
        Relay address
        <input
          type="url"
          required
          placeholder="https://your-relay.example"
          value={url}
          onChange={(e) => setURL(e.target.value)}
        />
      </label>
      <label>
        Connection key or pairing phrase
        <input
          type="password"
          autoComplete="off"
          placeholder="Key or pairing phrase"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
      </label>
      <Button
        type="button"
        className="secondary"
        disabled={!token}
        onClick={() => {
          void navigator.clipboard
            .writeText(token)
            .then(() => {
              setCopied(true);
              setCopyError("");
            })
            .catch(() => setCopyError("Could not copy the key."));
        }}
      >
        {copied ? "Copied" : "Copy key"}
      </Button>
      {copyError && <p className="bad">{copyError}</p>}
      {error && status !== "online" && <p className="bad">{error}</p>}
      <button className="primary">Connect</button>
      <p className="quiet">
        Open the relay on your Mac to obtain its key. The Tesla and Apple device
        must be able to reach the same relay address.
      </p>
    </form>
  );
}
function DeviceSetup({ connection }: { connection: ConnectionSettings }) {
  const [qr, setQR] = useState("");
  const link = `sidemon://connect?url=${encodeURIComponent(connection.url)}&key=${encodeURIComponent(connection.token)}`;
  useEffect(() => {
    void QRCode.toDataURL(link, {
      width: 240,
      margin: 2,
      color: { dark: "#151618", light: "#ffffff" },
    }).then(setQR);
  }, [link]);
  return (
    <>
      <p>
        Install the included SI-DEMON-TV iPhone/iPad app, then scan this code
        with the device’s camera to connect.
      </p>
      {qr && (
        <img
          className="device-qr"
          src={qr}
          alt="Private device connection QR code"
        />
      )}
      <p className="quiet">
        The QR includes the connection key. Use a relay address the device can
        reach; localhost only works on the Mac.
      </p>
      <details>
        <summary>Enter settings manually</summary>
        <p>Relay: {connection.url}</p>
        <p>
          The connection key is available in Connection. In the app, save these
          settings, tap Start broadcast, then open your game or app.
        </p>
      </details>
    </>
  );
}
