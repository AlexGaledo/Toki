import { useState, type ReactNode } from 'react';
import { Check, Copy, Eye, EyeOff } from 'lucide-react';
import { cn } from '../ui';

export function SectionHeader({ title, description }: { title: string; description?: string }) {
  return (
    <header className="mb-5 sm:pr-10">
      <h2 className="text-title-sm">{title}</h2>
      {description && <p className="mt-0.5 text-ui text-muted">{description}</p>}
    </header>
  );
}

export function Group({ title, titleId, aside, className, children }: { title?: string; titleId?: string; aside?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={cn('mb-6 last:mb-0', className)}>
      {title && (
        <div className="mb-2 flex items-center justify-between gap-3">
          <h3 id={titleId} className="text-label text-fg">{title}</h3>
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('rounded-lg bg-card2/40 p-4 ring-1 ring-line', className)}>{children}</div>;
}

/** Home folded to `~`, anything else to its file name, so the machine's user name stays off a shared screen. */
export function shortPath(path: string): string {
  const home = /^(?:[A-Za-z]:[\\/]Users[\\/]|\/(?:home|Users)\/)[^\\/]+/;
  if (home.test(path)) return path.replace(home, '~');
  return path.split(/[\\/]/).pop() || path;
}

/**
 * Every home folder in a line of text folded to `~` (a command and its arguments), keeping the rest readable.
 * Windows paths ignore case, so `c:\users\<name>` is masked too.
 */
export function maskHome(text: string): string {
  return text.replace(/(?:[A-Za-z]:[\\/]Users[\\/]|\/(?:home|Users)\/)[^\\/\s"']+/gi, '~');
}

export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '•••';
  return email[0] + '•••' + email.slice(at);
}

/** Revealed and copied only on a deliberate press, so the full value never sits in a screenshot or shared screen. */
export function Private({ value, display, label, className }: { value: string; display: string; label: string; className?: string }) {
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  const RevealIcon = shown ? EyeOff : Eye;
  const button = 'inline-flex size-5 shrink-0 items-center justify-center rounded-xs text-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';
  return (
    <span className={cn('inline-flex max-w-full items-center gap-1 align-middle', className)}>
      <span className="min-w-0 break-all font-mono">{shown ? value : display}</span>
      <button type="button" className={button} aria-label={(shown ? 'Hide the full ' : 'Show the full ') + label} aria-pressed={shown} onClick={() => setShown((s) => !s)}>
        <RevealIcon size={13} aria-hidden />
      </button>
      <button
        type="button"
        className={button}
        aria-label={'Copy the full ' + label}
        onClick={() => {
          // Clipboard access can be refused (an insecure origin, a denied permission).
          void navigator.clipboard?.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }, () => undefined);
        }}
      >
        {copied ? <Check size={13} aria-hidden className="text-ok" /> : <Copy size={13} aria-hidden />}
      </button>
      <span role="status" className="sr-only">{copied ? 'Copied' : ''}</span>
    </span>
  );
}

export function InlineError({ id, children }: { id?: string; children: ReactNode }) {
  return <p id={id} role="alert" className="mt-2 text-hint leading-snug text-bad">{children}</p>;
}
