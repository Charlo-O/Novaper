import React, { useRef, useEffect, useCallback, useState } from 'react';
import { ScrcpyPlayer } from './ScrcpyPlayer';
import { WidthControl } from './WidthControl';
import { ResizableHandle } from './ResizableHandle';
import { useLocalStorage } from '../hooks/useLocalStorage';
import { useViewportWidth } from '../hooks/useViewportWidth';
import type { ScreenshotResponse } from '../api';
import { getLiveSessionId, getScreenshot } from '../api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { useTranslation } from '../lib/i18n-context';
import { useElectron } from '../hooks/useElectron';
import {
  Video,
  Image as ImageIcon,
  MonitorPlay,
  Globe,
  ChevronLeft,
  ChevronRight,
  Fingerprint,
  ArrowUpDown,
  AlertCircle,
  CheckCircle2,
  Loader2,
  X,
} from 'lucide-react';
import {
  shouldShowWebCodecsWarning,
  dismissWebCodecsWarning,
} from '../lib/webcodecs-utils';

// Adapted for Novaper integration.

interface DeviceMonitorProps {
  deviceId: string;
  serial?: string;
  connectionType?: string;
  isVisible?: boolean;
  isTaskActive?: boolean;
  isCollapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  className?: string;
  /** Live session ID for SSE frame streaming */
  liveSessionId?: string;
}

