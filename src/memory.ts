/* ================= Agent Memory 集成（TencentDB-Agent-Memory） =================
 *
 * 架构（详见 docs/MEMORY.md）：
 *   Harness Desktop ──(OpenAI 兼容 /chat/completions)──> MemoryProxy :8096
 *   MemoryProxy ──> MemoryCore（L0 对话 → L1 Atom → L2 Scenario → L3 Persona）
 *              └──> MemoryHub :8125（Team/Agent/ACL/资产面板）
 *
 * 本模块提供三层能力：
 *   1. recall()  会话开始时按当前任务召回 L2 场景 + L1 事实（注入澄清流程）
 *   2. commit()  执行完成后把对话 L0 写入记忆（Proxy 自动蒸馏 L1/L2/L3）
 *   3. 本地回退   Proxy 不可达时用 localStorage 保存 L0 对话与召回偏好
 */

export interface MemoryConfig {
  enabled: boolean;
  coreUrl: string;      // MemoryCore 网关，例如 http://127.0.0.1:8420
  serverUrl: string;    // MemoryProxy 地址，例如 http://127.0.0.1:8096
  spaceId: string;      // 例如 dsh
  teamId: string;       // 例如 default
  userKey: string;      // sk-mem-... 由 MemoryHub 签发
  agentName: string;
}

export interface MemoryRecall {
  persona: string;      // L3 画像一句话
  scenario: string;     // L2 场景
  atoms: string[];      // L1 事实/偏好/约束
  source: "core" | "proxy" | "local" | "none";
}

const LS_KEY = "harness.memory.config";
const LS_L0 = "harness.memory.l0";

