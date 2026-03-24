import { createHash, randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import express, { type Response as ExpressResponse } from "express";

const DEFAULT_PAIRING_TTL_MS = 10 * 60 * 1000;
const MOBILE_SESSION_KEY = "novaper-mobile-session";

export interface MobileBridgeClient {
  id: string;
  name: string;
  platform: "ios" | "android" | "web";
  paired_at: string;
  created_at: string;
  last_seen_at: string;
  last_message_at: string | null;
  user_agent: string | null;
  status: "online" | "offline";
}

export interface MobileBridgeMessage {
  id: string;
  client_id: string;
  direction: "desktop_to_mobile" | "mobile_to_desktop" | "system";
  body: string;
  created_at: string;
}

interface StoredMobileBridgeClient extends Omit<MobileBridgeClient, "status"> {
  token_hash: string;
}

interface PairingSessionRecord {
  session_id: string;
  bootstrap_token: string;
  setup_code: string;
  pairing_url: string;
  created_at_ms: number;
  expires_at_ms: number;
  consumed_at_ms?: number;
  claimed_client_id?: string;
}

interface PersistedMobileBridgeState {
  clients: StoredMobileBridgeClient[];
  messages: MobileBridgeMessage[];
}

interface MobileBridgeEvent {
  type: "snapshot" | "message" | "presence" | "removed";
  client?: MobileBridgeClient;
  message?: MobileBridgeMessage;
  messages?: MobileBridgeMessage[];
  client_id?: string;
}

export interface MobileBridgeStatus {
  enabled: true;
  public_url: string;
  companion_port: number;
  bind_host: string;
  lan_host: string;
  warning_messages: string[];
  total_clients: number;
  online_clients: number;
  active_pairings: number;
}

export interface MobileBridgePairingSession {
  success: true;
  session_id: string;
  setup_code: string;
  pairing_url: string;
  public_url: string;
  expires_at: number;
  expires_in_seconds: number;
}

type PairingSetupPayload = {
  url: string;
  bootstrapToken: string;
};

function nowIso() {
  return new Date().toISOString();
}

function createOpaqueToken(bytes = 24) {
  return randomBytes(bytes).toString("base64url");
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function escapeHtml(input: string) {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isPrivateIpv4(address: string) {
  return /^10\./.test(address) || /^192\.168\./.test(address) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(address);
}

function pickReachableIpv4(networkInterfaces = os.networkInterfaces) {
  const candidates: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    if (!entries) {
      continue;
    }
    for (const entry of entries) {
      if (!entry || entry.internal || entry.family !== "IPv4") {
        continue;
      }
      candidates.push(entry.address.trim());
    }
  }

  return candidates.find((address) => isPrivateIpv4(address)) ?? candidates[0] ?? null;
}

function normalizePlatform(input: unknown): "ios" | "android" | "web" {
  const value = String(input ?? "").trim().toLowerCase();
  if (value === "ios" || value === "android") {
    return value;
  }
  return "web";
}

function normalizeDeviceName(input: unknown) {
  const value = String(input ?? "").trim();
  return value || "Novaper Mobile";
}

export function encodePairingSetupCode(payload: PairingSetupPayload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodePairingSetupCode(code: string): PairingSetupPayload {
  const parsed = JSON.parse(Buffer.from(code.trim(), "base64url").toString("utf8")) as Partial<PairingSetupPayload>;
  if (!parsed || typeof parsed.url !== "string" || typeof parsed.bootstrapToken !== "string") {
    throw new Error("Invalid setup code.");
  }
  const url = parsed.url.trim();
  const bootstrapToken = parsed.bootstrapToken.trim();
  if (!url || !bootstrapToken) {
    throw new Error("Invalid setup code.");
  }
  return { url, bootstrapToken };
}

export function resolveMobileBridgeNetwork(input: {
  port: number;
  env?: NodeJS.ProcessEnv;
  networkInterfaces?: typeof os.networkInterfaces;
}) {
  const bindHost = input.env?.NOVAPER_MOBILE_HOST?.trim() || "0.0.0.0";
  const explicitPublicUrl = input.env?.NOVAPER_MOBILE_PUBLIC_URL?.trim();
  if (explicitPublicUrl) {
    const parsed = new URL(explicitPublicUrl);
    return {
      bindHost,
      lanHost: parsed.hostname,
      publicUrl: parsed.toString().replace(/\/$/, ""),
      warningMessages: [] as string[],
    };
  }

  const lanHost = pickReachableIpv4(input.networkInterfaces) ?? (bindHost === "0.0.0.0" ? "127.0.0.1" : bindHost);
  const warningMessages =
    lanHost === "127.0.0.1"
      ? ["No LAN IPv4 address was detected. Mobile pairing will only work on this machine until NOVAPER_MOBILE_PUBLIC_URL is configured."]
      : [];

  return {
    bindHost,
    lanHost,
    publicUrl: `http://${lanHost}:${input.port}`,
    warningMessages,
  };
}

export class MobileBridgeStore {
  private readonly statePath: string;
  private readonly clients = new Map<string, StoredMobileBridgeClient>();
  private readonly messages = new Map<string, MobileBridgeMessage[]>();
  private readonly pairingSessions = new Map<string, PairingSessionRecord>();
  private readonly streams = new Map<string, Set<ExpressResponse>>();
  private warningMessages: string[] = [];

  constructor(
    private readonly rootDir: string,
    private readonly bindHost: string,
    private readonly companionPort: number,
    private publicUrl: string,
    private lanHost: string,
  ) {
    this.statePath = path.join(rootDir, "mobile-bridge.json");
  }

  async loadFromDisk() {
    await fs.mkdir(this.rootDir, { recursive: true });

    try {
      const raw = await fs.readFile(this.statePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedMobileBridgeState>;
      const clients = Array.isArray(parsed.clients) ? parsed.clients : [];
      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];

      for (const client of clients) {
        if (!client || typeof client !== "object") {
          continue;
        }
        const record = client as Partial<StoredMobileBridgeClient>;
        if (!record.id || !record.token_hash || !record.name) {
          continue;
        }
        this.clients.set(record.id, {
          id: record.id,
          name: record.name,
          platform: normalizePlatform(record.platform),
          paired_at: record.paired_at || nowIso(),
          created_at: record.created_at || record.paired_at || nowIso(),
          last_seen_at: record.last_seen_at || record.paired_at || nowIso(),
          last_message_at: record.last_message_at || null,
          user_agent: record.user_agent || null,
          token_hash: record.token_hash,
        });
      }

      for (const message of messages) {
        if (!message || typeof message !== "object") {
          continue;
        }
        const record = message as Partial<MobileBridgeMessage>;
        if (!record.id || !record.client_id || !record.body || !record.created_at || !record.direction) {
          continue;
        }
        const nextMessage: MobileBridgeMessage = {
          id: record.id,
          client_id: record.client_id,
          body: record.body,
          created_at: record.created_at,
          direction:
            record.direction === "desktop_to_mobile" || record.direction === "mobile_to_desktop"
              ? record.direction
              : "system",
        };
        const bucket = this.messages.get(nextMessage.client_id) ?? [];
        bucket.push(nextMessage);
        this.messages.set(nextMessage.client_id, bucket);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  updateNetworkContext(input: { publicUrl: string; lanHost: string; warningMessages: string[] }) {
    this.publicUrl = input.publicUrl.replace(/\/$/, "");
    this.lanHost = input.lanHost;
    this.warningMessages = [...input.warningMessages];
  }

  getStatus(): MobileBridgeStatus {
    this.pruneExpiredPairings();
    const clients = this.listClients();
    return {
      enabled: true,
      public_url: this.publicUrl,
      companion_port: this.companionPort,
      bind_host: this.bindHost,
      lan_host: this.lanHost,
      warning_messages: [...this.warningMessages],
      total_clients: clients.length,
      online_clients: clients.filter((client) => client.status === "online").length,
      active_pairings: [...this.pairingSessions.values()].filter((session) => !session.consumed_at_ms).length,
    };
  }

  createPairingSession(timeoutMs = DEFAULT_PAIRING_TTL_MS): MobileBridgePairingSession {
    this.pruneExpiredPairings();
    const safeTimeout = Number.isFinite(timeoutMs) ? Math.max(30_000, timeoutMs) : DEFAULT_PAIRING_TTL_MS;
    const bootstrapToken = createOpaqueToken(18);
    const sessionId = `pair-${randomUUID()}`;
    const setupCode = encodePairingSetupCode({
      url: this.publicUrl,
      bootstrapToken,
    });
    const pairingUrl = new URL("/", this.publicUrl);
    pairingUrl.searchParams.set("setup", setupCode);
    const expiresAt = Date.now() + safeTimeout;

    this.pairingSessions.set(sessionId, {
      session_id: sessionId,
      bootstrap_token: bootstrapToken,
      setup_code: setupCode,
      pairing_url: pairingUrl.toString(),
      created_at_ms: Date.now(),
      expires_at_ms: expiresAt,
    });

    return {
      success: true,
      session_id: sessionId,
      setup_code: setupCode,
      pairing_url: pairingUrl.toString(),
      public_url: this.publicUrl,
      expires_at: expiresAt,
      expires_in_seconds: Math.max(1, Math.round((expiresAt - Date.now()) / 1000)),
    };
  }

  listClients(): MobileBridgeClient[] {
    return [...this.clients.values()]
      .map((client) => this.serializeClient(client))
      .sort((left, right) => {
        const rightLast = right.last_message_at || right.last_seen_at;
        const leftLast = left.last_message_at || left.last_seen_at;
        return rightLast.localeCompare(leftLast);
      });
  }

  getClient(clientId: string) {
    const client = this.clients.get(clientId);
    return client ? this.serializeClient(client) : null;
  }

  getMessages(clientId: string) {
    this.requireClient(clientId);
    return [...(this.messages.get(clientId) ?? [])].sort((left, right) => left.created_at.localeCompare(right.created_at));
  }

  async sendDesktopMessage(clientId: string, body: string) {
    const client = this.requireClient(clientId);
    const message = this.createMessage(client.id, "desktop_to_mobile", body);
    client.last_message_at = message.created_at;
    client.last_seen_at = message.created_at;
    await this.persistState();
    this.emitEvent(client.id, { type: "message", message });
    this.emitEvent(client.id, { type: "presence", client: this.serializeClient(client) });
    return message;
  }

  async removeClient(clientId: string) {
    const client = this.requireClient(clientId);
    this.clients.delete(client.id);
    this.messages.delete(client.id);
    await this.persistState();
    this.emitEvent(client.id, { type: "removed", client_id: client.id });
    const streams = this.streams.get(client.id);
    if (streams) {
      for (const response of streams) {
        response.end();
      }
      this.streams.delete(client.id);
    }
    return { success: true };
  }

  async claimPairing(input: {
    setupCode?: string;
    bootstrapToken?: string;
    name?: string;
    platform?: string;
    userAgent?: string | null;
  }) {
    this.pruneExpiredPairings();
    const bootstrapToken = this.resolveBootstrapToken(input);
    const pairingSession = [...this.pairingSessions.values()].find(
      (session) => session.bootstrap_token === bootstrapToken && !session.consumed_at_ms,
    );

    if (!pairingSession) {
      throw new Error("This pairing token is invalid or has already been used.");
    }
    if (pairingSession.expires_at_ms <= Date.now()) {
      this.pairingSessions.delete(pairingSession.session_id);
      throw new Error("This pairing token has expired.");
    }

    const clientId = `mobile-${randomUUID()}`;
    const clientToken = createOpaqueToken(24);
    const timestamp = nowIso();
    const client: StoredMobileBridgeClient = {
      id: clientId,
      name: normalizeDeviceName(input.name),
      platform: normalizePlatform(input.platform),
      paired_at: timestamp,
      created_at: timestamp,
      last_seen_at: timestamp,
      last_message_at: null,
      user_agent: input.userAgent || null,
      token_hash: hashToken(clientToken),
    };

    pairingSession.claimed_client_id = client.id;
    pairingSession.consumed_at_ms = Date.now();
    this.clients.set(client.id, client);

    const systemMessage = this.createMessage(
      client.id,
      "system",
      `${client.name} paired with Novaper. You can chat with the desktop from this mobile page now.`,
    );
    client.last_message_at = systemMessage.created_at;
    await this.persistState();

    return {
      client: this.serializeClient(client),
      client_token: clientToken,
      messages: this.getMessages(client.id),
      status: this.getStatus(),
    };
  }

  async restoreClientSession(clientId: string, clientToken: string) {
    const client = this.authenticateClient(clientId, clientToken);
    client.last_seen_at = nowIso();
    await this.persistState();
    return {
      client: this.serializeClient(client),
      messages: this.getMessages(client.id),
      status: this.getStatus(),
    };
  }

  async receiveClientMessage(input: { clientId: string; clientToken: string; body: string }) {
    const client = this.authenticateClient(input.clientId, input.clientToken);
    const message = this.createMessage(client.id, "mobile_to_desktop", input.body);
    client.last_seen_at = message.created_at;
    client.last_message_at = message.created_at;
    await this.persistState();
    this.emitEvent(client.id, { type: "message", message });
    this.emitEvent(client.id, { type: "presence", client: this.serializeClient(client) });
    return message;
  }

  async heartbeat(clientId: string, clientToken: string) {
    const client = this.authenticateClient(clientId, clientToken);
    client.last_seen_at = nowIso();
    await this.persistState();
    this.emitEvent(client.id, { type: "presence", client: this.serializeClient(client) });
    return this.serializeClient(client);
  }

  attachStream(clientId: string, clientToken: string, response: ExpressResponse) {
    const client = this.authenticateClient(clientId, clientToken);
    const streams = this.streams.get(client.id) ?? new Set<ExpressResponse>();
    streams.add(response);
    this.streams.set(client.id, streams);

    void this.heartbeat(client.id, clientToken).catch(() => undefined);
    this.writeEvent(response, {
      type: "snapshot",
      client: this.serializeClient(client),
      messages: this.getMessages(client.id),
    });

    return () => {
      const currentStreams = this.streams.get(client.id);
      currentStreams?.delete(response);
      if (currentStreams && currentStreams.size === 0) {
        this.streams.delete(client.id);
        this.emitEvent(client.id, { type: "presence", client: this.serializeClient(client) });
      }
    };
  }

  private serializeClient(client: StoredMobileBridgeClient): MobileBridgeClient {
    return {
      id: client.id,
      name: client.name,
      platform: client.platform,
      paired_at: client.paired_at,
      created_at: client.created_at,
      last_seen_at: client.last_seen_at,
      last_message_at: client.last_message_at,
      user_agent: client.user_agent,
      status: this.streams.has(client.id) ? "online" : "offline",
    };
  }

  private authenticateClient(clientId: string, clientToken: string) {
    const client = this.requireClient(clientId);
    if (client.token_hash !== hashToken(clientToken.trim())) {
      throw new Error("Mobile client session is invalid.");
    }
    return client;
  }

  private resolveBootstrapToken(input: { setupCode?: string; bootstrapToken?: string }) {
    if (input.setupCode?.trim()) {
      return decodePairingSetupCode(input.setupCode.trim()).bootstrapToken;
    }
    const token = input.bootstrapToken?.trim();
    if (!token) {
      throw new Error("A setup code or bootstrap token is required.");
    }
    return token;
  }

  private requireClient(clientId: string) {
    const client = this.clients.get(clientId);
    if (!client) {
      throw new Error(`Mobile client not found: ${clientId}`);
    }
    return client;
  }

  private createMessage(clientId: string, direction: MobileBridgeMessage["direction"], body: string) {
    const trimmedBody = body.trim();
    if (!trimmedBody) {
      throw new Error("Message body is required.");
    }
    const message: MobileBridgeMessage = {
      id: `msg-${randomUUID()}`,
      client_id: clientId,
      direction,
      body: trimmedBody,
      created_at: nowIso(),
    };
    const bucket = this.messages.get(clientId) ?? [];
    bucket.push(message);
    this.messages.set(clientId, bucket);
    return message;
  }

  private emitEvent(clientId: string, event: MobileBridgeEvent) {
    const streams = this.streams.get(clientId);
    if (!streams || streams.size === 0) {
      return;
    }
    for (const response of streams) {
      this.writeEvent(response, event);
    }
  }

  private writeEvent(response: ExpressResponse, event: MobileBridgeEvent) {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  private pruneExpiredPairings() {
    const now = Date.now();
    for (const [sessionId, session] of this.pairingSessions.entries()) {
      if (session.expires_at_ms <= now || session.consumed_at_ms) {
        this.pairingSessions.delete(sessionId);
      }
    }
  }

  private async persistState() {
    const state: PersistedMobileBridgeState = {
      clients: [...this.clients.values()],
      messages: [...this.messages.values()].flat().sort((left, right) => left.created_at.localeCompare(right.created_at)),
    };
    await fs.writeFile(this.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }
}

function renderMobileBridgeShell(store: MobileBridgeStore) {
  const status = store.getStatus();
  const warningMarkup = status.warning_messages
    .map((message) => `<div class="notice warning">${escapeHtml(message)}</div>`)
    .join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>Novaper Mobile Bridge</title>
    <meta name="theme-color" content="#07111f" />
    <style>
      :root {
        --bg: #07111f;
        --card: rgba(15, 23, 42, 0.86);
        --card-border: rgba(148, 163, 184, 0.18);
        --text: #e2e8f0;
        --muted: #94a3b8;
        --accent: #38bdf8;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        color: var(--text);
        font-family: "SF Pro Text", "Segoe UI Variable", "Avenir Next", sans-serif;
        background:
          radial-gradient(circle at top, rgba(56, 189, 248, 0.16), transparent 34%),
          radial-gradient(circle at bottom right, rgba(14, 165, 233, 0.2), transparent 30%),
          linear-gradient(180deg, #020617 0%, #081322 60%, #0f172a 100%);
      }
      main { width: min(100%, 560px); margin: 0 auto; padding: 18px 16px 32px; }
      .hero, .panel {
        border: 1px solid var(--card-border);
        border-radius: 24px;
        background: var(--card);
        box-shadow: 0 18px 44px rgba(2, 8, 23, 0.28);
        backdrop-filter: blur(14px);
      }
      .hero { padding: 18px; }
      .panel { padding: 16px; margin-top: 14px; }
      .eyebrow {
        display: inline-flex;
        padding: 6px 10px;
        border-radius: 999px;
        font-size: 12px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: #bae6fd;
        background: rgba(56, 189, 248, 0.12);
      }
      h1 { margin: 14px 0 8px; font-size: 29px; line-height: 1.1; }
      h2 { margin: 0 0 6px; font-size: 18px; }
      p { margin: 0; line-height: 1.5; color: var(--muted); }
      label { display: block; margin: 12px 0 8px; font-size: 13px; color: #cbd5e1; }
      input, textarea, button {
        width: 100%;
        font: inherit;
        border: 0;
        border-radius: 16px;
      }
      input, textarea {
        padding: 14px 15px;
        color: var(--text);
        background: rgba(2, 6, 23, 0.52);
        border: 1px solid rgba(148, 163, 184, 0.18);
        outline: none;
      }
      input:focus, textarea:focus {
        border-color: rgba(56, 189, 248, 0.65);
        box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.14);
      }
      button {
        padding: 14px 16px;
        font-weight: 700;
        color: #03121f;
        background: linear-gradient(180deg, #7dd3fc, #38bdf8);
      }
      button.secondary {
        color: var(--text);
        background: rgba(30, 41, 59, 0.92);
        border: 1px solid rgba(148, 163, 184, 0.2);
      }
      .row {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 10px;
        margin-top: 12px;
      }
      .meta, .notice {
        margin-top: 12px;
        padding: 12px 14px;
        border-radius: 16px;
        font-size: 13px;
      }
      .meta {
        background: rgba(8, 47, 73, 0.28);
        color: #cbd5e1;
      }
      .notice.warning {
        background: rgba(245, 158, 11, 0.14);
        border: 1px solid rgba(245, 158, 11, 0.24);
        color: #fde68a;
      }
      .notice.success {
        background: rgba(34, 197, 94, 0.14);
        border: 1px solid rgba(34, 197, 94, 0.24);
        color: #bbf7d0;
      }
      .chat {
        display: grid;
        gap: 10px;
        max-height: 46vh;
        overflow-y: auto;
        margin-top: 14px;
        padding-right: 4px;
      }
      .bubble {
        max-width: 88%;
        padding: 12px 14px;
        border-radius: 18px;
        font-size: 14px;
        line-height: 1.45;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .bubble.mobile { justify-self: end; background: linear-gradient(180deg, rgba(56, 189, 248, 0.28), rgba(14, 165, 233, 0.22)); border-bottom-right-radius: 6px; }
      .bubble.desktop { justify-self: start; background: rgba(30, 41, 59, 0.92); border-bottom-left-radius: 6px; }
      .bubble.system { justify-self: center; background: rgba(34, 197, 94, 0.14); border: 1px solid rgba(34, 197, 94, 0.2); color: #bbf7d0; }
      .bubble small { display: block; margin-top: 6px; color: rgba(226, 232, 240, 0.62); font-size: 11px; }
      .hidden { display: none !important; }
      code { font-family: "Cascadia Code", "SFMono-Regular", monospace; font-size: 12px; color: #bae6fd; word-break: break-all; }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <div class="eyebrow">Novaper Mobile Bridge</div>
        <h1>Pair this phone to the desktop</h1>
        <p>Scan the QR code from Novaper or paste the setup code below. After pairing, this phone can exchange messages with the desktop over your local network.</p>
      </section>
      ${warningMarkup}
      <section class="panel" id="pairing-panel">
        <h2>Pairing</h2>
        <p>Setup codes are short lived. They contain a reachable bridge URL and a one-time bootstrap token.</p>
        <label for="device-name">Device name</label>
        <input id="device-name" maxlength="80" value="Novaper Mobile" />
        <label for="setup-code">Setup code</label>
        <textarea id="setup-code" rows="4" placeholder="Paste the desktop setup code or open the QR link."></textarea>
        <div class="row">
          <button id="pair-button">Pair now</button>
          <button id="forget-button" class="secondary" type="button">Forget</button>
        </div>
        <div class="meta">
          <div>Bridge URL</div>
          <code>${escapeHtml(status.public_url)}</code>
        </div>
        <div id="status-line" class="notice hidden"></div>
      </section>
      <section class="panel hidden" id="chat-panel">
        <h2 id="chat-title">Connected</h2>
        <p id="chat-subtitle">Waiting for messages.</p>
        <div id="chat-list" class="chat" aria-live="polite"></div>
        <label for="message-box">Message</label>
        <textarea id="message-box" rows="3" placeholder="Send a note to the desktop operator."></textarea>
        <div class="row">
          <button id="send-button">Send</button>
          <button id="reconnect-button" class="secondary" type="button">Reconnect</button>
        </div>
      </section>
    </main>
    <script>
      const STORAGE_KEY = ${JSON.stringify(MOBILE_SESSION_KEY)};
      const els = {
        pairingPanel: document.getElementById('pairing-panel'),
        chatPanel: document.getElementById('chat-panel'),
        deviceName: document.getElementById('device-name'),
        setupCode: document.getElementById('setup-code'),
        pairButton: document.getElementById('pair-button'),
        forgetButton: document.getElementById('forget-button'),
        reconnectButton: document.getElementById('reconnect-button'),
        sendButton: document.getElementById('send-button'),
        messageBox: document.getElementById('message-box'),
        chatList: document.getElementById('chat-list'),
        chatTitle: document.getElementById('chat-title'),
        chatSubtitle: document.getElementById('chat-subtitle'),
        statusLine: document.getElementById('status-line'),
      };

      let state = { session: null, client: null, messages: [], eventSource: null, heartbeat: null };

      function detectPlatform() {
        const ua = navigator.userAgent.toLowerCase();
        if (/iphone|ipad|ipod/.test(ua)) return 'ios';
        if (/android/.test(ua)) return 'android';
        return 'web';
      }

      function escapeHtmlClient(value) {
        return String(value)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      function setStatus(message, tone) {
        if (!message) {
          els.statusLine.className = 'notice hidden';
          els.statusLine.textContent = '';
          return;
        }
        els.statusLine.className = 'notice ' + (tone || 'warning');
        els.statusLine.textContent = message;
      }

      function saveSession(session) {
        if (!session) {
          localStorage.removeItem(STORAGE_KEY);
          return;
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
      }

      function loadSession() {
        try {
          const raw = localStorage.getItem(STORAGE_KEY);
          return raw ? JSON.parse(raw) : null;
        } catch {
          return null;
        }
      }

      function stopLive() {
        if (state.eventSource) state.eventSource.close();
        if (state.heartbeat) clearInterval(state.heartbeat);
        state.eventSource = null;
        state.heartbeat = null;
      }

      async function requestJson(url, init) {
        const response = await fetch(url, {
          ...init,
          headers: {
            'Content-Type': 'application/json',
            ...(init && init.headers ? init.headers : {}),
          },
        });
        const text = await response.text();
        let payload = {};
        if (text) {
          try { payload = JSON.parse(text); } catch { payload = { message: text }; }
        }
        if (!response.ok) {
          throw new Error(payload.error || payload.message || 'Request failed.');
        }
        return payload;
      }

      function renderMessages() {
        els.chatList.innerHTML = '';
        if (!state.messages.length) {
          const empty = document.createElement('div');
          empty.className = 'notice warning';
          empty.textContent = 'No messages yet.';
          els.chatList.appendChild(empty);
          return;
        }
        state.messages.forEach((message) => {
          const direction =
            message.direction === 'mobile_to_desktop'
              ? 'mobile'
              : message.direction === 'desktop_to_mobile'
                ? 'desktop'
                : 'system';
          const bubble = document.createElement('div');
          bubble.className = 'bubble ' + direction;
          bubble.innerHTML =
            escapeHtmlClient(message.body).replace(/\\n/g, '<br />') +
            '<small>' +
            (direction === 'mobile' ? 'You' : direction === 'desktop' ? 'Desktop' : 'System') +
            ' | ' +
            new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) +
            '</small>';
          els.chatList.appendChild(bubble);
        });
        els.chatList.scrollTop = els.chatList.scrollHeight;
      }

      function updateView() {
        const connected = Boolean(state.session && state.client);
        els.pairingPanel.classList.toggle('hidden', connected);
        els.chatPanel.classList.toggle('hidden', !connected);
        if (state.client) {
          els.chatTitle.textContent = state.client.name;
          els.chatSubtitle.textContent =
            state.client.status === 'online'
              ? 'Linked to the desktop. Messages sync live.'
              : 'Session restored. Waiting for the bridge to come online.';
        }
        renderMessages();
      }

      async function restoreSession(session) {
        const query = new URLSearchParams({
          clientId: session.clientId,
          clientToken: session.clientToken,
        });
        const payload = await requestJson('/api/session?' + query.toString());
        state.session = session;
        state.client = payload.client;
        state.messages = Array.isArray(payload.messages) ? payload.messages : [];
        updateView();
        openLive();
      }

      async function pairNow() {
        const setupCode = els.setupCode.value.trim();
        if (!setupCode) {
          setStatus('Paste a setup code from the desktop first.', 'warning');
          return;
        }
        els.pairButton.disabled = true;
        setStatus('Pairing with desktop...', 'success');
        try {
          const payload = await requestJson('/api/pair', {
            method: 'POST',
            body: JSON.stringify({
              setup_code: setupCode,
              device_name: els.deviceName.value.trim(),
              platform: detectPlatform(),
            }),
          });
          const session = { clientId: payload.client.id, clientToken: payload.client_token };
          saveSession(session);
          state.session = session;
          state.client = payload.client;
          state.messages = Array.isArray(payload.messages) ? payload.messages : [];
          setStatus('', '');
          updateView();
          openLive();
        } catch (error) {
          setStatus(error.message || String(error), 'warning');
        } finally {
          els.pairButton.disabled = false;
        }
      }

      async function sendMessage() {
        if (!state.session) return;
        const body = els.messageBox.value.trim();
        if (!body) return;
        els.sendButton.disabled = true;
        try {
          await requestJson('/api/messages', {
            method: 'POST',
            body: JSON.stringify({
              client_id: state.session.clientId,
              client_token: state.session.clientToken,
              body,
            }),
          });
          els.messageBox.value = '';
        } catch (error) {
          setStatus(error.message || String(error), 'warning');
        } finally {
          els.sendButton.disabled = false;
        }
      }

      async function ping() {
        if (!state.session) return;
        try {
          await requestJson('/api/ping', {
            method: 'POST',
            body: JSON.stringify({
              client_id: state.session.clientId,
              client_token: state.session.clientToken,
            }),
          });
        } catch {
          // Let SSE surface failures.
        }
      }

      function openLive() {
        stopLive();
        if (!state.session) return;
        const query = new URLSearchParams({
          clientId: state.session.clientId,
          clientToken: state.session.clientToken,
        });
        const stream = new EventSource('/api/events?' + query.toString());
        state.eventSource = stream;
        stream.onmessage = (event) => {
          try {
            const payload = JSON.parse(event.data);
            if (payload.type === 'snapshot') {
              state.client = payload.client || state.client;
              state.messages = Array.isArray(payload.messages) ? payload.messages : state.messages;
              updateView();
              return;
            }
            if (payload.type === 'message' && payload.message) {
              state.messages = [...state.messages, payload.message];
              renderMessages();
              return;
            }
            if (payload.type === 'presence' && payload.client) {
              state.client = payload.client;
              updateView();
              return;
            }
            if (payload.type === 'removed') {
              forgetLocalSession();
              setStatus('This mobile session was removed from the desktop.', 'warning');
            }
          } catch {
            // Ignore malformed events.
          }
        };
        stream.onerror = () => {
          stopLive();
          if (state.session) {
            setStatus('Bridge disconnected. Tap reconnect to restore the mobile session.', 'warning');
          }
        };
        state.heartbeat = setInterval(ping, 20000);
      }

      function forgetLocalSession() {
        stopLive();
        state = { session: null, client: null, messages: [], eventSource: null, heartbeat: null };
        saveSession(null);
        updateView();
      }

      els.pairButton.addEventListener('click', pairNow);
      els.sendButton.addEventListener('click', sendMessage);
      els.forgetButton.addEventListener('click', () => {
        forgetLocalSession();
        setStatus('Local mobile session removed from this browser.', 'success');
      });
      els.reconnectButton.addEventListener('click', async () => {
        const session = loadSession();
        if (!session) {
          setStatus('No stored mobile session was found.', 'warning');
          return;
        }
        setStatus('Restoring mobile session...', 'success');
        try {
          await restoreSession(session);
          setStatus('', '');
        } catch (error) {
          setStatus(error.message || String(error), 'warning');
        }
      });
      els.messageBox.addEventListener('keydown', (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          event.preventDefault();
          sendMessage();
        }
      });

      const query = new URLSearchParams(window.location.search);
      const setup = query.get('setup');
      if (setup) {
        els.setupCode.value = setup;
      }

      const storedSession = loadSession();
      if (storedSession) {
        restoreSession(storedSession).catch((error) => {
          forgetLocalSession();
          setStatus(error.message || String(error), 'warning');
        });
      } else {
        updateView();
      }
    </script>
  </body>
</html>`;
}

export function createMobileCompanionApp(store: MobileBridgeStore) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/", (_request, response) => {
    response.type("html").send(renderMobileBridgeShell(store));
  });

  app.get("/api/status", (_request, response) => {
    response.json(store.getStatus());
  });

  app.post("/api/pair", async (request, response) => {
    try {
      const payload = await store.claimPairing({
        setupCode: String(request.body?.setup_code ?? ""),
        bootstrapToken: String(request.body?.bootstrap_token ?? ""),
        name: request.body?.device_name,
        platform: request.body?.platform,
        userAgent: request.get("user-agent") ?? null,
      });
      response.status(201).json(payload);
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/session", async (request, response) => {
    try {
      const payload = await store.restoreClientSession(
        String(request.query.clientId ?? ""),
        String(request.query.clientToken ?? ""),
      );
      response.json(payload);
    } catch (error) {
      response.status(401).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/messages", async (request, response) => {
    try {
      const message = await store.receiveClientMessage({
        clientId: String(request.body?.client_id ?? ""),
        clientToken: String(request.body?.client_token ?? ""),
        body: String(request.body?.body ?? ""),
      });
      response.status(201).json(message);
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/ping", async (request, response) => {
    try {
      const client = await store.heartbeat(
        String(request.body?.client_id ?? ""),
        String(request.body?.client_token ?? ""),
      );
      response.json({ success: true, client });
    } catch (error) {
      response.status(401).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/events", (request, response) => {
    try {
      response.setHeader("Content-Type", "text/event-stream");
      response.setHeader("Cache-Control", "no-cache, no-transform");
      response.setHeader("Connection", "keep-alive");
      const cleanup = store.attachStream(
        String(request.query.clientId ?? ""),
        String(request.query.clientToken ?? ""),
        response,
      );
      const heartbeat = setInterval(() => {
        response.write(": keep-alive\n\n");
      }, 15_000);
      request.on("close", () => {
        clearInterval(heartbeat);
        cleanup();
      });
    } catch (error) {
      response.status(401).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return app;
}
