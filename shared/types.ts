export type Mode = "latency" | "quality";
export type Screen = "youtube" | "mirror";
export interface VideoItem {
  id: string;
  title: string;
  author: string;
  thumbnail: string;
  duration: number;
  source: "youtube" | "test";
}
export interface State {
  queue: VideoItem[];
  current: VideoItem | null;
  status: "idle" | "loading" | "playing" | "paused" | "error";
  position: number;
  duration: number;
  volume: number;
  muted: boolean;
  screen: Screen;
  mode: Mode;
  error: string | null;
  revision: number;
  stream: number;
  mirror: {
    connected: boolean;
    device: string | null;
    format: "jpeg" | "h264";
    lastFrame: number;
    audio: boolean;
  };
  casting: {
    name?: string;
    status: "off" | "starting" | "ready" | "error";
    code: string | null;
    senders: string[];
    error: string | null;
  };
}
export type Command =
  | { type: "play"; id?: string }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "stop" }
  | { type: "seek"; position: number }
  | { type: "next" }
  | { type: "volume"; volume: number; muted?: boolean }
  | { type: "enqueue"; id: string }
  | { type: "remove"; id: string }
  | { type: "move"; id: string; direction: -1 | 1 }
  | { type: "screen"; screen: Screen }
  | { type: "mode"; mode: Mode }
  | { type: "test" }
  | { type: "cast-start" }
  | { type: "cast-stop" };
export interface Capabilities {
  secure: boolean;
  canvas: boolean;
  webgl: boolean;
  webcodecs: boolean;
  h264: boolean;
  audio: boolean;
  websocket: boolean;
  userAgent: string;
}
