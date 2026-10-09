/**
 * Harness 能力系统共享数据模型（前端契约）。
 *
 * 这些类型是「Skill / MCP / Capability / Permission / Agent / Plugin / Run」
 * 的单一数据源（source of truth）。后端 `tools-server/lib/**` 以 JSON 字段
 * 与之对齐，序列化边界（HTTP/localStorage/JSON 文件）按这里的字段名持久化。
 *
 * 命名空间约定：任何 Harness 自有扩展字段必须置于 `harness.*` 或
 * `metadata.harness.*` 命名空间下，避免破坏 agentskills SKILL.md 标准兼容。
 */

/* ============================== Skill ============================== */

/** agentskills SKILL.md 标准目录：skill-name/{SKILL.md,references/,scripts/,assets/} */
export interface SkillDirectoryLayout {
  /** 技能名（kebab-case，如 `pdf-processing`） */
  name: string;
  /** 触发描述（progressive disclosure 的唯一路由依据） */
  description: string;
  /** 可选：额外的路由引导 */
  whenToUse?: string;
  /** 版本号（semver 字符串） */
  version?: string;
  /** 许可证 SPDX 标识或文本 */
  license?: string;
  /** 兼容性字段（标准），例如 `["harness>=0.1.0"]` */
  compatibility?: string[];
  /** 标准 metadata 命名空间（harness 扩展置于 metadata.harness.*） */
  metadata?: Record<string, unknown>;
  /** 该 Skill 声明允许使用的工具白名单（标准 allowed-tools） */
  allowedTools?: string[];
  /** 相对引用资源（references/scripts/assets 的索引） */
  resources?: {
    references?: string[];
    scripts?: string[];
    assets?: string[];
  };
  /** SKILL.md 正文（仅在选中后加载） */
  content?: string;
}

/** Skill 信任等级，决定默认权限上限 */
export type SkillTrustLevel = "official" | "verified" | "community" | "local" | "untrusted";

/** Skill 安装来源 */
export type SkillInstallSource =
  | { kind: "folder"; path: string }
  | { kind: "zip"; path: string }
  | { kind: "git"; url: string; ref?: string };

/** Skill 生命周期状态（真实 runtime 驱动，禁止静态文案伪造） */
export type SkillStatus =
  | "discovered"
  | "validating"
  | "installed"
  | "enabled"
  | "disabled"
  | "update_available"
  | "invalid"
  | "quarantined";

/** 已安装 Skill 的索引记录 */
export interface InstalledSkill {
  id: string;                 // 安装实例 id（如 name@version）
  name: string;
  version: string;
  source: SkillInstallSource;
  /** 来源来源标签（folder/zip/git/marketplace） */
  origin: "folder" | "zip" | "git" | "marketplace";
  /** 版本化安装目录绝对路径 */
  installPath: string;
  trustLevel: SkillTrustLevel;
  status: SkillStatus;
  scope: "global" | "project";
  license?: string;
  publisher?: string;
  enabled: boolean;
  manifest: SkillDirectoryLayout;
  /** 安装时计算的权限请求 */
  requestedPermissions?: string[];
  installedAt: number;
  updatedAt: number;
}

/** Skill 路由结果：为什么触发 */
export interface SkillActivation {
  skillId: string;
  version: string;
  reason: "explicit" | "semantic" | "agent" | "plugin" | "project-type";
  score?: number;
  /** 人类可读的触发说明 */
  explanation: string;
}

/* ============================== MCP ============================== */

export type McpTransportKind = "stdio" | "streamable-http" | "sse";

/** Secret 引用（不入库明文，指向 Keychain / env 引用） */
export type SecretRef =
  | { kind: "keychain"; key: string }
  | { kind: "env"; name: string };

export interface McpServerConfig {
  id: string;
  name: string;
  source: "user" | "plugin" | "builtin";
  transport: McpTransportKind;
  enabled: boolean;
  /** stdio */
  command?: string;
  args?: string[];
  env?: Record<string, string | SecretRef>;
  workingDirectory?: string;
  /** streamable-http / sse */
  url?: string;
  headers?: Record<string, string | SecretRef>;
  oauth?: { enabled: boolean; provider?: string };
  timeoutMs?: number;
  autoRestart?: boolean;
  /** 工具作用域（连接 ≠ 全量暴露） */
  toolPolicy: {
    serverEnabled: boolean;
    allowedTools?: string[];   // 白名单；缺省 = 全部
    deniedTools?: string[];
    riskOverrides?: Record<string, number>; // tool -> risk level 覆盖
  };
}

export type McpServerStatus =
  | "disabled"
  | "starting"
  | "connected"
  | "authentication_required"
  | "degraded"
  | "reconnecting"
  | "crashed"
  | "incompatible"
  | "stopped";

/** MCP 服务发现结果（Tools/Resources/Prompts） */
export interface McpDiscovery {
  serverId: string;
  status: McpServerStatus;
  serverVersion?: string;
  capabilities?: Record<string, unknown>;
  tools: McpToolInfo[];
  resources: McpResourceInfo[];
  prompts: McpPromptInfo[];
  lastError?: string;
  startupLog?: string[];
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  /** MCP annotations（仅参考，最终风险由 Harness 评估） */
  annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  riskLevel: RiskLevel;
}

