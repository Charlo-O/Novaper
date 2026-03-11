import OpenAI from "openai";
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AuthProvider } from "../../../packages/replay-schema/src/types.js";
import { createResponsesClient, createChatCompletionsClient, type ResponsesClient } from "../../../packages/runner-core/src/responsesClient.js";
import { createCodexResponsesClient } from "./codexResponsesClient.js";
import { getProxyDispatcher } from "./networkProxy.js";

const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_REDIRECT_URI = "http://localhost:1455/auth/callback";
const CODEX_SCOPE = "openid profile email offline_access";
const CODEX_CALLBACK_PORT = 1455;
const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

interface StoredCodexCredentials {
  access: string;
  refresh: string;
  expiresAt: string;
  accountId: string;
  updatedAt: string;
}

interface PendingCodexLogin {
  state: string;
  verifier: string;
  authorizeUrl: string;
  startedAt: string;
  server: http.Server;
}

export interface AuthStatus {
  defaultProvider: AuthProvider | null;
  providers: {
    apiKey: {
      id: "api-key";
      label: string;
      configured: boolean;
    };
    codexOAuth: {
      id: "codex-oauth";
      label: string;
      authenticated: boolean;
      loginInProgress: boolean;
      accountId?: string;
      expiresAt?: string;
      authorizeUrl?: string;
      error?: string;
    };
  };
}

function toBase64Url(value: Buffer) {
  return value.toString("base64url");
}

function now() {
  return new Date().toISOString();
}

