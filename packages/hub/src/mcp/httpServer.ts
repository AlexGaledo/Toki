import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { HOST, PORT, VERSION } from '../config.js';
import type { HubTool } from '../providers/types.js';

/** Each turn's bearer token dies with the turn. */
export class TurnRegistry {
  private turns = new Map<string, { tools: HubTool[]; guard?: ToolGuard }>();

  /** Carries the computer control interlock to providers that only reach hub tools over MCP. */
  registerTurn(tools: HubTool[], guard?: ToolGuard): string {
    const token = randomBytes(24).toString('base64url');
    this.turns.set(token, { tools, guard });
    return token;
  }
  guard(token: string): ToolGuard | undefined {
    return this.turns.get(token)?.guard;
  }
  unregister(token: string) {
    this.turns.delete(token);
  }
  tools(token: string): HubTool[] | undefined {
    return this.turns.get(token)?.tools;
  }
  get size() {
    return this.turns.size;
  }
  url(port: number = PORT): string {
    return 'http://' + HOST + ':' + port + '/mcp';
  }
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1] : null;
}

export type ToolGuard = (toolName: string) => string | null;

function buildServer(tools: HubTool[], guard?: ToolGuard): McpServer {
  const server = new McpServer({ name: 'pocketrocket', version: VERSION });
  for (const t of tools) {
    server.registerTool(
      t.name,
      {
        description: t.description,
        inputSchema: t.inputSchema.shape as never,
        annotations: t.readOnly ? { readOnlyHint: true } : undefined,
      },
      (async (args: unknown) => {
        const refused = guard?.(t.name);
        if (refused) return { content: [{ type: 'text', text: refused }], isError: true } as never;
        const out = await t.handler((args ?? {}) as Record<string, unknown>);
        return { content: out.content, isError: out.isError } as never;
      }) as never,
    );
  }
  return server;
}

export async function serveTools(tools: HubTool[], req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
  const server = buildServer(tools);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

/** Auth is the per-turn bearer token: no token, no tools. */
export function createMcpHandler(registry: TurnRegistry) {
  return async function handleMcp(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    const token = bearer(req);
    const tools = token ? registry.tools(token) : undefined;
    if (!tools) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Unknown or expired turn token. This call was not run. Do not retry it; this turn has ended, so finish without the tool or say so in the room.' }, id: null }));
      return;
    }
    const server = buildServer(tools, registry.guard(token!));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };
}
