/** The hub never sends a saved key back, only whether one is set. */
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import type { SecretsStatus } from '@pocketrocket/shared';
import { api } from '../../lib/api';
import { Badge, Button, Field, Input, Label } from '../ui';
import { InlineError } from './parts';

const KNOWN_KEYS: Record<string, { label: string; description: string; placeholder: string }> = {
  ANTHROPIC_API_KEY: {
    label: 'Claude API key',
    description: 'Only needed without a Claude subscription.',
    placeholder: 'sk-ant-…',
  },
  GEMINI_API_KEY: {
    label: 'Gemini API key',
    description: 'Lets Gemini bots run routines and triggers. Without it, Gemini answers only messages you send.',
    placeholder: 'AIza…',
  },
  OPENAI_API_KEY: {
    label: 'OpenAI API key',
    description: 'Optional. Used by Codex bots.',
    placeholder: 'sk-…',
  },
  XAI_API_KEY: {
    label: 'xAI API key',
    description: 'Optional. Used by Grok bots.',
    placeholder: 'xai-…',
  },
};

export function ApiKeyField({ keyName, isSet, onSaved, onSave, label, description, placeholder, saveLabel, removable = true }: {
  keyName: string;
  isSet: boolean;
  onSaved?: (status: SecretsStatus['keys']) => void;
  onSave?: (value: string) => Promise<void>;
  label?: string;
  description?: ReactNode;
  placeholder?: string;
  saveLabel?: string;
  removable?: boolean;
}) {
  const known = KNOWN_KEYS[keyName] ?? (label ? { label, description: '', placeholder: placeholder ?? 'Not set' } : undefined);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const descriptionId = useId();
  const errorId = useId();

  const write = async (value: string) => {
    setBusy(true);
    setError(null);
    try {
      if (onSave) {
        await onSave(value);
      } else {
        const status = await api.secrets.update({ [keyName]: value });
        onSaved?.(status.keys);
      }
      setDraft('');
    } catch (err) {
      setError((err as Error).message || "Couldn't save the key. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (draft.trim()) void write(draft.trim());
  };

  return (
    <Field>
      <Label>{label ?? known?.label ?? keyName}</Label>
      <p id={descriptionId} className="-mt-1 mb-2 text-hint text-muted">
        {description ?? known?.description ?? 'Optional.'}{' '}
        {isSet && <Badge tone="ok">Saved</Badge>}
      </p>
      <form onSubmit={onSubmit} className="flex flex-wrap items-center gap-2">
        <Input
          type="password"
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 basis-56"
          placeholder={isSet ? 'Paste to replace saved key' : (placeholder ?? known?.placeholder ?? 'Not set')}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-describedby={error ? `${descriptionId} ${errorId}` : descriptionId}
        />
        <Button type="submit" disabled={!draft.trim() || busy}>{busy && draft ? 'Saving…' : (saveLabel ?? 'Save')}</Button>
        {isSet && removable && <Button variant="ghost" disabled={busy} onClick={() => void write('')}>Remove</Button>}
      </form>
      {error && <InlineError id={errorId}>{error}</InlineError>}
    </Field>
  );
}
