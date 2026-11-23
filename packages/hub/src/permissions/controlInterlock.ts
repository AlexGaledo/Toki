import { DESKTOP_TOOL_NAMES } from '../agent/desktopTools.js';

/**
 * A safety interlock, not an approval: while the user has control of a bot's computer (or it is paused) its desktop
 * and Browser tools must not act. Holds under bypass too, at every layer a tool call passes through.
 */

/** True for the tools that drive a bot's computer: Playwright MCP (`mcp__browser__*`) and the desktop_* tools (fill_credential too: it types into that browser). */
export function isComputerTool(name: string): boolean {
  if (name.startsWith('mcp__browser__')) return true;
  const bare = name.startsWith('mcp__pocketrocket__') ? name.slice('mcp__pocketrocket__'.length) : name;
  return DESKTOP_TOOL_NAMES.includes(bare) || bare === 'fill_credential';
}

export function computerToolGuard(blockedReason: () => string | null): (toolName: string) => string | null {
  return (toolName) => (isComputerTool(toolName) ? blockedReason() : null);
}
