import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerAuthTools } from "./auth-tools.js";
import { registerCalendarTools } from "./calendar-tools.js";
import { registerChatTools } from "./chat-tools.js";
import { registerFilesTools } from "./files-tools.js";
import { registerMailTools } from "./mail-tools.js";
import { registerMeetingTools } from "./meeting-tools.js";
import { registerPresenceTools } from "./presence-tools.js";
import { registerProfileTools } from "./profile-tools.js";
import { registerSearchTools } from "./search-tools.js";
import { registerTeamsTools } from "./teams-tools.js";
import type { ToolDependencies } from "./tool-types.js";
import { registerUserTools } from "./user-tools.js";

export function registerAllTools(
  server: Pick<McpServer, "registerTool">,
  dependencies: ToolDependencies,
): void {
  registerAuthTools(server, dependencies);
  registerProfileTools(server, dependencies);
  registerChatTools(server, dependencies);
  registerTeamsTools(server, dependencies);
  registerCalendarTools(server, dependencies);
  registerMailTools(server, dependencies);
  registerUserTools(server, dependencies);
  registerPresenceTools(server, dependencies);
  registerSearchTools(server, dependencies);
  registerMeetingTools(server, dependencies);
  registerFilesTools(server, dependencies);
}
