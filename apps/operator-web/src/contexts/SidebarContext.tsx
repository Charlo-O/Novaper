import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

interface SidebarContextValue {
  leftOpen: boolean;
  rightOpen: boolean;
  toggleLeft: () => void;
  toggleRight: () => void;
}

const SidebarContext = createContext<SidebarContextValue>({
  leftOpen: true,
  rightOpen: true,
  toggleLeft: () => {},
  toggleRight: () => {},
});

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [leftOpen, setLeftOpen] = useState(() => {
    const stored = localStorage.getItem('novaper_sidebar_left');
    return stored !== 'false';
  });
  const [rightOpen, setRightOpen] = useState(() => {
    const stored = localStorage.getItem('novaper_sidebar_right');
    return stored !== 'false';
  });

  const toggleLeft = useCallback(() => {
    setLeftOpen(prev => {
      const next = !prev;
      localStorage.setItem('novaper_sidebar_left', String(next));
      return next;
    });
  }, []);

  const toggleRight = useCallback(() => {
    setRightOpen(prev => {
      const next = !prev;
      localStorage.setItem('novaper_sidebar_right', String(next));
      return next;
    });
  }, []);

  return (
    <SidebarContext.Provider value={{ leftOpen, rightOpen, toggleLeft, toggleRight }}>
      {children}
    </SidebarContext.Provider>
  );
}

export function useSidebar() {
  return useContext(SidebarContext);
}
