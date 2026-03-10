import { createFileRoute } from '@tanstack/react-router';
import { useState, useEffect, useCallback, useRef } from 'react';
import { FileText, RefreshCw, AlertCircle, Radio } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '../lib/i18n-context';

interface LogFileInfo {
  name: string;
  size: number;
  modified: string;
}

interface LogEntry {
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  source: string;
  message: string;
  metadata?: unknown;
}

export const Route = createFileRoute('/logs')({
  component: LogsComponent,
});

function LogsComponent() {
  const t = useTranslation();
  const [logFiles, setLogFiles] = useState<LogFileInfo[]>([]);
  const [selectedLog, setSelectedLog] = useState<string | null>(null);
  const [logContent, setLogContent] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [contentLoading, setContentLoading] = useState(false);
  const [error, setError] = useState<string>('');
  const [liveMode, setLiveMode] = useState(false);
  const [liveEntries, setLiveEntries] = useState<LogEntry[]>([]);
  const liveRef = useRef<HTMLPreElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  const loadLogFiles = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const response = await fetch('/api/logs/files');
      if (!response.ok) throw new Error(`${response.status}`);
      const files: LogFileInfo[] = await response.json();
      setLogFiles(files);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      setError(t.logs.loadFailed.replace('{error}', errorMsg));
    } finally {
      setLoading(false);
    }
  }, [t.logs.loadFailed]);

  useEffect(() => {
    loadLogFiles();
  }, [loadLogFiles]);

  // Clean up SSE on unmount
  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
    };
  }, []);

  // Auto-scroll live logs
  useEffect(() => {
    if (liveMode && liveRef.current) {
      liveRef.current.scrollTop = liveRef.current.scrollHeight;
    }
  }, [liveEntries, liveMode]);

  const viewLogFile = async (filename: string) => {
    setContentLoading(true);
    setError('');
    setLiveMode(false);
    eventSourceRef.current?.close();
    try {
      const response = await fetch(`/api/logs/files/${encodeURIComponent(filename)}`);
      if (!response.ok) throw new Error(`${response.status}`);
      const content = await response.text();
      setSelectedLog(filename);
      setLogContent(content);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      setError(t.logs.readFailed.replace('{error}', errorMsg));
    } finally {
      setContentLoading(false);
    }
  };

  const toggleLiveMode = () => {
    if (liveMode) {
      // Turn off
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      setLiveMode(false);
      return;
    }

    // Turn on
    setLiveMode(true);
    setSelectedLog(null);
    setLiveEntries([]);

    const es = new EventSource('/api/logs/stream');
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const entry: LogEntry = JSON.parse(event.data);
        setLiveEntries(prev => {
          const next = [...prev, entry];
          if (next.length > 500) return next.slice(-500);
          return next;
        });
      } catch {
        // ignore parse errors
      }
    };

    es.onerror = () => {
      // EventSource will auto-reconnect
    };
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleString('zh-CN');
  };

  const getLevelColor = (level: string) => {
    switch (level) {
      case 'error':
        return 'text-red-500';
      case 'warn':
        return 'text-yellow-500';
      case 'info':
        return 'text-blue-400';
      default:
        return 'text-slate-400';
    }
  };

  const formatLogEntry = (entry: LogEntry) => {
    const time = entry.timestamp.slice(11, 23); // HH:mm:ss.SSS
    return `${time} [${entry.level.toUpperCase().padEnd(5)}] [${entry.source}] ${entry.message}`;
  };

  return (
    <div className="h-full flex">
      <div className="w-80 border-r border-slate-200 dark:border-slate-800 flex flex-col">
        <div className="p-4 border-b border-slate-200 dark:border-slate-800">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold">{t.logs.title}</h2>
            <Button
              variant="ghost"
              size="icon"
              onClick={loadLogFiles}
              disabled={loading}
              title={t.logs.refresh}
            >
              <RefreshCw
                className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`}
              />
            </Button>
          </div>
          <Button
            variant={liveMode ? 'default' : 'outline'}
            className="w-full"
            onClick={toggleLiveMode}
          >
            <Radio className={`w-4 h-4 mr-2 ${liveMode ? 'animate-pulse' : ''}`} />
            {liveMode ? '停止实时日志' : '实时日志流'}
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {logFiles.length === 0 ? (
            <div className="p-4 text-center text-slate-500 text-sm">
              {t.logs.noLogs}
            </div>
          ) : (
            <div className="divide-y divide-slate-200 dark:divide-slate-800">
              {logFiles.map(file => (
                <div
                  key={file.name}
                  className={`p-4 hover:bg-slate-50 dark:hover:bg-slate-900 cursor-pointer transition-colors ${
                    selectedLog === file.name
                      ? 'bg-slate-50 dark:bg-slate-900'
                      : ''
                  }`}
                  onClick={() => viewLogFile(file.name)}
                >
                  <div className="flex items-start gap-3">
                    <FileText className="w-5 h-5 text-slate-400 flex-shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm truncate">
                        {file.name}
                      </div>
                      <div className="text-xs text-slate-500 mt-1">
                        {formatFileSize(file.size)} •{' '}
                        {formatDate(file.modified)}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 flex flex-col">
        {liveMode ? (
          <>
            <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2">
              <Radio className="w-4 h-4 text-red-500 animate-pulse" />
              <h3 className="font-semibold">实时日志</h3>
              <span className="text-xs text-slate-500">({liveEntries.length} 条)</span>
            </div>
            <pre
              ref={liveRef}
              className="flex-1 overflow-auto p-4 bg-slate-950 text-xs font-mono"
            >
              {liveEntries.map((entry, i) => (
                <div key={i} className={getLevelColor(entry.level)}>
                  {formatLogEntry(entry)}
                </div>
              ))}
            </pre>
          </>
        ) : selectedLog ? (
          <>
            <div className="p-4 border-b border-slate-200 dark:border-slate-800">
              <h3 className="font-semibold">{selectedLog}</h3>
            </div>
            <div className="flex-1 overflow-auto p-4 bg-slate-50 dark:bg-slate-950">
              {contentLoading ? (
                <div className="flex items-center justify-center h-full">
                  <div className="text-slate-500">{t.logs.loading}</div>
                </div>
              ) : (
                <pre className="text-xs font-mono whitespace-pre-wrap break-all">
                  {logContent}
                </pre>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-slate-500">
            <div className="text-center">
              <FileText className="w-12 h-12 mx-auto mb-4 text-slate-300" />
              <p>{t.logs.selectLog}</p>
            </div>
          </div>
        )}
      </div>

      {error && (
        <div className="fixed bottom-4 right-4 max-w-md bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4 shadow-lg">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
            <div className="flex-1 text-sm text-red-600 dark:text-red-400">
              {error}
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-red-400 hover:text-red-600"
              onClick={() => setError('')}
            >
              ✕
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
