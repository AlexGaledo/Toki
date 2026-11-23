import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../ui';

export const ToolButtonShell = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string }>(
  function ToolButtonShell({ label, className, ...p }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        aria-label={label}
        className={cn('flex h-8 w-8 items-center justify-center rounded-full text-muted hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40 disabled:hover:bg-transparent pointer-coarse:h-10 pointer-coarse:w-10', className)}
        {...p}
      />
    );
  },
);
