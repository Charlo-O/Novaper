import * as React from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface ChatComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder: string;
  disabled?: boolean;
  className?: string;
  footerStart?: React.ReactNode;
  footerEnd?: React.ReactNode;
  shortcutHint?: string;
  minRows?: number;
  compactMaxHeight?: number;
  expandedMaxHeight?: number;
  storageKey?: string;
}

export function ChatComposer({
  value,
  onChange,
  onSubmit,
  placeholder,
  disabled = false,
  className,
  footerStart,
  footerEnd,
  shortcutHint = 'Ctrl/Cmd + Enter',
  minRows = 1,
  compactMaxHeight = 168,
  expandedMaxHeight = 320,
  storageKey,
}: ChatComposerProps) {
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const [isExpanded, setIsExpanded] = React.useState(false);
  const resolvedMinHeight = Math.max(minRows * 28, 52);
  const resolvedExpandedMinHeight = Math.min(
    expandedMaxHeight,
    Math.max(compactMaxHeight, 220)
  );

  React.useEffect(() => {
    if (!storageKey || typeof window === 'undefined') {
      return;
    }

    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) {
        return;
      }

      const parsed = JSON.parse(raw) as {
        isExpanded?: boolean;
      };

      if (typeof parsed.isExpanded === 'boolean') {
        setIsExpanded(parsed.isExpanded);
      }
    } catch {
      // Ignore invalid persisted composer state.
    }
  }, [storageKey]);

  React.useEffect(() => {
    if (!storageKey || typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(
      storageKey,
      JSON.stringify({
        isExpanded,
      })
    );
  }, [isExpanded, storageKey]);

  React.useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const maxHeight = isExpanded ? expandedMaxHeight : compactMaxHeight;
    const minHeight = isExpanded ? resolvedExpandedMinHeight : resolvedMinHeight;
    textarea.style.height = '0px';
    const contentHeight = textarea.scrollHeight;
    const nextHeight = Math.min(Math.max(contentHeight, minHeight), maxHeight);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [
    value,
    isExpanded,
    compactMaxHeight,
    expandedMaxHeight,
    resolvedExpandedMinHeight,
    resolvedMinHeight,
  ]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      onSubmit();
    }
  };

  const handleToggleExpand = () => {
    if (isExpanded) {
      setIsExpanded(false);
      return;
    }

    setIsExpanded(true);
  };

  return (
    <div
      className={cn(
        'rounded-[28px] border border-border/70 bg-card',
        'relative overflow-hidden',
        className
      )}
    >
      <div className="px-4 pt-4 sm:px-5 sm:pt-5">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={event => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          rows={minRows}
          className={cn(
            'w-full resize-none border-none bg-transparent text-[15px] leading-7 text-foreground placeholder:text-muted-foreground/80',
            'focus:outline-none focus:ring-0'
          )}
          style={{
            minHeight: `${isExpanded ? resolvedExpandedMinHeight : resolvedMinHeight}px`,
            maxHeight: `${isExpanded ? expandedMaxHeight : compactMaxHeight}px`,
          }}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2 px-3 pb-3 pt-2 sm:px-4 sm:pb-3">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {footerStart}
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <span className="hidden text-[11px] text-muted-foreground sm:inline">
            {shortcutHint}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={handleToggleExpand}
            className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground"
            aria-label={isExpanded ? 'Collapse composer' : 'Expand composer'}
            title={isExpanded ? 'Collapse composer' : 'Expand composer'}
          >
            {isExpanded ? (
              <Minimize2 className="h-3.5 w-3.5" />
            ) : (
              <Maximize2 className="h-3.5 w-3.5" />
            )}
          </Button>
          {footerEnd}
        </div>
      </div>
    </div>
  );
}
