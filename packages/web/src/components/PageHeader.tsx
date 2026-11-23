import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useStore } from '../store';
import { useNewLayout } from '../lib/newLayout';
import { Button, Tooltip } from './ui';

export const useNewPages = useNewLayout;

export function PageHeader({ title, sub, actions, leading, titleAside, tabs }: {
  title: string;
  sub: string;
  actions?: ReactNode;
  leading?: ReactNode;
  titleAside?: ReactNode;
  tabs?: ReactNode;
}) {
  const closePage = useStore((s) => s.closePage);
  const fresh = useNewPages();
  const back = <Tooltip content="Back to chat"><Button variant="ghost" size="icon" aria-label="Back to chat" onClick={closePage}><ArrowLeft size={16} /></Button></Tooltip>;
  if (!fresh) {
    return (
      <header className="flex h-14 shrink-0 items-center gap-3 px-5 max-md:pl-14">
        {back}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-body font-semibold">{title}</h1>
          <div className="truncate text-hint text-muted">{sub}</div>
        </div>
        {actions && <div className="flex shrink-0 items-center gap-3">{actions}</div>}
      </header>
    );
  }
  return (
    <header className="shrink-0">
      <div className="flex min-h-16 flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2 max-md:pl-14">
        <div className="flex min-w-[min(100%,16rem)] flex-1 items-center gap-3">
          {back}
          {leading}
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="min-w-0 break-words text-title">{title}</h1>
              {titleAside}
            </div>
            <p className="text-hint text-muted">{sub}</p>
          </div>
        </div>
        {actions && <div className="ml-auto flex shrink-0 items-center gap-3">{actions}</div>}
      </div>
      {tabs}
    </header>
  );
}