function buildPkcePair() {
  const verifier = toBase64Url(randomBytes(32));
  const challenge = toBase64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function buildState() {
  return randomBytes(16).toString("hex");
}

function decodeJwtPayload(token: string) {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }

  try {
    const encoded = parts[1] ?? "";
    const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getCodexAccountId(accessToken: string) {
  const payload = decodeJwtPayload(accessToken);
  const authSection = payload?.[JWT_CLAIM_PATH];
  if (!authSection || typeof authSection !== "object") {
    return null;
  }

  const accountId = (authSection as Record<string, unknown>).chatgpt_account_id;
  return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
}

function buildSuccessPage(message: string) {
  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head><meta charset=\"utf-8\" /><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" /><title>Codex Auth</title></head>",
    "<body style=\"font-family:Segoe UI,sans-serif;padding:24px;\">",
    `<p>${message}</p>`,
    "<p>You can return to Codex.</p>",
    "</body></html>",
  ].join("");
}

export class AuthService {
  private readonly codexCredentialsFile: string;
  private readonly ready: Promise<void>;
  private codexCredentials?: StoredCodexCredentials;
  private pendingCodexLogin?: PendingCodexLogin;
  private lastCodexError?: string;

  constructor(
    rootDir: string,
    private readonly openAIApiKey?: string,
  ) {
    this.codexCredentialsFile = path.join(rootDir, "data", "auth", "codex-oauth.json");
    this.ready = this.loadCodexCredentials();
  }

  async getStatus(): Promise<AuthStatus> {
    await this.ready;

    const defaultProvider = this.openAIApiKey
      ? "api-key"
      : this.codexCredentials
        ? "codex-oauth"
        : null;

    return {
      defaultProvider,
      providers: {
        apiKey: {
          id: "api-key",
          label: "OpenAI API Key",
          configured: Boolean(this.openAIApiKey),
        },
        codexOAuth: {
          id: "codex-oauth",
          label: "ChatGPT Plus/Pro (Codex OAuth)",
          authenticated: Boolean(this.codexCredentials),
          loginInProgress: Boolean(this.pendingCodexLogin),
          accountId: this.codexCredentials?.accountId,
          expiresAt: this.codexCredentials?.expiresAt,
          authorizeUrl: this.pendingCodexLogin?.authorizeUrl,
          error: this.lastCodexError,
        },
      },
    };
  }

  async startCodexLogin(): Promise<{ authorizeUrl: string; startedAt: string }> {
    await this.ready;

    if (this.pendingCodexLogin) {
      return {
        authorizeUrl: this.pendingCodexLogin.authorizeUrl,
        startedAt: this.pendingCodexLogin.startedAt,
      };
    }

    const { verifier, challenge } = buildPkcePair();
    const state = buildState();
    const authorizeUrl = new URL(CODEX_AUTHORIZE_URL);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", CODEX_CLIENT_ID);
    authorizeUrl.searchParams.set("redirect_uri", CODEX_REDIRECT_URI);
    authorizeUrl.searchParams.set("scope", CODEX_SCOPE);
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("id_token_add_organizations", "true");
    authorizeUrl.searchParams.set("codex_cli_simplified_flow", "true");
    authorizeUrl.searchParams.set("originator", "codex");

    const server = http.createServer((request, response) => {
      void this.handleCodexCallback(request, response);
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(CODEX_CALLBACK_PORT, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    }).catch((error) => {
      this.lastCodexError =
        error instanceof Error
          ? `Unable to bind ${CODEX_REDIRECT_URI}. Ensure port 1455 is free. ${error.message}`
          : `Unable to bind ${CODEX_REDIRECT_URI}.`;
      throw new Error(this.lastCodexError);
    });

    this.lastCodexError = undefined;
    this.pendingCodexLogin = {
      state,
      verifier,
      authorizeUrl: authorizeUrl.toString(),
      startedAt: now(),
      server,
    };

    return {
      authorizeUrl: authorizeUrl.toString(),
      startedAt: this.pendingCodexLogin.startedAt,
    };
  }

  async logoutCodex(): Promise<void> {
    await this.ready;
    await this.closePendingLogin();
    this.codexCredentials = undefined;
    this.lastCodexError = undefined;
    await fs.rm(this.codexCredentialsFile, { force: true });
  }

  async resolveProvider(requested?: string | null): Promise<AuthProvider> {
    await this.ready;

    if (requested === "api-key") {
      if (!this.openAIApiKey) {
        throw new Error("OPENAI_API_KEY is not configured.");
      }
      return "api-key";
    }

    if (requested === "codex-oauth") {
      if (!this.codexCredentials) {
        throw new Error("Codex OAuth is not authenticated. Complete login first.");
      }
      return "codex-oauth";
    }

    if (this.openAIApiKey) {
      return "api-key";
    }

    if (this.codexCredentials) {
      return "codex-oauth";
    }

    throw new Error("No auth provider is available. Configure OPENAI_API_KEY or login with Codex OAuth.");
  }

  getCustomResponsesClient(baseUrl: string, apiKey: string): { authProvider: "custom-api"; client: ResponsesClient } {
    const dispatcher = getProxyDispatcher();
    type OpenAIClientOptions = ConstructorParameters<typeof OpenAI>[0];
    const fetchOptions = dispatcher ? ({ dispatcher } as NonNullable<OpenAIClientOptions>["fetchOptions"]) : undefined;

    const getClient = async () =>
      new OpenAI({
        apiKey,
        baseURL: baseUrl,
        organization: null,
        project: null,
        fetchOptions,
      });

    return {
      authProvider: "custom-api",
      client: createChatCompletionsClient(getClient),
    };
  }

  async getResponsesClient(requested?: string | null): Promise<{ authProvider: AuthProvider; client: ResponsesClient }> {
    const authProvider = await this.resolveProvider(requested);
    if (authProvider === "codex-oauth") {
      const credentials = await this.getValidCodexCredentials();
      return {
        authProvider,
        client: createCodexResponsesClient({
          accessToken: credentials.access,
          accountId: credentials.accountId,
        }),
      };
    }

    return {
      authProvider,
      client: createResponsesClient(async () => this.createOpenAIClient(authProvider)),
    };
  }

  private async createOpenAIClient(authProvider: AuthProvider): Promise<OpenAI> {
    const dispatcher = getProxyDispatcher();
    type OpenAIClientOptions = ConstructorParameters<typeof OpenAI>[0];
    const fetchOptions = dispatcher ? ({ dispatcher } as NonNullable<OpenAIClientOptions>["fetchOptions"]) : undefined;

    if (authProvider === "api-key") {
      if (!this.openAIApiKey) {
        throw new Error("OPENAI_API_KEY is not configured.");
      }

      return new OpenAI({
        apiKey: this.openAIApiKey,
        organization: null,
        project: null,
        fetchOptions,
      });
    }

    const credentials = await this.getValidCodexCredentials();
    return new OpenAI({
      apiKey: credentials.access,
      baseURL: CODEX_BASE_URL,
      organization: null,
      project: null,
      defaultHeaders: {
        "chatgpt-account-id": credentials.accountId,
        "OpenAI-Beta": "responses=experimental",
      },
      fetchOptions,
    });
  }

  private async handleCodexCallback(request: http.IncomingMessage, response: http.ServerResponse) {
    const pending = this.pendingCodexLogin;
    if (!pending) {
      response.statusCode = 410;
      response.end(buildSuccessPage("The login session has already ended."));
      return;
    }

    try {
      const requestUrl = new URL(request.url ?? "", CODEX_REDIRECT_URI);
      if (requestUrl.pathname !== "/auth/callback") {
        response.statusCode = 404;
        response.end("Not found");
        return;
      }

      if (requestUrl.searchParams.get("state") !== pending.state) {
        response.statusCode = 400;
        response.end(buildSuccessPage("State mismatch. Start the login flow again."));
        return;
      }

      const code = requestUrl.searchParams.get("code");
      if (!code) {
        response.statusCode = 400;
        response.end(buildSuccessPage("Authorization code is missing."));
        return;
      }

      const credentials = await this.exchangeAuthorizationCode(code, pending.verifier);
      await this.persistCodexCredentials(credentials);
      this.lastCodexError = undefined;

      response.statusCode = 200;
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(buildSuccessPage("Codex authentication succeeded."));
    } catch (error) {
      this.lastCodexError = error instanceof Error ? error.message : String(error);
      response.statusCode = 500;
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(buildSuccessPage(`Codex authentication failed: ${this.lastCodexError}`));
    } finally {
      await this.closePendingLogin();
    }
  }

  private async getValidCodexCredentials() {
    await this.ready;

    if (!this.codexCredentials) {
      throw new Error("Codex OAuth is not authenticated. Complete login first.");
    }

    const expiresAt = Date.parse(this.codexCredentials.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt - Date.now() <= 60_000) {
      const refreshed = await this.refreshCodexCredentials(this.codexCredentials.refresh);
      await this.persistCodexCredentials(refreshed);
    }

    if (!this.codexCredentials) {
      throw new Error("Codex OAuth credentials are unavailable.");
    }

    return this.codexCredentials;
  }

  private async exchangeAuthorizationCode(code: string, verifier: string): Promise<StoredCodexCredentials> {
    const tokenResponse = await fetch(CODEX_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CODEX_CLIENT_ID,
        code,
        code_verifier: verifier,
        redirect_uri: CODEX_REDIRECT_URI,
      }),
      ...(getProxyDispatcher() ? { dispatcher: getProxyDispatcher() } : {}),
    } as RequestInit);

    if (!tokenResponse.ok) {
      const details = await tokenResponse.text().catch(() => "");
      throw new Error(`Codex token exchange failed (${tokenResponse.status}). ${details}`.trim());
    }

    const payload = (await tokenResponse.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };

    return this.normalizeCodexTokenPayload(payload);
  }

  private async refreshCodexCredentials(refreshToken: string): Promise<StoredCodexCredentials> {
    const tokenResponse = await fetch(CODEX_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: CODEX_CLIENT_ID,
        refresh_token: refreshToken,
      }),
      ...(getProxyDispatcher() ? { dispatcher: getProxyDispatcher() } : {}),
    } as RequestInit);

    if (!tokenResponse.ok) {
      const details = await tokenResponse.text().catch(() => "");
      throw new Error(`Codex token refresh failed (${tokenResponse.status}). ${details}`.trim());
    }

    const payload = (await tokenResponse.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };

    return this.normalizeCodexTokenPayload(payload);
  }

  private normalizeCodexTokenPayload(payload: {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  }): StoredCodexCredentials {
    if (!payload.access_token || !payload.refresh_token || typeof payload.expires_in !== "number") {
      throw new Error("Codex token payload is missing required fields.");
    }

    const accountId = getCodexAccountId(payload.access_token);
    if (!accountId) {
      throw new Error("Failed to extract chatgpt_account_id from the Codex token.");
    }

    return {
      access: payload.access_token,
      refresh: payload.refresh_token,
      accountId,
      expiresAt: new Date(Date.now() + payload.expires_in * 1000).toISOString(),
      updatedAt: now(),
    };
  }

  private async loadCodexCredentials() {
    try {
      const raw = await fs.readFile(this.codexCredentialsFile, "utf8");
      this.codexCredentials = JSON.parse(raw) as StoredCodexCredentials;
    } catch {
      this.codexCredentials = undefined;
    }
  }

  private async persistCodexCredentials(credentials: StoredCodexCredentials) {
    this.codexCredentials = {
      ...credentials,
      updatedAt: now(),
    };
    await fs.mkdir(path.dirname(this.codexCredentialsFile), { recursive: true });
    await fs.writeFile(this.codexCredentialsFile, `${JSON.stringify(this.codexCredentials, null, 2)}\n`, "utf8");
  }

  private async closePendingLogin() {
    const pending = this.pendingCodexLogin;
    this.pendingCodexLogin = undefined;
    if (!pending) {
      return;
    }

    await new Promise<void>((resolve) => {
      pending.server.close(() => resolve());
    }).catch(() => undefined);
  }
}