export interface McpResourceInfo { uri: string; name?: string; mimeType?: string }
export interface McpPromptInfo { name: string; description?: string }

/* ============================== Capability ============================== */

/** 能力抽象：Skill 声明能力，CapabilityRegistry 决定绑定哪个 Provider */
export interface Capability {
  /** 反向域名风格，如 `video.generate` / `asset.read` */
  name: string;
  description?: string;
}

export interface CapabilityBinding {
  capability: string;
  /** 绑定的 provider 类型 + 实例 */
  provider: { kind: "mcp" | "local"; serverId?: string; toolName?: string };
}

/* ============================== Permission ============================== */

/** 工具风险分级 */
export type RiskLevel = 0 | 1 | 2 | 3;

export interface ToolRiskAssessment {
  toolName: string;
  serverId?: string;
  /** 只读/写入/副作用/不可逆 的分级依据 */
  level: RiskLevel;
  reason: string;
}

export type PermissionScope = "once" | "session" | "permanent";

export type ApprovalRequestStatus = "pending" | "approved" | "denied" | "cancelled";

export interface ApprovalRequest {
  id: string;
  runId: string;
  toolName: string;
  serverId?: string;
  args: Record<string, unknown>;
  risk: RiskLevel;
  reason: string;
  scope: PermissionScope;
  status: ApprovalRequestStatus;
  requestedAt: number;
  decidedAt?: number;
}

export interface PermissionGrant {
  id: string;
  toolName: string;
  serverId?: string;
  risk: RiskLevel;
  scope: PermissionScope;
  grantedAt: number;
  revokedAt?: number;
}

/* ============================== Agent ============================== */

export type AgentKind = "general" | "project" | "plugin" | "ephemeral" | "subagent";

export interface AgentDefinition {
  agentId: string;
  name: string;
  description: string;
  kind: AgentKind;
  modelPolicy: { model?: string; fallback?: string };
  systemInstructions: string;
  skills: string[];             // 绑定的 skill 名（不含未命中路由的）
  capabilities: string[];       // 绑定的能力名
  mcpServers: string[];         // 绑定的 MCP server id
  tools: string[];              // 直接绑定的工具（本地 provider）
  permissionPolicy: {
    autoApproveBelow: RiskLevel;   // 该阈值以下自动批准
    defaultScope: PermissionScope;
    allowUserOverride: boolean;
  };
  memoryPolicy: { enabled: boolean };
  workspacePolicy: { root?: string };
  subagentPolicy: { allowSpawn: boolean; maxDepth: number };
  approvalPolicy: { requirePlan: boolean; requireToolConfirm: boolean };
  budgetPolicy: { maxCostUsd?: number; maxSteps?: number };
  timeoutPolicy: { toolTimeoutMs: number; runTimeoutMs?: number };
}

/* ============================== Plugin ============================== */

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  publisher: string;
  description: string;
  license: string;
  homepage?: string;
  repository?: string;
  engines: { harness: string };
  skills: string[];
  mcpServers: string[];
  agents: string[];
  commands: string[];
  hooks: string[];
  uiContributions: string[];
  permissions: string[];
  capabilities: string[];
  dependencies: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

export type PluginStatus =
  | "installed"
  | "enabled"
  | "disabled"
  | "permission_required"
  | "update_available"
  | "incompatible"
  | "broken";

/* ============================== Run ============================== */

export type AgentRunStatus =
  | "preparing"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_input"
  | "waiting_for_external_job"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export interface ToolCallRecord {
  id: string;
  name: string;
  serverId?: string;
  args: Record<string, unknown>;
  status: "running" | "done" | "error";
  result?: string;
  error?: string;
  risk: RiskLevel;
  startedAt: number;
  finishedAt?: number;
}

export interface AgentRun {
  runId: string;
  taskId: string;
  agentId: string;
  currentStep: number;
  state: AgentRunStatus;
  input: string;
  output?: string;
  waitingReason?: string;
  approvalRequest?: ApprovalRequest;
  toolCalls: ToolCallRecord[];
  artifacts: string[];           // 产物文件相对路径
  errors: { step: number; message: string; at: number }[];
  retryCount: number;
  costUsd?: number;
  tokens?: { input: number; output: number };
  createdAt: number;
  updatedAt: number;
  /** 每次执行的 Skill 激活记录 */
  activatedSkillIds: string[];
  skillVersions: Record<string, string>;
  activationReasons: Record<string, string>;
  loadedResources: string[];
  requestedCapabilities: string[];
}

/* ============================== 状态机标签 ============================== */

export const MCP_SERVER_STATUSES: McpServerStatus[] = [
  "disabled", "starting", "connected", "authentication_required",
  "degraded", "reconnecting", "crashed", "incompatible", "stopped",
];

export const SKILL_STATUSES: SkillStatus[] = [
  "discovered", "validating", "installed", "enabled", "disabled",
  "update_available", "invalid", "quarantined",
];

export const PLUGIN_STATUSES: PluginStatus[] = [
  "installed", "enabled", "disabled", "permission_required",
  "update_available", "incompatible", "broken",
];

export const RUN_STATUSES: AgentRunStatus[] = [
  "preparing", "running", "waiting_for_approval", "waiting_for_input",
  "waiting_for_external_job", "paused", "completed", "failed", "cancelled",
];
