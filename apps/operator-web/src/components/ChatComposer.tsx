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
}: ChatComposerProps) {
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const [isExpanded, setIsExpanded] = React.useState(false);

  React.useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const maxHeight = isExpanded ? expandedMaxHeight : compactMaxHeight;
    textarea.style.height = '0px';
    const nextHeight = Math.min(textarea.scrollHeight, maxHeight);
    textarea.style.height = `${Math.max(nextHeight, minRows * 28)}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [value, isExpanded, compactMaxHeight, expandedMaxHeight, minRows]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      onSubmit();
    }
  };

  return (
    <div
      className={cn(
        'rounded-[28px] border border-border/70 bg-card/90 shadow-[0_24px_70px_-36px_rgba(15,23,42,0.4)] backdrop-blur-xl',
        'before:pointer-events-none before:absolute before:inset-x-6 before:top-0 before:h-px before:bg-gradient-to-r before:from-transparent before:via-white/60 before:to-transparent',
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
            minHeight: `${Math.max(minRows * 28, 44)}px`,
            maxHeight: `${isExpanded ? expandedMaxHeight : compactMaxHeight}px`,
          }}
        />
      </div>

      <div className="flex flex-wrap items-center gap-1.5 px-3 pb-3 pt-2 sm:px-4 sm:pb-3">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">{footerStart}</div>

        <div className="ml-auto flex items-center gap-1.5">
          <span className="hidden text-[11px] text-muted-foreground sm:inline">
            {shortcutHint}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => setIsExpanded(prev => !prev)}
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
