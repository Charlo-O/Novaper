import React from 'react';
import { Link, useMatchRoute } from '@tanstack/react-router';
import {
  Clock,
  FileText,
  History,
  ListChecks,
  MessageSquare,
  Puzzle,
  Settings,
  type LucideIcon,
} from 'lucide-react';

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useLocalStorage } from '../hooks/useLocalStorage';
import { useViewportWidth } from '../hooks/useViewportWidth';
import { useTranslation } from '../lib/i18n-context';

interface NavigationItem {
  id: string;
  icon: LucideIcon;
  label: string;
  path: string;
}

interface NavigationSidebarProps {
  className?: string;
}

const NAV_BREAKPOINT = 1180;

export function NavigationSidebar({ className }: NavigationSidebarProps) {
  const t = useTranslation();
  const matchRoute = useMatchRoute();
  const viewportWidth = useViewportWidth();
  const isCompactViewport = viewportWidth < NAV_BREAKPOINT;
  const [isCollapsedDesktop, setIsCollapsedDesktop] = useLocalStorage(
    'navigation-sidebar-collapsed',
    false
  );
  const [isOpenCompact, setIsOpenCompact] = React.useState(false);

  React.useEffect(() => {
    if (isCompactViewport) {
      setIsOpenCompact(false);
    }
  }, [isCompactViewport]);

  React.useEffect(() => {
    const handleToggle = () => {
      if (isCompactViewport) {
        setIsOpenCompact(prev => !prev);
        return;
      }
      setIsCollapsedDesktop(prev => !prev);
    };

    window.addEventListener(
      'novaper:toggle-navigation',
      handleToggle as EventListener
    );

    return () => {
      window.removeEventListener(
        'novaper:toggle-navigation',
        handleToggle as EventListener
      );
    };
  }, [isCompactViewport, setIsCollapsedDesktop]);

  const navigationItems: NavigationItem[] = [
    {
      id: 'chat',
      icon: MessageSquare,
      label: t.navigation.chat,
      path: '/chat',
    },
    {
      id: 'workflows',
      icon: ListChecks,
      label: t.navigation.workflows,
      path: '/workflows',
    },
    {
      id: 'history',
      icon: History,
      label: t.navigation.history || '历史记录',
      path: '/history',
    },
    {
      id: 'scheduled-tasks',
      icon: Clock,
      label: t.navigation.scheduledTasks || '定时任务',
      path: '/scheduled-tasks',
    },
    {
      id: 'plugins',
      icon: Puzzle,
      label: t.navigation.plugins,
      path: '/plugins',
    },
    {
      id: 'logs',
      icon: FileText,
      label: t.navigation.logs,
      path: '/logs',
    },
    {
      id: 'settings',
      icon: Settings,
      label: t.navigation.settings || 'Settings',
      path: '/settings',
    },
  ];

  const isHidden = isCompactViewport ? !isOpenCompact : isCollapsedDesktop;

  return (
    <>
      {isCompactViewport && isOpenCompact ? (
        <button
          type="button"
          className="absolute inset-0 z-30 bg-slate-950/20 backdrop-blur-[1px]"
          aria-label="Close navigation overlay"
          onClick={() => setIsOpenCompact(false)}
        />
      ) : null}

      {isHidden ? <div className="w-0 flex-shrink-0" /> : null}

      <nav
        className={cn(
          'flex h-full flex-col border-r border-slate-200/80 bg-white dark:border-slate-800/80 dark:bg-slate-950',
          'transition-[width,transform,opacity] duration-300 ease-out',
          'w-[72px] flex-shrink-0',
          isCompactViewport
            ? 'absolute inset-y-3 left-3 z-40 rounded-[24px] border'
            : 'relative',
          isHidden
            ? 'pointer-events-none w-0 -translate-x-6 opacity-0'
            : 'translate-x-0 opacity-100',
          className
        )}
        aria-hidden={isHidden}
      >
        <div className="flex flex-1 flex-col items-center gap-2 px-3 py-4">
          <div className="mb-5 flex w-full items-center justify-center">
            <Tooltip>
              <TooltipTrigger asChild>
                <Link to="/chat" className="block">
                  <img
                    src="/brand-mark.svg"
                    alt="Novaper Logo"
                    className="h-10 w-10 object-contain transition-opacity hover:opacity-80"
                  />
                </Link>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={8}>
                返回首页
              </TooltipContent>
            </Tooltip>
          </div>

          {navigationItems.map(item => {
            const Icon = item.icon;
            const isActive = matchRoute({ to: item.path });

            return (
              <Tooltip key={item.id}>
                <TooltipTrigger asChild>
                  <Link
                    to={item.path}
                    className={cn(
                      'flex h-11 w-11 items-center justify-center rounded-2xl transition-all',
                      isActive
                        ? 'bg-[#1d9bf0]/12 text-[#1d9bf0] shadow-[0_14px_30px_-20px_rgba(29,155,240,0.7)]'
                        : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100'
                    )}
                  >
                    <Icon className="h-5 w-5" />
                  </Link>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={8}>
                  {item.label}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>

      </nav>
    </>
  );
}
