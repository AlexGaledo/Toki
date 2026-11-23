import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { CircleCheck, TriangleAlert } from 'lucide-react';
import type { ProviderCheck, ProviderInfo } from '@pocketrocket/shared';
import { Badge, Button, cn } from '../ui';
import { Markdown } from '../Markdown';
import { useRecheck } from '../ProviderCard';
import { Private, maskEmail, shortPath } from './parts';

/**
 * Not `npm install -g`: that leaves a claude.cmd shim in %APPDATA%\npm, while the hub looks for the native binary
 * in ~/.local/bin.
 */
const INSTALL_COMMANDS = [
  { id: 'windows', label: 'Windows (PowerShell)', command: 'irm https://claude.ai/install.ps1 | iex' },
  { id: 'unix', label: 'macOS or Linux (Terminal)', command: 'curl -fsSL https://claude.ai/install.sh | bash' },
] as const;

function installCommands() {
  const windows = /Windows/i.test(navigator.userAgent);
  return windows ? INSTALL_COMMANDS : [...INSTALL_COMMANDS].reverse();
}

type Tone = 'ok' | 'warn';

interface Summary {
  ok: boolean;
  tone: Tone;
  badge: string;
  headline: string;
  facts: ReactNode[];
}

/** Masked until asked for: Settings gets screen-shared. */
export function PrivateEmail({ email }: { email: string }) {
  return <Private value={email} display={maskEmail(email)} label="email address" />;
}

function PrivatePath({ path }: { path: string }) {
  return <Private value={path} display={shortPath(path)} label="path" />;
}

/** `claude --version` prints "2.1.3 (Claude Code)"; the parenthetical adds nothing here. */
function cleanVersion(version: string) {
  return version.replace(/\s*\(.*\)\s*$/, '');
}

export function authPhrase(check: ProviderCheck): string | null {
  if (check.auth === 'subscription') return check.plan ? 'Using your Claude ' + check.plan + ' subscription' : 'Using your Claude subscription';
  if (check.auth === 'apiKey') return 'Using your API key';
  return null;
}

function summarize(info: ProviderInfo): Summary {
  const { check } = info;
  const app = info.id === 'claude' ? 'Claude Code' : info.label;
  const facts: ReactNode[] = [];
  if (check.version) facts.push('Version ' + cleanVersion(check.version));
  if (check.ok) {
    const how = authPhrase(check);
    if (how) facts.push(how);
    if (check.account) facts.push(<PrivateEmail email={check.account} />);
    return { ok: true, tone: 'ok', badge: 'Ready', headline: app + ' is connected', facts };
  }
  if (check.unresponsive) return { ok: false, tone: 'warn', badge: "Didn't respond", headline: 'Found ' + app + " but it didn't respond", facts };
  if (check.version) return { ok: false, tone: 'warn', badge: 'Not signed in', headline: app + ' needs you to sign in', facts };
  return { ok: false, tone: 'warn', badge: 'Not found', headline: app + " isn't set up here yet", facts };
}

export function ConnectionStatus({ info, onChecked, hasKeyField, autoRecheckMs }: {
  info: ProviderInfo;
  onChecked: (check: ProviderCheck) => void;
  hasKeyField: boolean;
  autoRecheckMs?: number;
}) {
  const { checking, recheck } = useRecheck(info.id, onChecked);
  const summary = summarize(info);
  const Icon = summary.ok ? CircleCheck : TriangleAlert;

  const recheckRef = useRef(recheck);
  recheckRef.current = recheck;
  const [skipped, setSkipped] = useState(0);
  useEffect(() => {
    if (autoRecheckMs) void recheckRef.current();
  }, [autoRecheckMs]);
  useEffect(() => {
    if (!autoRecheckMs || summary.ok || checking) return;
    const timer = setTimeout(() => {
      if (document.visibilityState === 'visible') void recheckRef.current();
      else setSkipped((n) => n + 1);
    }, autoRecheckMs);
    return () => clearTimeout(timer);
  }, [autoRecheckMs, summary.ok, checking, info.check, skipped]);

  const checkButton = (className: string) => (
    <Button size="sm" className={className} onClick={() => void recheck()} disabled={checking}>
      {checking ? 'Checking…' : 'Check again'}
    </Button>
  );

  return (
    <div className="rounded-lg bg-card2/40 p-4 ring-1 ring-line">
      <div className="flex items-start gap-3">
        <Icon size={20} aria-hidden className={cn('mt-0.5 shrink-0', summary.ok ? 'text-ok' : 'text-warn')} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-ui font-medium">{summary.headline}</span>
            <Badge tone={summary.tone}>{summary.badge}</Badge>
          </div>
          {summary.facts.length > 0 && (
            <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-ui text-muted">
              {summary.facts.map((fact, i) => (
                <Fragment key={i}>
                  {i > 0 && <span aria-hidden>·</span>}
                  {fact}
                </Fragment>
              ))}
            </div>
          )}
          {!summary.ok && <FixSteps info={info} check={info.check} hasKeyField={hasKeyField} />}
          {checkButton('mt-3 sm:hidden')}
        </div>
        {checkButton('shrink-0 max-sm:hidden')}
      </div>
    </div>
  );
}

const codeLine = 'mt-1 block w-fit max-w-full select-all rounded-xs bg-card2 px-2 py-1 font-mono text-hint [overflow-wrap:anywhere]';

function FixSteps({ info, check, hasKeyField }: { info: ProviderInfo; check: ProviderCheck; hasKeyField: boolean }) {
  const installed = !!check.version || !!check.unresponsive;
  const hasTechnical = !!(check.error || check.hint);
  return (
    <div className="mt-3 text-ui leading-relaxed text-fg">
      {info.id === 'claude' && check.unresponsive ? (
        <p>
          Can be slow at first. Check again shortly.
          {check.exePath && <span className="mt-1 block text-muted">Found at <PrivatePath path={check.exePath} /></span>}
        </p>
      ) : info.id === 'claude' ? (
        <ol className="list-decimal space-y-1 pl-5">
          {!installed && (
            <li>
              Run this in a terminal:
              {installCommands().map((c) => (
                <div key={c.id} className="mt-1.5">
                  <span className="text-muted">{c.label}</span>
                  <code className={codeLine}>{c.command}</code>
                </div>
              ))}
              {check.exePath && (
                <span className="mt-1.5 block text-muted">
                  Looked in <PrivatePath path={check.exePath} />
                </span>
              )}
            </li>
          )}
          <li>
            Run <code className="rounded-xs bg-card2 px-1.5 py-0.5 font-mono text-hint">claude</code> once and sign in with your Claude account.
          </li>
          <li>Come back here and press Check again.</li>
        </ol>
      ) : (
        check.hint && <div className="md"><Markdown>{check.hint}</Markdown></div>
      )}
      {hasKeyField && info.id === 'claude' && !check.unresponsive && (
        <p className="mt-2 text-muted">No subscription? Add an API key below.</p>
      )}
      {hasTechnical && info.id === 'claude' && (
        <details className="mt-2 text-muted">
          <summary className="cursor-pointer select-none text-hint hover:text-fg">Technical details</summary>
          <div className="mt-1 space-y-1 text-hint text-dim">
            {/* The error can hold a Windows path; plain text keeps its backslashes intact. */}
            {check.error && <p className="break-all font-mono">{check.error}</p>}
            {check.hint && <div className="md"><Markdown>{check.hint}</Markdown></div>}
          </div>
        </details>
      )}
    </div>
  );
}