export function DeviceMonitor({
  deviceId,
  serial: _serial,
  connectionType,
  isVisible = true,
  isTaskActive = false,
  isCollapsed = false,
  onCollapsedChange,
  className = '',
  liveSessionId,
}: DeviceMonitorProps) {
  const t = useTranslation();
  const { api, isElectron } = useElectron();

  const isRemoteDevice = connectionType === 'remote';
  const viewportWidth = useViewportWidth();
  const [screenshot, setScreenshot] = useState<ScreenshotResponse | null>(null);
  const [useVideoStream, setUseVideoStream] = useState(!isRemoteDevice);
  const [videoStreamFailed, setVideoStreamFailed] = useState(true);
  const [displayMode, setDisplayMode] = useState<
    'auto' | 'video' | 'screenshot' | 'live' | 'browser'
  >(isRemoteDevice ? 'screenshot' : 'auto');
  const [resolvedLiveSessionId, setResolvedLiveSessionId] = useState<
    string | undefined
  >(() => liveSessionId ?? getLiveSessionId('classic') ?? getLiveSessionId('layered') ?? undefined);
  const [shownWebviewIds, setShownWebviewIds] = useState<string[]>([]);
  const liveCanvasRef = useRef<HTMLCanvasElement>(null);
  const liveEventSourceRef = useRef<EventSource | null>(null);
  const browserHostRef = useRef<HTMLDivElement>(null);
  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null);
  const [feedbackType, setFeedbackType] = useState<
    'tap' | 'swipe' | 'error' | 'success'
  >('success');
  const [showControlArea, setShowControlArea] = useState(false);
  const [showControls, setShowControls] = useState(false);
  const [panelWidth, setPanelWidth] = useLocalStorage<number | 'auto'>(
    'device-monitor-width',
    360
  );
  const [fallbackReason, setFallbackReason] = useState<string | null>(null);
  const [showWebCodecsWarning, setShowWebCodecsWarning] = useState(false);

  const videoStreamRef = useRef<{ close: () => void } | null>(null);
  const screenshotFetchingRef = useRef(false);
  const feedbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controlsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCompactRef = useRef<boolean | null>(null);
  const effectiveLiveSessionId =
    liveSessionId ??
    resolvedLiveSessionId ??
    getLiveSessionId('classic') ??
    getLiveSessionId('layered') ??
    undefined;
  const hasEmbeddedBrowser = isElectron && shownWebviewIds.length > 0;

  const collapseThreshold = viewportWidth < 1280 ? 220 : 156;

  const showFeedback = (
    message: string,
    duration = 2000,
    type: 'tap' | 'swipe' | 'error' | 'success' = 'success'
  ) => {
    if (feedbackTimeoutRef.current) {
      clearTimeout(feedbackTimeoutRef.current);
    }
    setFeedbackType(type);
    setFeedbackMessage(message);
    feedbackTimeoutRef.current = setTimeout(() => {
      setFeedbackMessage(null);
    }, duration);
  };

  const handleMouseEnter = () => {
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
    }
    setShowControlArea(true);
  };

  const handleMouseLeave = () => {
    controlsTimeoutRef.current = setTimeout(() => {
      setShowControlArea(false);
    }, 500);
  };

  const toggleControls = () => {
    setShowControls(prev => !prev);
  };

  const handleWidthChange = (width: number | 'auto') => {
    if (width === 'auto') {
      onCollapsedChange?.(false);
    }
    setPanelWidth(width);
  };

  const handleResize = (deltaX: number) => {
    const baseWidth =
      typeof panelWidth === 'number' ? panelWidth : Math.min(480, viewportWidth * 0.3);
    const newWidth = Math.min(640, Math.max(0, baseWidth + deltaX));

    if (newWidth <= collapseThreshold) {
      onCollapsedChange?.(true);
      return;
    }

    if (isCollapsed) {
      onCollapsedChange?.(false);
    }
    setPanelWidth(newWidth);
  };

  const handleVideoStreamReady = useCallback(
    (stream: { close: () => void } | null) => {
      videoStreamRef.current = stream;
    },
    []
  );

  const handleFallback = useCallback(
    (reason?: string) => {
      setVideoStreamFailed(true);
      setUseVideoStream(false);
      setFallbackReason(reason || null);

      // Show warning only when user actively chose video mode
      if (displayMode === 'video' && reason && shouldShowWebCodecsWarning()) {
        setShowWebCodecsWarning(true);
      }
    },
    [displayMode]
  );

  const toggleDisplayMode = (
    mode: 'auto' | 'video' | 'screenshot' | 'live' | 'browser'
  ) => {
    setDisplayMode(mode);
  };

  const syncShownWebviews = useCallback(async () => {
    if (!api) {
      setShownWebviewIds([]);
      return;
    }

    try {
      const ids = await api.getShowWebview();
      setShownWebviewIds(
        Array.isArray(ids)
          ? ids.filter((id): id is string => typeof id === 'string')
          : []
      );
    } catch {
      setShownWebviewIds([]);
    }
  }, [api]);

  const syncBrowserBounds = useCallback(async () => {
    if (!api || !browserHostRef.current) {
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
  }, [api]);

  useEffect(() => {
    if (liveSessionId) {
      setResolvedLiveSessionId(liveSessionId);
    }
  }, [liveSessionId]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const syncLiveSession = () => {
      setResolvedLiveSessionId(
        liveSessionId ??
          getLiveSessionId('classic') ??
          getLiveSessionId('layered') ??
          undefined
      );
    };

    syncLiveSession();
    const handleLiveSessionChange = () => {
      syncLiveSession();
    };

    window.addEventListener(
      'novaper-live-session-changed',
      handleLiveSessionChange as EventListener
    );
    return () => {
      window.removeEventListener(
        'novaper-live-session-changed',
        handleLiveSessionChange as EventListener
      );
    };
  }, [liveSessionId]);

  useEffect(() => {
    void syncShownWebviews();
  }, [syncShownWebviews]);

  useEffect(() => {
    if (!api) {
      return;
    }

    const cleanupShow = api.onWebviewShow((id: string) => {
      setShownWebviewIds(prev => (prev.includes(id) ? prev : [...prev, id]));
      setDisplayMode('browser');
    });
    const cleanupHide = api.onWebviewHide((id: string) => {
      setShownWebviewIds(prev => prev.filter(existingId => existingId !== id));
    });

    return () => {
      cleanupShow();
      cleanupHide();
    };
  }, [api]);

  useEffect(() => {
    if (displayMode !== 'browser' || shownWebviewIds.length > 0) {
      return;
    }

    setDisplayMode(
      effectiveLiveSessionId ? 'live' : isRemoteDevice ? 'screenshot' : 'auto'
    );
  }, [displayMode, effectiveLiveSessionId, isRemoteDevice, shownWebviewIds.length]);

  useEffect(() => {
    if (
      isCollapsed ||
      displayMode !== 'live' ||
      !effectiveLiveSessionId ||
      !isVisible
    ) {
      liveEventSourceRef.current?.close();
      liveEventSourceRef.current = null;
      return;
    }

    const es = new EventSource(
      `/api/live-sessions/${effectiveLiveSessionId}/screen-stream`
    );
    liveEventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as {
          image: string;
          width: number;
          height: number;
        };
        const canvas = liveCanvasRef.current;
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const img = new Image();
        img.onload = () => {
          canvas.width = data.width;
          canvas.height = data.height;
          ctx.drawImage(img, 0, 0);
        };
        img.src = `data:image/png;base64,${data.image}`;
      } catch {
        // ignore
      }
    };

    return () => {
      es.close();
      liveEventSourceRef.current = null;
    };
  }, [displayMode, effectiveLiveSessionId, isVisible, isCollapsed]);

  useEffect(() => {
    if (!api) {
      return;
    }

    if (
      !isVisible ||
      isCollapsed ||
      displayMode !== 'browser' ||
      shownWebviewIds.length === 0
    ) {
      shownWebviewIds.forEach(id => {
        void api.hideWebView(id);
      });
      return;
    }

    shownWebviewIds.forEach(id => {
      void api.showWebview(id);
    });
    void syncBrowserBounds();

    const host = browserHostRef.current;
    if (!host) {
      return;
    }

    const resizeObserver = new ResizeObserver(() => {
      void syncBrowserBounds();
    });
    resizeObserver.observe(host);

    const handleWindowResize = () => {
      void syncBrowserBounds();
    };
    window.addEventListener('resize', handleWindowResize);

    const frameId = window.requestAnimationFrame(() => {
      void syncBrowserBounds();
    });

    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener('resize', handleWindowResize);
      resizeObserver.disconnect();
    };
  }, [
    api,
    displayMode,
    isCollapsed,
    isVisible,
    shownWebviewIds,
    syncBrowserBounds,
  ]);

  useEffect(() => {
    return () => {
      if (feedbackTimeoutRef.current) {
        clearTimeout(feedbackTimeoutRef.current);
      }
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current);
      }
      if (videoStreamRef.current) {
        videoStreamRef.current.close();
      }
      if (liveEventSourceRef.current) {
        liveEventSourceRef.current.close();
      }
      if (api) {
        shownWebviewIds.forEach(id => {
          void api.hideWebView(id);
        });
      }
    };
  }, [api, shownWebviewIds]);

  useEffect(() => {
    const isCompactViewport = viewportWidth < 1180;
    if (lastCompactRef.current === isCompactViewport) {
      return;
    }

    if (isCompactViewport) {
      onCollapsedChange?.(true);
    }

    lastCompactRef.current = isCompactViewport;
  }, [onCollapsedChange, viewportWidth]);

  useEffect(() => {
    if (!deviceId || !isVisible || isCollapsed || !isTaskActive) return;

    const shouldPollScreenshots =
      displayMode === 'screenshot' ||
      (displayMode === 'auto' && videoStreamFailed);

    if (!shouldPollScreenshots) {
      return;
    }

    const fetchScreenshot = async () => {
      if (screenshotFetchingRef.current) return;

      screenshotFetchingRef.current = true;
      try {
        const data = await getScreenshot(deviceId);
        if (data.success) {
          setScreenshot(data);
        }
      } catch (e) {
        console.error('Failed to fetch screenshot:', e);
      } finally {
        screenshotFetchingRef.current = false;
      }
    };

    fetchScreenshot();
    const interval = setInterval(fetchScreenshot, 500);

    return () => clearInterval(interval);
  }, [
    deviceId,
    videoStreamFailed,
    displayMode,
    isVisible,
    isCollapsed,
    isTaskActive,
  ]);

  const getReasonMessage = (reason: string): string => {
    const messages: Record<string, string> = {
      insecure_context:
        t.deviceMonitor?.requireHttpsOrLocalhost ||
        '视频流需要 HTTPS 或 localhost 环境。建议下载桌面应用以获得完整功能。',
      browser_unsupported:
        t.deviceMonitor?.browserNotSupported ||
        '当前浏览器不支持 WebCodecs API。请使用最新版 Chrome 或 Edge 浏览器。',
      decoder_error:
        t.deviceMonitor?.decoderInitFailed || '视频解码器初始化失败。',
      decoder_unsupported:
        t.deviceMonitor?.codecNotSupported || '设备编解码器不支持。',
    };
    return messages[reason] || t.deviceMonitor?.unknownError || '未知错误';
  };

  const widthStyle =
    typeof panelWidth === 'number' ? `${panelWidth}px` : 'auto';

  if (isCollapsed) {
    return null;
  }

  return (
    <Card
      className={`relative min-h-0 flex-shrink-0 overflow-hidden bg-background ${className}`}
      style={{
        width: widthStyle,
        minWidth: typeof panelWidth === 'number' ? undefined : '240px',
        maxWidth: typeof panelWidth === 'number' ? undefined : '640px',
      }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* Resizable handle - left edge */}
      {typeof panelWidth === 'number' && (
        <ResizableHandle
          onResize={handleResize}
          minWidth={0}
          maxWidth={640}
          side="left"
          className="z-20"
        />
      )}
      {/* Toggle and controls - shown on hover */}
      <div
        className={`absolute top-4 right-4 z-10 transition-opacity duration-200 ${
          showControlArea ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      >
        <div className="flex items-start gap-2">
          {/* Combined controls container - both controls slide together */}
          <div
            className={`flex flex-col items-end gap-2 transition-all duration-300 ${
              showControls
                ? 'opacity-100 translate-x-0'
                : 'opacity-0 translate-x-4 pointer-events-none'
            }`}
          >
            {/* Display mode controls */}
            <div className="flex items-center gap-1 rounded-xl border border-border bg-background p-1">
              {!isRemoteDevice && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => toggleDisplayMode('auto')}
                  className={`h-7 px-3 text-xs rounded-lg transition-colors ${
                    displayMode === 'auto'
                      ? 'bg-primary text-primary-foreground'
                      : 'text-foreground hover:bg-accent hover:text-accent-foreground'
                  }`}
                >
                  {t.devicePanel?.auto || 'Auto'}
                </Button>
              )}
              {!isRemoteDevice && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => toggleDisplayMode('video')}
                  className={`h-7 px-3 text-xs rounded-lg transition-colors ${
                    displayMode === 'video'
                      ? 'bg-primary text-primary-foreground'
                      : 'text-foreground hover:bg-accent hover:text-accent-foreground'
                  }`}
                >
                  <Video className="w-3 h-3 mr-1" />
                  {t.devicePanel?.video || 'Video'}
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => toggleDisplayMode('screenshot')}
                className={`h-7 px-3 text-xs rounded-lg transition-colors ${
                  displayMode === 'screenshot'
                    ? 'bg-primary text-primary-foreground'
                    : 'text-foreground hover:bg-accent hover:text-accent-foreground'
                }`}
              >
                <ImageIcon className="w-3 h-3 mr-1" />
                {t.devicePanel?.image || 'Image'}
              </Button>
              {effectiveLiveSessionId && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => toggleDisplayMode('live')}
                  className={`h-7 px-3 text-xs rounded-lg transition-colors ${
                    displayMode === 'live'
                      ? 'bg-primary text-primary-foreground'
                      : 'text-foreground hover:bg-accent hover:text-accent-foreground'
                  }`}
                >
                  <MonitorPlay className="w-3 h-3 mr-1" />
                  Live
                </Button>
              )}
              {isElectron && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => toggleDisplayMode('browser')}
                  disabled={!hasEmbeddedBrowser}
                  className={`h-7 px-3 text-xs rounded-lg transition-colors ${
                    displayMode === 'browser'
                      ? 'bg-primary text-primary-foreground'
                      : 'text-foreground hover:bg-accent hover:text-accent-foreground'
                  } ${!hasEmbeddedBrowser ? 'opacity-50' : ''}`}
                >
                  <Globe className="w-3 h-3 mr-1" />
                  DOM
                </Button>
              )}
            </div>

            {/* Width controls - aligned with display mode controls */}
            <WidthControl
              currentWidth={panelWidth}
              onWidthChange={handleWidthChange}
            />
          </div>

          {/* Toggle button - always visible in top-right */}
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleControls}
            className="h-8 w-8 rounded-full border border-border bg-background hover:bg-accent"
            title={showControls ? 'Hide controls' : 'Show controls'}
          >
            {showControls ? (
              <ChevronRight className="w-4 h-4" />
            ) : (
              <ChevronLeft className="w-4 h-4" />
            )}
          </Button>
        </div>
      </div>

      {/* Current mode indicator - bottom left */}
      <div className="absolute bottom-4 left-4 z-10">
        <Badge
          variant="secondary"
          className="bg-white/90 text-slate-700 border border-slate-200 dark:bg-slate-900/90 dark:text-slate-300 dark:border-slate-700"
        >
          {displayMode === 'auto' && (t.devicePanel?.auto || 'Auto')}
          {displayMode === 'live' && (
            <>
              <MonitorPlay className="w-3 h-3 mr-1" />
              Live
            </>
          )}
          {displayMode === 'browser' && (
            <>
              <Globe className="w-3 h-3 mr-1" />
              DOM
            </>
          )}
          {displayMode === 'video' && (
            <>
              <MonitorPlay className="w-3 h-3 mr-1" />
              {t.devicePanel?.video || 'Video'}
            </>
          )}
          {displayMode === 'screenshot' && (
            <>
              <ImageIcon className="w-3 h-3 mr-1" />
              {t.devicePanel?.imageRefresh || 'Screenshot'}
            </>
          )}
        </Badge>
      </div>

      {/* Feedback message */}
      {feedbackMessage && (
        <div className="absolute bottom-4 right-4 z-20 flex items-center gap-2 px-3 py-2 bg-[#1d9bf0] text-white text-sm rounded-xl shadow-lg">
          {feedbackType === 'error' && <AlertCircle className="w-4 h-4" />}
          {feedbackType === 'tap' && <Fingerprint className="w-4 h-4" />}
          {feedbackType === 'swipe' && <ArrowUpDown className="w-4 h-4" />}
          {feedbackType === 'success' && <CheckCircle2 className="w-4 h-4" />}
          <span>{feedbackMessage}</span>
        </div>
      )}

      {displayMode === 'browser' ? (
        <div className="relative h-full w-full min-h-0 bg-muted/20">
          <div className="absolute inset-x-4 top-16 bottom-14 overflow-hidden rounded-2xl border border-border bg-background/90 shadow-sm">
            <div ref={browserHostRef} className="h-full w-full" />
            {!hasEmbeddedBrowser && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                Waiting for embedded browser session...
              </div>
            )}
          </div>
        </div>
      ) : /* Live frame stream via SSE */
      displayMode === 'live' && effectiveLiveSessionId ? (
        <div className="w-full h-full flex items-center justify-center bg-muted/30 min-h-0">
          <canvas
            ref={liveCanvasRef}
            className="max-w-full max-h-full object-contain"
          />
        </div>
      ) : /* Video stream */
      displayMode === 'video' ||
      (displayMode === 'auto' && useVideoStream && !videoStreamFailed) ? (
        <>
          {/* WebCodecs unavailability warning banner */}
          {showWebCodecsWarning && fallbackReason && (
            <div className="absolute top-0 left-0 right-0 z-20 bg-amber-50/95 dark:bg-amber-950/95 border-b border-amber-200 dark:border-amber-800 backdrop-blur-sm">
              <div className="px-4 py-3 flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                <div className="flex-1 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-medium text-amber-900 dark:text-amber-100">
                      {t.deviceMonitor?.videoUnavailableWarning ||
                        '视频流不可用'}
                    </p>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5 -mr-2 hover:bg-amber-100 dark:hover:bg-amber-900"
                      onClick={() => {
                        setShowWebCodecsWarning(false);
                        dismissWebCodecsWarning();
                      }}
                    >
                      <X className="w-3 h-3" />
                    </Button>
                  </div>
                  <p className="text-xs text-amber-700 dark:text-amber-300">
                    {getReasonMessage(fallbackReason)}
                  </p>
                  {fallbackReason === 'insecure_context' && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() =>
                        window.open(
                          'https://github.com/Charlo-O/Novaper/releases',
                          '_blank'
                        )
                      }
                    >
                      {t.deviceMonitor?.downloadElectron || '下载桌面应用'}
                    </Button>
                  )}
                </div>
              </div>
            </div>
          )}
          <ScrcpyPlayer
            deviceId={deviceId}
            className="w-full h-full"
            enableControl={true}
            onFallback={handleFallback}
            onTapSuccess={() =>
              showFeedback(t.devicePanel?.tapped || 'Tapped', 2000, 'tap')
            }
            onTapError={error =>
              showFeedback(
                (t.devicePanel?.tapError || 'Tap error: {error}').replace(
                  '{error}',
                  error
                ),
                3000,
                'error'
              )
            }
            onSwipeSuccess={() =>
              showFeedback(t.devicePanel?.swiped || 'Swiped', 2000, 'swipe')
            }
            onSwipeError={error =>
              showFeedback(
                (t.devicePanel?.swipeError || 'Swipe error: {error}').replace(
                  '{error}',
                  error
                ),
                3000,
                'error'
              )
            }
            onStreamReady={handleVideoStreamReady}
            fallbackTimeout={20000}
            isVisible={isVisible} // ✅ 新增：传递 isVisible prop
          />
        </>
      ) : (
        <div className="w-full h-full flex items-center justify-center bg-muted/30 min-h-0">
          {screenshot && screenshot.success ? (
            <div className="relative w-full h-full flex items-center justify-center min-h-0">
              <img
                src={`data:image/png;base64,${screenshot.image}`}
                alt="Device Screenshot"
                className="max-w-full max-h-full object-contain"
                style={{
                  width: screenshot.width > screenshot.height ? '100%' : 'auto',
                  height:
                    screenshot.width > screenshot.height ? 'auto' : '100%',
                }}
              />
              {screenshot.is_sensitive && (
                <div className="absolute top-12 right-2 px-2 py-1 bg-yellow-500 text-white text-xs rounded-lg">
                  {t.devicePanel?.sensitiveContent || 'Sensitive Content'}
                </div>
              )}
            </div>
          ) : screenshot?.error ? (
            <div className="text-center text-destructive">
              <AlertCircle className="w-8 h-8 mx-auto mb-2" />
              <p className="font-medium">
                {t.devicePanel?.screenshotFailed || 'Screenshot Failed'}
              </p>
              <p className="text-xs mt-1 opacity-60">{screenshot.error}</p>
            </div>
          ) : (
            <div className="text-center text-muted-foreground">
              {isTaskActive ? (
                <>
                  <Loader2 className="w-8 h-8 mx-auto mb-2 animate-spin" />
                  <p className="text-sm">
                    {t.devicePanel?.loading || 'Loading...'}
                  </p>
                </>
              ) : (
                <>
                  <ImageIcon className="mx-auto mb-2 h-8 w-8 opacity-50" />
                  <p className="text-sm">
                    {t.devicePanel?.readyToHelp || 'Ready to help'}
                  </p>
                  <p className="mt-1 text-xs opacity-70">
                    {t.devicePanel?.describeTask ||
                      'Start a task to refresh the device preview.'}
                  </p>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
