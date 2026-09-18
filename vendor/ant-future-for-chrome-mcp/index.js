// Local stub replacing the internal @ant/future-for-chrome-mcp package.
// Chrome MCP integration is not part of this standalone agent build.
export const BROWSER_TOOLS = []
export const DEFAULT_BROWSER_TOOL_NAMES = []
export const FUTURE_FOR_CHROME_MCP_SERVER_NAME = 'chrome'

export class FutureForChromeContext {
  static getSocketPaths() { return [] }
  constructor() { throw new Error('chrome-mcp not built into this agent') }
}

export async function createFutureForChromeMcpServer() {
  throw new Error('chrome-mcp not built into this agent')
}

export default { BROWSER_TOOLS }
