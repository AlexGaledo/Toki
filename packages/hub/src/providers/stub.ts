import type { ModelInfo, ProviderCheck, ProviderId, ProviderStaticInfo } from '@pocketrocket/shared';
import { EMPTY_USAGE, type AgentProvider, type TurnContext, type TurnOutcome, type TurnSink } from './types.js';

export class StubProvider implements AgentProvider {
  readonly id: ProviderId;
  readonly label: string;
  constructor(
    readonly info: ProviderStaticInfo,
    private staticModels: ModelInfo[],
    private hint: string,
  ) {
    this.id = info.id;
    this.label = info.label;
  }
  async models(): Promise<ModelInfo[]> {
    return this.staticModels;
  }
  modelsSync(): ModelInfo[] {
    return this.staticModels;
  }
  async check(): Promise<ProviderCheck> {
    return { ok: false, auth: 'unknown', error: 'Not implemented yet', hint: this.hint };
  }
  async runTurn(ctx: TurnContext, _sink: TurnSink): Promise<TurnOutcome> {
    void ctx;
    return {
      ok: false,
      error: 'The ' + this.label + ' provider is not implemented yet. Switch the provider in Settings.',
      costUsd: 0,
      usage: { ...EMPTY_USAGE },
      durationMs: 0,
    };
  }
  interrupt(turnId: string): boolean {
    void turnId;
    return false;
  }
}
