export const TOOL_ICONS: Record<string, string> = {
  read_file: "📄",
  Read: "📄",
  write_to_file: "✍️",
  Write: "✍️",
  replace_in_file: "✏️",
  Edit: "✏️",
  execute_command: "⌨️",
  Bash: "⌨️",
  search_files: "🔍",
  Grep: "🔍",
  list_dir: "📁",
  List: "📁",
  list_code_definitions: "🏗️",
  ListCodeDefinitions: "🏗️",
  read_lints: "⚠️",
  ReadLints: "⚠️",
  codebase_search: "🔎",
  CodebaseSearch: "🔎",
  web_fetch: "🌐",
  WebFetch: "🌐",
  web_search: "🌍",
  WebSearch: "🌍",
  glob: "📋",
  Glob: "📋",
  browser_action: "🖥️",
  TaskCreate: "🤖",
  TaskCreateBatch: "🤖",
  TaskResume: "🔁",
  TaskSnapshot: "🧵",
  TeamCreate: "👥",
  TeamList: "👥",
  TeamGet: "👥",
  TeamInbox: "📬",
  TeamAddMember: "👤",
  TeamAssignTask: "📌",
  TeamSetMemberStatus: "🟢",
  SendMessage: "✉️",
  PlanStartWorkflow: "🗺️",
  PlanGetWorkflow: "🗺️",
  PlanAnswerWorkflow: "🗺️",
  PlanCreateResearchTasks: "🧪",
  PlanDraftWorkflow: "📝",
  PlanVerifyExecution: "✅",
  ListPlugins: "🧩",
  GetPlugin: "🧩",
  PluginValidate: "🧪",
  PluginEnable: "🧩",
  PluginTrust: "🧩",
  PluginConfigure: "🧩",
  PluginInstallLocal: "📥",
  PluginRemove: "🗑️",
  PluginReload: "🧩",
  ListRemoteSessions: "📡",
  GetRemoteSession: "📡",
  ReconnectRemoteSession: "📡",
  SendRemoteMessage: "📨",
  InterruptRemoteSession: "🛑",
  SpawnAgent: "🤖",
  spawn_agents: "🤖",
  SpawnAgents: "🤖",
  SpawnAgentOutput: "🧵",
  SpawnAgentStop: "🛑",
  use_skill: "💡",
  Skill: "💡",
  ask_followup_question: "❓",
  AskFollowupQuestion: "❓",
  update_todo_list: "📝",
  TodoWrite: "📝",
  batch: "📦",
  Parallel: "🧩",
  parallel: "🧩",
}

const TOOL_LABELS: Record<string, string> = {
  read_file: "Read",
  Read: "Read",
  write_to_file: "Write",
  Write: "Write",
  replace_in_file: "Edit",
  Edit: "Edit",
  list_dir: "List",
  List: "List",
  search_files: "Grep",
  Grep: "Grep",
  codebase_search: "CodebaseSearch",
  CodebaseSearch: "CodebaseSearch",
  list_code_definitions: "ListCodeDefinitions",
  ListCodeDefinitions: "ListCodeDefinitions",
  read_lints: "ReadLints",
  ReadLints: "ReadLints",
  glob: "Glob",
  Glob: "Glob",
  update_todo_list: "TodoWrite",
  TodoWrite: "TodoWrite",
  TaskCreate: "TaskCreate",
  TaskCreateBatch: "TaskCreateBatch",
  TaskResume: "TaskResume",
  TaskSnapshot: "TaskSnapshot",
  TeamCreate: "TeamCreate",
  TeamList: "TeamList",
  TeamGet: "TeamGet",
  TeamInbox: "TeamInbox",
  TeamAddMember: "TeamAddMember",
  TeamAssignTask: "TeamAssignTask",
  TeamSetMemberStatus: "TeamSetMemberStatus",
  SendMessage: "SendMessage",
  PlanStartWorkflow: "PlanStartWorkflow",
  PlanGetWorkflow: "PlanGetWorkflow",
  PlanAnswerWorkflow: "PlanAnswerWorkflow",
  PlanCreateResearchTasks: "PlanCreateResearchTasks",
  PlanDraftWorkflow: "PlanDraftWorkflow",
  PlanVerifyExecution: "PlanVerifyExecution",
  ListPlugins: "ListPlugins",
  GetPlugin: "GetPlugin",
  PluginValidate: "PluginValidate",
  PluginEnable: "PluginEnable",
  PluginTrust: "PluginTrust",
  PluginConfigure: "PluginConfigure",
  PluginInstallLocal: "PluginInstallLocal",
  PluginRemove: "PluginRemove",
  PluginReload: "PluginReload",
  ListRemoteSessions: "ListRemoteSessions",
  GetRemoteSession: "GetRemoteSession",
  ReconnectRemoteSession: "ReconnectRemoteSession",
  SendRemoteMessage: "SendRemoteMessage",
  InterruptRemoteSession: "InterruptRemoteSession",
  SpawnAgentOutput: "SpawnAgentOutput",
  SpawnAgentStop: "SpawnAgentStop",
  Parallel: "Parallel",
  parallel: "Parallel",
  batch: "Batch",
  Batch: "Batch",
}

export function toolDisplayName(tool: string): string {
  if (tool === "execute_command" || tool === "Bash") return "Bash"
  return TOOL_LABELS[tool] ?? tool
}

export function getParallelUses(input: Record<string, unknown>): Array<{ recipient_name?: unknown; parameters?: unknown }> {
  const uses = input.tool_uses
  if (!Array.isArray(uses)) return []
  return uses.filter((item): item is { recipient_name?: unknown; parameters?: unknown } => item != null && typeof item === "object")
}

export function normalizeParallelRecipientName(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return trimmed
  const lower = trimmed.toLowerCase()
  const prefixes = ["functions.", "function.", "multi_tool_use.", "tools.", "tool."]
  const prefix = prefixes.find((item) => lower.startsWith(item))
  const normalized = prefix ? trimmed.slice(prefix.length) : trimmed
  const canonical = normalized.toLowerCase().replace(/[^a-z0-9]/g, "")
  switch (canonical) {
    case "read":
    case "readfile":
    case "read_file":
      return "Read"
    case "list":
    case "listdir":
    case "listdirectory":
    case "list_dir":
      return "List"
    case "grep":
    case "grepsearch":
    case "searchfiles":
      return "Grep"
    case "glob":
    case "filesearch":
    case "globfilesearch":
      return "Glob"
    case "codebasesearch":
      return "CodebaseSearch"
    case "listcodedefinitions":
      return "ListCodeDefinitions"
    default:
      return normalized
  }
}