export function loadMemoryConfig(): MemoryConfig {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return { ...defaultMemoryConfig(), ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return defaultMemoryConfig();
}

export function saveMemoryConfig(cfg: MemoryConfig) {
  localStorage.setItem(LS_KEY, JSON.stringify(cfg));
}

export function defaultMemoryConfig(): MemoryConfig {
  return {
    enabled: true,
    coreUrl: "http://127.0.0.1:8420",
    serverUrl: "http://127.0.0.1:8096",
    spaceId: "dsh",
    teamId: "default",
    userKey: "",
    agentName: "harness-desktop",
  };
}

/* ---- 本地回退：L0 存储 + 简单偏好沉淀 ---- */
function localCommit(title: string, msgs: { role: string; text?: string; chip?: string }[]) {
  try {
    const raw = localStorage.getItem(LS_L0);
    const all = raw ? JSON.parse(raw) : [];
    all.push({ title, time: new Date().toISOString(), msgs });
    localStorage.setItem(LS_L0, JSON.stringify(all.slice(-50)));
  } catch { /* ignore */ }
}

function localRecall(): MemoryRecall {
  // 从本地历史里提取「偏好类」回答作为 L1 原子（简化版蒸馏）
  const atoms: string[] = [];
  try {
    const raw = localStorage.getItem(LS_L0);
    const all = raw ? JSON.parse(raw) : [];
    for (const s of all.slice(-6)) {
      for (const m of s.msgs ?? []) {
        const t = m.chip ?? m.text ?? "";
        if (/暖白|极简|深色|最小版本|完整|对外|内部|团队|风格|范围/.test(t)) {
          const a = "偏好：" + t;
          if (!atoms.includes(a) && atoms.length < 4) atoms.push(a);
        }
      }
    }
  } catch { /* ignore */ }
  return {
    persona: "技术型用户，偏好暖白极简风格，先小步验证再扩大范围。",
    scenario: "DeepSeek Harness 桌面端迭代",
    atoms,
    source: "local",
  };
}

/* ---- Proxy 调用（OpenAI 兼容） ---- */
async function proxyCall(cfg: MemoryConfig, msgs: { role: string; content: string }[]): Promise<string | null> {
  try {
    const res = await fetch(`${cfg.serverUrl}/${cfg.spaceId}/${cfg.teamId}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.userKey || "sk-mem-local"}`,
        "X-Agent-Name": cfg.agentName,
      },
      body: JSON.stringify({ model: "memory-proxy", messages: msgs, stream: false }),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.choices?.[0]?.message?.content ?? null;
  } catch {
    return null;
  }
}

/* ---- MemoryCore 网关直连（真实记忆：recall + capture） ---- */
async function coreRecall(cfg: MemoryConfig, query: string): Promise<MemoryRecall | null> {
  try {
    const res = await fetch(`${cfg.coreUrl}/recall`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, session_key: `desktop-${cfg.agentName}`, user_id: cfg.agentName }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data?.code !== 0) return null;
    const context: string = data?.context ?? "";
    if (!context.trim()) return null;
    /* 召回优化：过滤身份信息与项目数字，只保留可执行的偏好/协作准则 */
    const IDENTITY_RE = /名称|姓名|身份|公司|团队|花小猪|苏轩|Sonya|freya|电话|邮箱|联系方式|地址|学历|性别|年龄|日均|单量|转化率|进线|二次号|账号安全|负责人|实习生|面试|官网|F[1-9]/;
    const PREF_RE = /暖白|极简|简洁|按钮|最小|MVP|验证|严谨|先核实|不猜测|克制|留白|强调色|游戏|二段跳|平台跳跃|务实|小步|风格|范围|对外|内部/;
    const lines = context
      .split("\n")
      .map((l: string) => l.trim().replace(/^[-*>#]\s*/, ""))
      .filter(Boolean);
    const atoms = lines
      .filter((l: string) => !IDENTITY_RE.test(l) && l.length < 90)
      .filter((l: string) => PREF_RE.test(l) || /偏好|视觉|产品|协作|准则|协议/.test(l))
      .slice(0, 4)
      .map((l: string) => (/^偏好/.test(l) ? l : "偏好：" + l));
    const unique = [...new Set(atoms)];
    return {
      persona: unique.length ? "长期偏好（召回）：" + unique.join("；") : "",
      scenario: "MemoryCore L2/L3 召回",
      atoms: unique.length ? unique : ["偏好：暖白极简、先做最小版本、严谨协作"],
      source: "core",
    };
  } catch {
    return null;
  }
}

async function coreCommit(cfg: MemoryConfig, title: string, msgs: { role: string; text?: string; chip?: string }[]): Promise<boolean> {
  try {
    const userText = msgs.find((m) => m.role === "user")?.text ?? title;
    const agentText = msgs.filter((m) => m.role === "agent").map((m) => m.text ?? "").slice(-2).join(" ") || "任务完成";
    const res = await fetch(`${cfg.coreUrl}/capture`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_content: `${title}：${userText}`,
        assistant_content: agentText,
        session_key: `desktop-${cfg.agentName}`,
        session_id: `desktop-${cfg.agentName}`,
        user_id: cfg.agentName,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data?.l0_recorded > 0;
  } catch {
    return false;
  }
}

/* ---- 真实 LLM 对话（经 MemoryProxy 转发 + 记忆注入 + 工具调用） ---- */

export interface LlmToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface LlmChatResult {
  content: string;
  tool_calls?: LlmToolCall[];
  finish_reason?: string;
  error?: string;
}

export async function chatCompletion(
  cfg: MemoryConfig,
  model: string,
  messages: { role: string; content: string; tool_calls?: unknown; tool_call_id?: string }[],
  tools?: unknown[]
): Promise<LlmChatResult> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const r = await chatOnce(cfg, model, messages, tools);
    if (!r.error) return r;
    // 网络类失败（服务冷启动中）重试；HTTP 业务错误不重试
    if (!/fetch failed|Timeout|Load failed|NetworkError|Failed to fetch/i.test(r.error)) return r;
    await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
  }
  return { content: "", error: "连接 MemoryProxy 失败（服务正在启动或异常，稍后再试）" };
}

async function chatOnce(
  cfg: MemoryConfig,
  model: string,
  messages: { role: string; content: string; tool_calls?: unknown; tool_call_id?: string }[],
  tools?: unknown[]
): Promise<LlmChatResult> {
  try {
    const body: Record<string, unknown> = { model, messages, stream: false };
    if (tools && tools.length) body.tools = tools;
    const res = await fetch(`${cfg.serverUrl}/${cfg.spaceId}/${cfg.teamId}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.userKey || "sk-mem-local"}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000),
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      return { content: "", error: `HTTP ${res.status} ${bodyText.slice(0, 140)}` };
    }
    const data = await res.json();
    const message = data?.choices?.[0]?.message ?? {};
    const content: string = message.content ?? "";
    const tool_calls: LlmToolCall[] | undefined = message.tool_calls ?? undefined;
    if (!content && !tool_calls?.length) return { content: "", error: "模型返回为空" };
    return { content, tool_calls, finish_reason: data?.choices?.[0]?.finish_reason };
  } catch (e) {
    return { content: "", error: String(e) };
  }
}

/* ---- 对外 API ---- */
export async function recallMemory(task: string, cfg: MemoryConfig): Promise<MemoryRecall> {
  if (!cfg.enabled) return { persona: "", scenario: "", atoms: [], source: "none" };
  const fromCore = await coreRecall(cfg, task);
  if (fromCore) return fromCore;
  if (cfg.userKey) {
    const reply = await proxyCall(cfg, [
      { role: "system", content: "recall memory loadout for current task" },
      { role: "user", content: task },
    ]);
    if (reply) {
      return { persona: reply.slice(0, 120), scenario: "MemoryProxy 召回", atoms: [], source: "proxy" };
    }
  }
  const local = localRecall();
  local.atoms = local.atoms.length ? local.atoms : ["偏好：暖白极简", "范围：先做最小版本"];
  return local;
}

export async function commitMemory(title: string, msgs: { role: string; text?: string; chip?: string }[], cfg: MemoryConfig): Promise<boolean> {
  localCommit(title, msgs);
  if (!cfg.enabled) return false;
  const toCore = await coreCommit(cfg, title, msgs);
  if (toCore) return true;
  if (!cfg.userKey) return false;
  const content = msgs.map((m) => `${m.role}: ${m.chip ?? m.text ?? ""}`).join("\n");
  const reply = await proxyCall(cfg, [
    { role: "system", content: `commit conversation "${title}" to L0 memory for agent ${cfg.agentName}` },
    { role: "user", content },
  ]);
  return reply !== null;
}