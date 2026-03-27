import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import {
  ArrowLeft,
  ArrowRight,
  Bug,
  Camera,
  ExternalLink,
  Globe,
  RefreshCw,
  User,
} from 'lucide-react';

import { useElectron } from '../hooks/useElectron';

export const Route = createFileRoute('/browser')({
  component: BrowserPage,
});

type BrowserState = {
  id: string;
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  isShow: boolean;
};

type BrowserDebugState = {
  bridgeEnabled: boolean;
  defaultTargetId: string | null;
  inspectBaseUrl: string;
  inspectTargetsUrl: string;
  remoteDebuggingPort: number;
  targetCount: number;
  targets: Array<{
    id: string;
    title: string;
    url: string;
    canGoBack: boolean;
    canGoForward: boolean;
    isLoading: boolean;
    isShow: boolean;
    isActive: boolean;
    debuggerAttached: boolean;
    ownedByBridge: boolean;
  }>;
  transport: string;
};

type BrowserRuntimeState = {
  preferredMode: 'playwright' | 'external_cdp';
  defaultProfile: string;
  activeTransport?: string;
  profiles: Array<{
    name: string;
    mode: string;
    driver: string;
    transport: string;
    attachOnly: boolean;
    available: boolean;
    browser?: string;
    browserLabel?: string;
    cdpUrl?: string;
    profileDirectory?: string;
    userDataDir?: string;
    source?: string;
    lastError?: string;
  }>;
  externalCdp: {
    preferred: boolean;
    available: boolean;
    attachedSessionCount: number;
    browser?: string;
    endpointURL?: string;
    source?: string;
    port?: number;
    profileDirectory?: string;
    lastCheckedAt?: string;
    error?: string;
  };
};

const DEFAULT_URL = 'https://www.google.com';
const MANUAL_WEBVIEW_ID = '999';
const OFFSCREEN_BOUNDS = { x: -9999, y: -9999, width: 100, height: 100 };

function normalizeUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return DEFAULT_URL;
  }
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

