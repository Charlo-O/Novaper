import { createFileRoute } from '@tanstack/react-router';
import { useState, useRef, useCallback, useEffect } from 'react';
import { useElectron } from '../hooks/useElectron';
import {
  Globe,
  ArrowLeft,
  ArrowRight,
  RotateCw,
  Camera,
  User,
  ExternalLink,
} from 'lucide-react';

export const Route = createFileRoute('/browser')({
  component: BrowserPage,
});

function BrowserPage() {
  const { isElectron, api } = useElectron();
  const [url, setUrl] = useState('https://www.google.com');
  const [inputUrl, setInputUrl] = useState('https://www.google.com');
  const [activeWebviewId, setActiveWebviewId] = useState<string | null>(null);
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<any[]>([]);
  const urlInputRef = useRef<HTMLInputElement>(null);

  // Listen for URL updates from webview
  useEffect(() => {
    if (!api) return;
    const cleanup = api.onUrlUpdated((newUrl: string) => {
      setUrl(newUrl);
      setInputUrl(newUrl);
    });
    return cleanup;
  }, [api]);

  const handleNavigate = useCallback(async () => {
    if (!api) return;
    let navigateUrl = inputUrl;
    if (!navigateUrl.startsWith('http://') && !navigateUrl.startsWith('https://')) {
      navigateUrl = 'https://' + navigateUrl;
    }

    if (!activeWebviewId) {
      // Create and show first webview
      const result = await api.createWebView('browser-1', navigateUrl);
      if (result?.success) {
        await api.showWebview('browser-1');
        setActiveWebviewId('browser-1');
      }
    }
    setUrl(navigateUrl);
    setInputUrl(navigateUrl);
  }, [api, inputUrl, activeWebviewId]);

  const handleCapture = useCallback(async () => {
    if (!api || !activeWebviewId) return;
    const data = await api.captureWebview(activeWebviewId);
    if (data) setScreenshot(data);
  }, [api, activeWebviewId]);

  const handleLoadProfiles = useCallback(async () => {
    if (!api) return;
    const list = await api.listBrowserProfiles();
    setProfiles(list);
  }, [api]);

  useEffect(() => {
    handleLoadProfiles();
  }, [handleLoadProfiles]);

  // Fallback for non-Electron: show iframe or instructions
  if (!isElectron) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
            <Globe className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-foreground">Embedded Browser</h1>
            <p className="text-muted-foreground text-sm">
              Run automation tasks with a built-in browser
            </p>
          </div>
        </div>
        <div className="glass rounded-xl p-8 text-center border border-border">
          <Globe className="w-16 h-16 mx-auto text-primary/30 mb-4" />
          <h2 className="text-lg font-semibold mb-2">Desktop App Required</h2>
          <p className="text-muted-foreground">
            The embedded browser is available in the Novaper desktop app.
            Browser automation tasks in the web version use external Playwright browsers.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Browser toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-card">
        <button className="p-1.5 rounded hover:bg-muted transition-colors">
          <ArrowLeft className="w-4 h-4 text-muted-foreground" />
        </button>
        <button className="p-1.5 rounded hover:bg-muted transition-colors">
          <ArrowRight className="w-4 h-4 text-muted-foreground" />
        </button>
        <button className="p-1.5 rounded hover:bg-muted transition-colors">
          <RotateCw className="w-4 h-4 text-muted-foreground" />
        </button>

        {/* URL bar */}
        <div className="flex-1 flex items-center gap-2 px-3 py-1.5 rounded-lg bg-muted border border-border">
          <Globe className="w-4 h-4 text-muted-foreground flex-shrink-0" />
          <input
            ref={urlInputRef}
            type="text"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleNavigate();
            }}
            className="flex-1 bg-transparent text-sm text-foreground outline-none"
            placeholder="Enter URL..."
          />
        </div>

        {/* Actions */}
        <button
          onClick={handleCapture}
          className="p-1.5 rounded hover:bg-muted transition-colors"
          title="Capture screenshot"
        >
          <Camera className="w-4 h-4 text-muted-foreground" />
        </button>
        <button
          className="p-1.5 rounded hover:bg-muted transition-colors"
          title="Profile"
        >
          <User className="w-4 h-4 text-muted-foreground" />
        </button>
      </div>

      {/* Split pane: browser view + control panel */}
      <div className="flex-1 flex overflow-hidden">
        {/* Browser view area (WebContentsView renders here via Electron) */}
        <div className="flex-1 bg-muted flex items-center justify-center relative">
          {!activeWebviewId ? (
            <div className="text-center">
              <Globe className="w-20 h-20 mx-auto text-primary/20 mb-4" />
              <p className="text-muted-foreground mb-4">
                Enter a URL and press Enter to start browsing
              </p>
              <button
                onClick={handleNavigate}
                className="px-4 py-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors text-sm"
              >
                Open Browser
              </button>
            </div>
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-muted-foreground text-sm">
              WebContentsView renders natively here
            </div>
          )}
        </div>

        {/* Right control panel */}
        <div className="w-72 border-l border-border bg-card overflow-y-auto p-4 flex flex-col gap-4">
          {/* Screenshot preview */}
          {screenshot && (
            <div>
              <h3 className="text-xs font-semibold text-muted-foreground uppercase mb-2">
                Last Screenshot
              </h3>
              <img
                src={screenshot}
                alt="Browser screenshot"
                className="rounded-lg border border-border w-full"
              />
            </div>
          )}

          {/* Profile selector */}
          <div>
            <h3 className="text-xs font-semibold text-muted-foreground uppercase mb-2">
              Browser Profile
            </h3>
            {profiles.length === 0 ? (
              <p className="text-xs text-muted-foreground">No profiles imported yet</p>
            ) : (
              <div className="flex flex-col gap-1">
                {profiles.map((p: any) => (
                  <button
                    key={p.name}
                    onClick={() => api?.switchBrowserProfile(p.name)}
                    className="text-left text-sm px-3 py-2 rounded-lg hover:bg-muted transition-colors"
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Current URL info */}
          <div>
            <h3 className="text-xs font-semibold text-muted-foreground uppercase mb-2">
              Current Page
            </h3>
            <div className="flex items-center gap-2 text-xs text-muted-foreground break-all">
              <ExternalLink className="w-3 h-3 flex-shrink-0" />
              {url}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
