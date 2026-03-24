import React, { useState, useRef, useEffect } from 'react';

interface ResizableHandleProps {
  onResize: (deltaX: number) => void;
  onResizeStart?: () => void;
  onResizeEnd?: () => void;
  minWidth?: number;
  maxWidth?: number;
  side?: 'left' | 'right';
  className?: string;
}

export function ResizableHandle({
  onResize,
  onResizeStart,
  onResizeEnd,
  minWidth = 240,
  maxWidth = 640,
  side = 'right',
  className = '',
}: ResizableHandleProps) {
  const [isDragging, setIsDragging] = useState(false);
  const startX = useRef(0);
  const startWidth = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    startX.current = e.clientX;

    // Get current width from parent container
    if (containerRef.current?.parentElement) {
      const rect = containerRef.current.parentElement.getBoundingClientRect();
      startWidth.current = rect.width;
    }

    onResizeStart?.();
  };

  // Global mouse move and up handlers
  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const movement = e.clientX - startX.current;
      const deltaX = side === 'left' ? -movement : movement;
      const newWidth = Math.min(
        maxWidth,
        Math.max(minWidth, startWidth.current + deltaX)
      );

      onResize(newWidth - startWidth.current);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      onResizeEnd?.();
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, minWidth, maxWidth, onResize, onResizeEnd]);

  return (
    <div
      ref={containerRef}
      className={`absolute top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary/50 active:bg-primary transition-colors group ${
        isDragging ? 'bg-primary' : ''
      } ${side === 'left' ? 'left-0' : 'right-0'} ${className}`}
      onMouseDown={handleMouseDown}
    >
      {/* Visual indicator on hover */}
      <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
        <div className="w-1 h-8 bg-primary rounded-full" />
      </div>
    </div>
  );
}
