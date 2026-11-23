import type { ContentBlock, SessionUpdate, ToolCall, ToolCallContent, ToolCallUpdate } from '@agentclientprotocol/sdk';
import type { TurnSink } from '../types.js';

const MAX_TOOL_OUTPUT = 20_000;

export const COMPACTION_NOTE = 'compacted its conversation context to make room; earlier details may be summarised.';

export function blockText(b: ContentBlock | null | undefined): string {
  return b && b.type === 'text' ? b.text : '';
}

export function toolOutputText(u: Pick<ToolCallUpdate, 'content' | 'rawOutput'>): string {
  const parts: string[] = [];
  for (const c of (u.content ?? []) as ToolCallContent[]) {
    if (c.type === 'content') {
      const t = blockText(c.content);
      if (t) parts.push(t);
    } else if (c.type === 'diff') {
      parts.push('changed ' + c.path);
    } else if (c.type === 'terminal') {
      parts.push('(terminal ' + c.terminalId + ')');
    }
  }
  if (!parts.length && u.rawOutput !== undefined && u.rawOutput !== null) {
    parts.push(typeof u.rawOutput === 'string' ? u.rawOutput : JSON.stringify(u.rawOutput));
  }
  return parts.join('\n').slice(0, MAX_TOOL_OUTPUT);
}

function toolInput(u: Pick<ToolCall, 'title' | 'kind' | 'locations' | 'rawInput'>): unknown {
  if (u.rawInput !== undefined && u.rawInput !== null) return u.rawInput;
  return { title: u.title, ...(u.kind ? { kind: u.kind } : {}), ...(u.locations?.length ? { paths: u.locations.map((l) => l.path) } : {}) };
}

export class AcpEventMapper {
  contextTokens?: number;
  contextSize?: number;
  sessionCostUsd?: number;
  readonly notices: string[] = [];
  readonly warnings: string[] = [];
  answered = false;
  worked = false;
  muted = false;
  private block = '';
  private tools = new Map<string, { done: boolean }>();
  private compactions = new Set<string>();

  constructor(
    private sink: TurnSink,
    private splitWarnings?: (text: string) => { text: string; warnings: string[] },
  ) {}

  push(u: SessionUpdate): void {
    if (this.muted) return;
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        let t = blockText(u.content);
        if (!t) return;
        if (this.splitWarnings) {
          const s = this.splitWarnings(t);
          if (s.warnings.length) {
            this.warnings.push(...s.warnings);
            if (!s.text.trim()) return;
            t = s.text;
          }
        }
        if (!this.block) this.sink.onState('thinking');
        this.block += t;
        this.answered = true;
        this.worked = true;
        this.sink.onDelta(t);
        return;
      }
      case 'agent_thought_chunk':
        this.sink.onState('thinking');
        return;
      case 'tool_call': {
        this.flush();
        this.sink.onState('working');
        this.open(u.toolCallId, u.name ?? u.title, toolInput(u));
        this.settle(u.toolCallId, u);
        return;
      }
      case 'tool_call_update': {
        if (!this.tools.has(u.toolCallId)) {
          this.flush();
          this.open(u.toolCallId, u.name ?? u.title ?? 'tool', toolInput({ title: u.title ?? 'tool', kind: u.kind ?? undefined, locations: u.locations ?? undefined, rawInput: u.rawInput }));
        }
        this.settle(u.toolCallId, u);
        return;
      }
      case 'usage_update':
        this.contextTokens = u.used;
        this.contextSize = u.size;
        if (u.cost && /^usd$/i.test(u.cost.currency) && Number.isFinite(u.cost.amount)) this.sessionCostUsd = u.cost.amount;
        return;
      case 'notice':
        if (u.severity === 'error' || u.severity === 'warning') this.notices.push(u.title + (u.description ? ': ' + u.description : ''));
        return;
      case 'compaction_update':
        if (u.status !== 'completed' || this.compactions.has(u.compactionId)) return;
        this.compactions.add(u.compactionId);
        this.sink.onNote?.(COMPACTION_NOTE);
        return;
      default:
        return;
    }
  }

  flush(): void {
    if (this.block.trim()) this.sink.onText(this.block);
    this.block = '';
  }

  private open(id: string, name: string, input: unknown) {
    if (this.tools.has(id)) return;
    this.worked = true;
    this.tools.set(id, { done: false });
    this.sink.onToolUse(id, name, input);
  }

  private settle(id: string, u: Pick<ToolCallUpdate, 'status' | 'content' | 'rawOutput'>) {
    const t = this.tools.get(id);
    if (!t || t.done || (u.status !== 'completed' && u.status !== 'failed')) return;
    t.done = true;
    this.sink.onToolResult(id, toolOutputText(u), u.status === 'failed');
  }
}