function BrowserPage() {
  const { isElectron, api } = useElectron();
  const browserHostRef = React.useRef<HTMLDivElement>(null);

  const [inputUrl, setInputUrl] = React.useState(DEFAULT_URL);
  const [activeWebviewId, setActiveWebviewId] = React.useState<string | null>(
    null
  );
  const [shownWebviewIds, setShownWebviewIds] = React.useState<string[]>([]);
  const [browserState, setBrowserState] = React.useState<BrowserState | null>(
    null
  );
  const [screenshot, setScreenshot] = React.useState<string | null>(null);
  const [profiles, setProfiles] = React.useState<any[]>([]);
  const [browserDebugState, setBrowserDebugState] =
    React.useState<BrowserDebugState | null>(null);
  const [browserRuntimeState, setBrowserRuntimeState] =
    React.useState<BrowserRuntimeState | null>(null);
  const [browserDebugApiBaseUrl, setBrowserDebugApiBaseUrl] =
    React.useState<string | null>(null);

  const applyBrowserState = React.useCallback((nextState: BrowserState | null) => {
    setBrowserState(nextState);
    if (nextState?.url) {
      setInputUrl(nextState.url);
    }
  }, []);

  const refreshWebviewState = React.useCallback(
    async (id: string) => {
      if (!api) {
        return null;
      }

      const nextState = await api.getWebviewState(id);
      if (nextState) {
        setActiveWebviewId(nextState.id);
        applyBrowserState(nextState);
      }
      return nextState;
    },
    [api, applyBrowserState]
  );

  const refreshShownWebviews = React.useCallback(async () => {
    if (!api) {
      return [];
    }

    const ids = (await api.getShowWebview()) ?? [];
    setShownWebviewIds(ids);

    const fallbackId = ids.length > 0 ? ids[ids.length - 1] : null;
    const targetId =
      activeWebviewId && ids.includes(activeWebviewId)
        ? activeWebviewId
        : fallbackId;

    setActiveWebviewId(targetId);

    if (targetId) {
      await refreshWebviewState(targetId);
    } else {
      applyBrowserState(null);
    }

    return ids;
  }, [activeWebviewId, api, applyBrowserState, refreshWebviewState]);

  const syncBrowserBounds = React.useCallback(async () => {
    if (!api || !browserHostRef.current || shownWebviewIds.length === 0) {
      return;
    }

    const rect = browserHostRef.current.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) {
      return;
    }

    await api.setSize({
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
  }, [api, shownWebviewIds.length]);

  const handleLoadProfiles = React.useCallback(async () => {
    if (!api) {
      return;
    }
    const nextProfiles = await api.listBrowserProfiles();
    setProfiles(nextProfiles ?? []);
  }, [api]);

  const refreshBrowserDebugState = React.useCallback(async () => {
    if (!api) {
      return;
    }

    const runtimeStatusPromise = fetch('/api/browser/runtime/status')
      .then(async (response) => {
        if (!response.ok) {
          return null;
        }
        return (await response.json()) as BrowserRuntimeState;
      })
      .catch(() => null);

    const [debugStatus, backendPort, runtimeStatus] = await Promise.all([
      api.getBrowserDebugStatus(),
      api.getBackendPort().catch(() => null),
      runtimeStatusPromise,
    ]);

    setBrowserDebugState(debugStatus);
    setBrowserRuntimeState(runtimeStatus);
    setBrowserDebugApiBaseUrl(
      typeof backendPort === 'number'
        ? `http://127.0.0.1:${backendPort}/api/browser/debug`
        : null
    );
  }, [api]);

  const handleNavigate = React.useCallback(async () => {
    if (!api) {
      return;
    }

    const targetUrl = normalizeUrl(inputUrl);
    let targetId = activeWebviewId;

    if (!targetId) {
      const createResult = await api.createWebView(MANUAL_WEBVIEW_ID, targetUrl);
      if (createResult?.success) {
        targetId = MANUAL_WEBVIEW_ID;
      } else if (
        String(createResult?.error || '').includes(
          `Webview with id ${MANUAL_WEBVIEW_ID} already exists`
        )
      ) {
        targetId = MANUAL_WEBVIEW_ID;
        await api.navigateWebview(targetId, targetUrl);
      } else {
        return;
      }
    } else {
      await api.navigateWebview(targetId, targetUrl);
    }

    await api.showWebview(targetId);
    setActiveWebviewId(targetId);
    await refreshShownWebviews();
    await syncBrowserBounds();
    await refreshBrowserDebugState();
  }, [
    activeWebviewId,
    api,
    inputUrl,
    refreshBrowserDebugState,
    refreshShownWebviews,
    syncBrowserBounds,
  ]);

  const handleCapture = React.useCallback(async () => {
    if (!api || !activeWebviewId) {
      return;
    }
    const data = await api.captureWebview(activeWebviewId);
    if (data) {
      setScreenshot(data);
    }
  }, [activeWebviewId, api]);

  const handleBack = React.useCallback(async () => {
    if (!api || !activeWebviewId) {
      return;
    }
    await api.goBackWebview(activeWebviewId);
    await refreshWebviewState(activeWebviewId);
    await refreshBrowserDebugState();
  }, [activeWebviewId, api, refreshBrowserDebugState, refreshWebviewState]);

  const handleForward = React.useCallback(async () => {
    if (!api || !activeWebviewId) {
      return;
    }
    await api.goForwardWebview(activeWebviewId);
    await refreshWebviewState(activeWebviewId);
    await refreshBrowserDebugState();
  }, [activeWebviewId, api, refreshBrowserDebugState, refreshWebviewState]);

  const handleReload = React.useCallback(async () => {
    if (!api || !activeWebviewId) {
      return;
    }
    await api.reloadWebview(activeWebviewId);
    await refreshWebviewState(activeWebviewId);
    await refreshBrowserDebugState();
  }, [activeWebviewId, api, refreshBrowserDebugState, refreshWebviewState]);

  React.useEffect(() => {
    if (!api) {
      return;
    }

    void refreshShownWebviews();
    void handleLoadProfiles();
    void refreshBrowserDebugState();
  }, [api, handleLoadProfiles, refreshBrowserDebugState, refreshShownWebviews]);

  React.useEffect(() => {
    if (!api) {
      return;
    }

    const cleanupShow = api.onWebviewShow((id: string) => {
      setShownWebviewIds(prev => (prev.includes(id) ? prev : [...prev, id]));
      setActiveWebviewId(id);
      void refreshWebviewState(id);
      void refreshBrowserDebugState();
      window.requestAnimationFrame(() => {
        void syncBrowserBounds();
      });
    });

    const cleanupHide = api.onWebviewHide((id: string) => {
      setShownWebviewIds(prev => prev.filter(item => item !== id));
      if (activeWebviewId === id) {
        setActiveWebviewId(null);
      }
      void refreshShownWebviews();
      void refreshBrowserDebugState();
    });

    const cleanupNavigated = api.onWebviewNavigated((id: string, url: string) => {
      setShownWebviewIds(prev => (prev.includes(id) ? prev : [...prev, id]));
      setActiveWebviewId(id);
      setInputUrl(url);
      void refreshWebviewState(id);
      void refreshBrowserDebugState();
    });

    const cleanupUrl = api.onUrlUpdated((url: string) => {
      setInputUrl(url);
      setBrowserState(prev => (prev ? { ...prev, url } : prev));
    });

    return () => {
      cleanupShow();
      cleanupHide();
      cleanupNavigated();
      cleanupUrl();
    };
  }, [
    activeWebviewId,
    api,
    refreshBrowserDebugState,
    refreshShownWebviews,
    refreshWebviewState,
    syncBrowserBounds,
  ]);

  React.useEffect(() => {
    if (!api) {
      return;
    }

    const timer = window.setInterval(() => {
      void refreshBrowserDebugState();
    }, 5000);

    return () => {
      window.clearInterval(timer);
    };
  }, [api, refreshBrowserDebugState]);

  React.useEffect(() => {
    if (!api || shownWebviewIds.length === 0 || !browserHostRef.current) {
      return;
    }

    void syncBrowserBounds();

    const host = browserHostRef.current;
    const resizeObserver = new ResizeObserver(() => {
      void syncBrowserBounds();
    });

    resizeObserver.observe(host);

    const handleWindowResize = () => {
      void syncBrowserBounds();
    };

    window.addEventListener('resize', handleWindowResize);
    const frame = window.requestAnimationFrame(() => {
      void syncBrowserBounds();
    });

    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      window.removeEventListener('resize', handleWindowResize);
    };
  }, [api, shownWebviewIds.length, syncBrowserBounds]);

  React.useEffect(() => {
    return () => {
      if (api) {
        void api.setSize(OFFSCREEN_BOUNDS);
      }
    };
  }, [api]);

  if (!isElectron) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
            <Globe className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-foreground">
              Embedded Browser
            </h1>
            <p className="text-sm text-muted-foreground">
              Run automation tasks with a built-in browser
            </p>
          </div>
        </div>
        <div className="glass rounded-xl border border-border p-8 text-center">
          <Globe className="mx-auto mb-4 h-16 w-16 text-primary/30" />
          <h2 className="mb-2 text-lg font-semibold">Desktop App Required</h2>
          <p className="text-muted-foreground">
            The embedded browser is only available in the Novaper desktop app.
          </p>
        </div>
      </div>
    );
  }

  const hasEmbeddedBrowser = shownWebviewIds.length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="border-b border-border bg-card px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void handleBack()}
            disabled={!browserState?.canGoBack}
            className="rounded-lg border border-border p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            title="Back"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => void handleForward()}
            disabled={!browserState?.canGoForward}
            className="rounded-lg border border-border p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            title="Forward"
          >
            <ArrowRight className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => void handleReload()}
            disabled={!activeWebviewId}
            className="rounded-lg border border-border p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            title="Reload"
          >
            <RefreshCw className="h-4 w-4" />
          </button>

          <div className="flex min-w-[280px] flex-1 items-center gap-2 rounded-xl border border-border bg-muted/40 px-3 py-2">
            <Globe className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
            <input
              type="text"
              value={inputUrl}
              onChange={event => setInputUrl(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  void handleNavigate();
                }
              }}
              className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none"
              placeholder="Enter a URL..."
            />
          </div>

          <button
            type="button"
            onClick={() => void handleCapture()}
            disabled={!activeWebviewId}
            className="rounded-lg border border-border p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            title="Capture screenshot"
          >
            <Camera className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="relative flex-1 bg-muted/20">
          <div className="absolute inset-4 overflow-hidden rounded-[24px] border border-border bg-background shadow-sm">
            <div ref={browserHostRef} className="h-full w-full" />
            {!hasEmbeddedBrowser ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center">
                <Globe className="h-16 w-16 text-primary/20" />
                <div className="space-y-2">
                  <h2 className="text-lg font-semibold text-foreground">
                    No embedded browser session yet
                  </h2>
                  <p className="max-w-md text-sm text-muted-foreground">
                    Open a page here, or trigger any `browser_*` task. When the
                    Electron WebView is shown, this page will attach to it
                    automatically.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void handleNavigate()}
                  className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
                >
                  Open Browser
                </button>
              </div>
            ) : null}
          </div>
        </div>

        <aside className="flex w-80 flex-col gap-5 overflow-y-auto border-l border-border bg-card/80 p-4">
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              <Globe className="h-3.5 w-3.5" />
              Embedded Session
            </div>
            <div className="rounded-2xl border border-border bg-background/70 p-4">
              <div className="text-sm font-medium text-foreground">
                {browserState?.title || 'Electron WebView'}
              </div>
              <div className="mt-2 break-all text-xs text-muted-foreground">
                {browserState?.url || 'about:blank'}
              </div>
              <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
                <span className="rounded-full bg-muted px-2 py-1">
                  {activeWebviewId ? `WebView #${activeWebviewId}` : 'Idle'}
                </span>
                <span className="rounded-full bg-muted px-2 py-1">
                  {browserState?.isLoading ? 'Loading' : 'Ready'}
                </span>
                <span className="rounded-full bg-muted px-2 py-1">
                  {shownWebviewIds.length} visible
                </span>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              <Bug className="h-3.5 w-3.5" />
              Remote Debugging
            </div>
            <div className="rounded-2xl border border-border bg-background/70 p-4">
              <div className="text-sm font-medium text-foreground">
                {browserDebugState?.bridgeEnabled
                  ? 'Native CDP bridge enabled'
                  : 'Debug bridge unavailable'}
              </div>
              <div className="mt-2 text-xs text-muted-foreground">
                {browserDebugState?.transport || 'electron-debugger'} · port{' '}
                {browserDebugState?.remoteDebuggingPort ?? 'n/a'}
              </div>
              <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
                <span className="rounded-full bg-muted px-2 py-1">
                  {browserDebugState?.targetCount ?? 0} targets
                </span>
                <span className="rounded-full bg-muted px-2 py-1">
                  default {browserDebugState?.defaultTargetId || 'none'}
                </span>
              </div>
                    <div className="mt-3 space-y-2 text-xs text-muted-foreground">
                      <div className="break-all">
                        Inspector: {browserDebugState?.inspectTargetsUrl || 'n/a'}
                      </div>
                      <div className="break-all">
                        API: {browserDebugApiBaseUrl || 'n/a'}
                      </div>
                    </div>
                    <div className="mt-4 rounded-xl bg-muted/50 p-3 text-xs text-muted-foreground">
                      <div className="font-medium text-foreground">
                        AI Browser Runtime
                      </div>
                      <div className="mt-1">
                        {browserRuntimeState?.preferredMode === 'external_cdp'
                          ? 'OpenClaw-style attach first'
                          : 'Managed profile first'}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <span className="rounded-full bg-background px-2 py-1">
                          {browserRuntimeState?.externalCdp.attachedSessionCount ?? 0}{' '}
                          attached
                        </span>
                        <span className="rounded-full bg-background px-2 py-1">
                          {browserRuntimeState?.activeTransport || browserRuntimeState?.externalCdp.source || 'idle'}
                        </span>
                        <span className="rounded-full bg-background px-2 py-1">
                          default {browserRuntimeState?.defaultProfile || 'n/a'}
                        </span>
                      </div>
                      <div className="mt-2 break-all">
                        {browserRuntimeState?.externalCdp.endpointURL ||
                          browserRuntimeState?.externalCdp.error ||
                          'No external CDP endpoint detected yet.'}
                      </div>
                      <div className="mt-3 space-y-2">
                        {(browserRuntimeState?.profiles ?? []).map(profile => (
                          <div
                            key={profile.name}
                            className="rounded-lg border border-border/70 bg-background px-3 py-2"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <div className="font-medium text-foreground">
                                {profile.name}
                              </div>
                              <span className="rounded-full bg-muted px-2 py-1 text-[11px] uppercase tracking-wide">
                                {profile.available ? 'ready' : 'idle'}
                              </span>
                            </div>
                            <div className="mt-1 text-[11px] text-muted-foreground">
                              {profile.transport} / {profile.mode}
                              {profile.attachOnly ? ' / attach-only' : ''}
                            </div>
                            <div className="mt-1 break-all text-[11px] text-muted-foreground">
                              {profile.cdpUrl ||
                                profile.userDataDir ||
                                profile.lastError ||
                                'No endpoint metadata'}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <button
                        type="button"
                  onClick={() =>
                    api?.openBrowserDevTools(
                      activeWebviewId || browserDebugState?.defaultTargetId || undefined
                    )
                  }
                  disabled={!api || !(activeWebviewId || browserDebugState?.defaultTargetId)}
                  className="rounded-xl border border-border px-3 py-2 text-sm text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Open DevTools
                </button>
                <button
                  type="button"
                  onClick={() =>
                    browserDebugState?.inspectTargetsUrl &&
                    api?.openExternalUrl(browserDebugState.inspectTargetsUrl)
                  }
                  disabled={!api || !browserDebugState?.inspectTargetsUrl}
                  className="rounded-xl border border-border px-3 py-2 text-sm text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Open Inspector JSON
                </button>
              </div>
            </div>
          </div>

          {screenshot ? (
            <div className="space-y-2">
              <div className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                Last Screenshot
              </div>
              <img
                src={screenshot}
                alt="Browser screenshot"
                className="w-full rounded-2xl border border-border"
              />
            </div>
          ) : null}

          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              <User className="h-3.5 w-3.5" />
              Browser Profiles
            </div>
            <div className="rounded-2xl border border-border bg-background/70 p-3">
              {profiles.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No profiles imported yet.
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  {profiles.map((profile: any) => (
                    <button
                      key={profile.name}
                      type="button"
                      onClick={async () => {
                        if (!api) {
                          return;
                        }
                        const result = await api.switchBrowserProfile(
                          profile.name
                        );
                        if (result?.success) {
                          api.restartApp();
                        }
                      }}
                      className="rounded-xl px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-muted"
                    >
                      {profile.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              <ExternalLink className="h-3.5 w-3.5" />
              Current Page
            </div>
            <div className="rounded-2xl border border-border bg-background/70 p-4 text-sm text-muted-foreground">
              {browserState?.url || inputUrl}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
