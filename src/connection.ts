import type { Command, State } from "../shared/types";
export interface ConnectionSettings {
  url: string;
  token: string;
}
class RelayRequestError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export const defaultConnection = (): ConnectionSettings => {
  try {
    const data = JSON.parse(localStorage.getItem("demon.connection") || "{}");
    return {
      url: data.url || import.meta.env.VITE_RELAY_URL || location.origin,
      token: data.token || "",
    };
  } catch {
    return {
      url: import.meta.env.VITE_RELAY_URL || location.origin,
      token: "",
    };
  }
};
export class Connection {
  socket: WebSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  constructor(
    public settings: ConnectionSettings,
    private onState: (state: State) => void,
    private onConnection: (
      status: "connecting" | "online" | "offline",
      error?: string,
    ) => void,
  ) {}
  url(path: string) {
    return this.settings.url.replace(/\/$/, "") + path;
  }
  ws(path: string) {
    const url = new URL(this.url(path));
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("token", this.settings.token);
    return url.toString();
  }
  async request<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(this.url(path), {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${this.settings.token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    const json = await response.json();
    if (!response.ok)
      throw new RelayRequestError(
        json.error || "The relay could not complete that request.",
        response.status,
      );
    return json;
  }
  command(command: Command) {
    return this.request<State>("/api/command", command);
  }
  async connect() {
    this.closed = false;
    this.onConnection("connecting");
    try {
      const url = new URL(this.settings.url);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error("Enter the relay’s HTTP or HTTPS address.");
      if (location.protocol === "https:" && url.protocol !== "https:")
        throw new Error("This page needs an HTTPS relay address.");
      if (
        !this.settings.token &&
        ["localhost", "127.0.0.1"].includes(url.hostname)
      ) {
        const data = await fetch(this.url("/api/bootstrap")).then((r) =>
          r.json(),
        );
        if (data.token) this.settings.token = data.token;
      }
      let state: State;
      try {
        state = await this.request<State>("/api/state");
      } catch (error) {
        if (
          !(error instanceof RelayRequestError) ||
          error.status !== 401 ||
          !this.settings.token.trim() ||
          this.closed
        )
          throw error;
        const phrase = this.settings.token
          .trim()
          .toLowerCase()
          .replace(/\s+/g, "-");
        const result = await this.request<{ token: string }>("/api/pair", {
          phrase,
        });
        this.settings = { ...this.settings, token: result.token };
        // Save immediately: a one-time phrase cannot be exchanged again after a reload.
        localStorage.setItem("demon.connection", JSON.stringify(this.settings));
        state = await this.request<State>("/api/state");
      }
      if (this.closed) return;
      this.onState(state);
      localStorage.setItem("demon.connection", JSON.stringify(this.settings));
      this.socket = new WebSocket(this.ws("/ws/state"));
      this.socket.onopen = () => this.onConnection("online");
      this.socket.onmessage = (event) => {
        try {
          this.onState(JSON.parse(event.data));
        } catch {}
      };
      this.socket.onerror = () => this.socket?.close();
      this.socket.onclose = () => {
        if (this.closed) return;
        this.onConnection("offline", "Relay connection lost. Reconnecting…");
        this.retry = setTimeout(() => void this.connect(), 3000);
      };
    } catch (error) {
      if (this.closed) return;
      this.onConnection(
        "offline",
        (error as Error).message === "Failed to fetch"
          ? "Relay unavailable. Open Connection and enter its address and key."
          : (error as Error).message,
      );
      this.retry = setTimeout(() => void this.connect(), 5000);
    }
  }
  close() {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    this.socket?.close();
  }
}
