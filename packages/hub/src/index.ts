import { createHub } from './hub.js';
import { startWorkspaceWeb } from './api/workspaceWeb.js';
import { WORKSPACE_DIR, WORKSPACE_WEB_PORT } from './config.js';

// Bare allowedTools entries bypass canUseTool on purpose; file and shell tools are never pre-approved.
const origEmitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  if (String(warning).includes('canUseTool will not be invoked')) return;
  (origEmitWarning as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

const hub = createHub({ seedBots: true });
await hub.listen();
// Lets the Browser tool open HTML/images/PDFs from the workspace (Playwright MCP blocks file://).
await startWorkspaceWeb(WORKSPACE_DIR, WORKSPACE_WEB_PORT);

process.on('SIGINT', () => void hub.stop('SIGINT'));
process.on('SIGTERM', () => void hub.stop('SIGTERM'));
