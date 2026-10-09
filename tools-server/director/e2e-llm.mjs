/* ============================================================================
 * Harness Director — 端到端 LLM 驱动验收（真实链路，无 mock）
 *
 * 用真实 DeepSeek 模型（经 MemoryProxy :8096）作为 Agent，驱动 director-server
 * 的结构化工具，从一句创意推进到：Creative Brief → 剧本 → 导演定调 → 节奏 →
 * 镜头表 → 关键帧 → 生成(占位 Provider) → QC → 时间线 → 导出。
 *
 * 运行：node tools-server/director/e2e-llm.mjs
 * ==========================================================================*/
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, "..", "director-server.mjs");
const PORT = 8466;
const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), "director-e2e-"));
const DIRECTOR = "http://127.0.0.1:" + PORT;
const LLM = "http://127.0.0.1:8096/dsh/default/chat/completions";
const PROJECT_ID = "D-E2E";
const IDEA = process.argv[2] || "拍一部 30 秒竖屏短片：一个女孩在城市天台告别过去，重新开始。";

const DIRECTOR_SYSTEM = [
  "你是 Harness Director 的 director-orchestrator：把创意推进到可交付视频的制片/导演工作台 Agent。",
  "工作流阶段（依序推进，不跳步）：intake(Creative Brief) → story(剧本) → direction(导演定调) → rhythm(节奏) → script_lock → shot_design(镜头表) → storyboard(分镜) → keyframes(关键帧) → generation(生成+QC) → edit(剪辑) → sound → review → export。",
  "硬性规则：",
  "1. 先调用 get_director_project 读当前状态，再决定下一步；不要重复生成已确认内容。",
  "2. 所有产出必须通过结构化工具写入项目，不要把数据只写在聊天里。",
  "3. 用 JSON 传参：story 用 analyze_script；导演方向用 create_director_treatment（至少两个差异方向，禁用『电影感/8K/大师级』空话）；节奏用 create_rhythm_plan；镜头用 create_shot_list（每镜有 narrativePurpose/startState/primaryAction/endState；Blocking 先于摄影机设计）。",
  "4. 关键帧 Prompt 与运动 Prompt 分开（create_keyframe 存关键帧；compile_generation_prompt 编译运动 Prompt）；先 update_project_bible 建立 character/location/visual bible，再生成运动。",
  "5. 确认闸门：Creative Brief/剧本锁定/导演定调/节奏/分镜/关键帧/批量付费生成/粗剪/最终导出。进入这些阶段前把方案摘要给用户并用 [OPTIONS] 请求确认；用户确认后 confirm_gate 再 set_project_phase。",
  "6. 付费生成前 estimate_generation_cost 显示成本；批量生成需确认；不因单个镜头失败把整个项目标记失败。",
  "7. 中文简洁回复，每完成一个阶段汇报：已写入哪些结构化数据、当前阶段、下一步。",
].join("\n");

function post(url, body) { return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json()); }
function get(url) { return fetch(url).then((r) => r.json()); }

async function llm(messages, tools) {
  const r = await fetch(LLM, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer sk-mem-local" }, body: JSON.stringify({ model: "deepseek-v4-pro", messages, tools, stream: false }) });
  const d = await r.json();
  if (!d?.choices?.[0]) return { content: "", tool_calls: [], error: "LLM 返回异常: " + JSON.stringify(d).slice(0, 200) };
  const m = d.choices[0].message;
  return { content: m.content ?? "", tool_calls: m.tool_calls ?? [], error: "" };
}

async function execTool(name, args) {
  try { return await post(DIRECTOR + "/" + name, { ...args, projectId: args.projectId || PROJECT_ID }); }
  catch (e) { return { ok: false, error: String(e) }; }
}

async function runTurn(messages, tools, maxSteps = 14) {
  for (let i = 0; i < maxSteps; i++) {
    const res = await llm(messages, tools);
    if (res.error) return { content: res.error, steps: i, error: res.error };
    if (res.tool_calls.length === 0) return { content: res.content, steps: i };
    messages.push({ role: "assistant", content: res.content, tool_calls: res.tool_calls });
    for (const tc of res.tool_calls) {
      let args = {};
      try { args = JSON.parse(tc.function.arguments || "{}"); } catch { args = {}; }
      const result = await execTool(tc.function.name, args);
      messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result).slice(0, 4000) });
    }
  }
  return { content: "（达到最大步骤数）", steps: maxSteps };
}

async function main() {
  const child = spawn(process.execPath, [SERVER, "--port", String(PORT), "--workspace", WORKSPACE], { stdio: ["ignore", "ignore", "pipe"] });
  let errs = "";
  child.stderr.on("data", (d) => (errs += d));
  // wait health
  for (let i = 0; i < 50; i++) { try { if ((await fetch(DIRECTOR + "/health")).ok) break; } catch {} await new Promise((r) => setTimeout(r, 150)); }

  const cat = await get(DIRECTOR + "/catalog");
  const tools = cat.tools;
  console.log("=== 工具数:", tools.length, "| Skills:", cat.skills.length, "| Providers:", cat.providers.map((p) => p.name).join(","));

  // 1) 创建项目（直接用工具，跳过 LLM 的 meta 创建，聚焦创意阶段）
  await post(DIRECTOR + "/create_director_project", { projectId: PROJECT_ID, title: "天台告别", format: "social_vertical", targetPlatform: "douyin", targetDuration: 30, aspectRatio: "9:16", fps: 24, resolution: "1080x1920", purpose: "情感共鸣", coreMessage: "告别过去才能重新开始", desiredAction: "转发分享", budgetLimit: 10000 });

  const messages = [{ role: "system", content: DIRECTOR_SYSTEM }];

  const turns = [
    "开始创作。请完成 Creative Brief（含目的/受众/平台/核心信息/观看后行动/预算/版权边界），写入项目，并把摘要给我请求确认。",
    "确认 Creative Brief。继续：生成故事（logline/梗概/人物/场景/剧本，动作只写可见、声音只写可听）并写入，摘要后请求剧本锁定确认。",
    "确认剧本锁定。继续：输出两个有实质差异的导演定调方向（观众感受/镜头距离/运动/构图/色彩光线/剪辑/声音/风险/成本）并写入，请求确认。",
    "确认导演定调。继续：生成节奏计划（逐场情节/情绪强度、时长、镜头密度、总时长校验）并写入。",
    "继续：做 Blocking 并创建镜头表（至少 6 个镜头，每镜有 narrativePurpose/startState/primaryAction/endState/景别/运镜），先建立角色与场景 Bible。",
    "继续：为每个镜头创建关键帧（keyframePrompt 与关键帧参考分开）。",
    "继续：编译生成 Prompt，并提交第一个镜头到 local-stub 生成，然后跑 QC。",
  ];

  for (let i = 0; i < turns.length; i++) {
    messages.push({ role: "user", content: turns[i] });
    console.log("\n========== 第 " + (i + 1) + " 轮：" + turns[i].slice(0, 34) + "… ==========");
    const r = await runTurn(messages, tools);
    console.log("> Agent 回复（前 260 字）:", r.content.slice(0, 260).replace(/\n/g, " "));
    const p = await get(DIRECTOR + "/project/" + PROJECT_ID);
    const proj = p.project;
    console.log("> 状态: phase=" + proj.phase + " | 人物=" + proj.bible.characters.length + " | 场景=" + proj.bible.locations.length + " | 镜头=" + proj.shots.length + " | 资产=" + proj.assets.length + " | 任务=" + proj.generationTasks.length + " | 方向=" + proj.directorTreatments.length + " | 节奏=" + (proj.rhythmPlan ? "有" : "无"));
  }

  // 收尾：若已有片段，放到时间线并导出
  const p = await get(DIRECTOR + "/project/" + PROJECT_ID);
  const proj = p.project;
  if (proj.shots.length && proj.assets.length) {
    const approved = proj.shots.find((s) => s.clipAssetId);
    if (approved) {
      await post(DIRECTOR + "/place_clip_on_timeline", { shotId: approved.shotId, assetId: approved.clipAssetId });
    }
  }
  const exp = await post(DIRECTOR + "/export_project_archive", {});
  const fin = await post(DIRECTOR + "/render_final", {});

  console.log("\n========== 最终状态 ==========");
  const fp = await get(DIRECTOR + "/project/" + PROJECT_ID);
  const f = fp.project;
  console.log(JSON.stringify({
    title: f.title, phase: f.phase, phaseLabel: f.phase,
    story: { logline: f.story.logline?.slice(0, 60), characters: f.story.characters?.length, scenes: f.story.scenes?.length },
    bible: { characters: f.bible.characters.length, locations: f.bible.locations.length, visual: f.bible.visual },
    treatments: f.directorTreatments.length, rhythm: Boolean(f.rhythmPlan),
    shots: f.shots.length, shotSample: f.shots.slice(0, 2).map((s) => ({ id: s.shotId, status: s.status, purpose: s.narrativePurpose, start: s.startState, action: s.primaryAction, end: s.endState })),
    assets: f.assets.length, tasks: f.generationTasks.length,
    timeline: f.timeline.videoTracks[0].clips.length,
    version: f.version, confirmations: Object.keys(f.confirmations),
    export: exp.files, renderExecuted: fin.executed, renderCommand: fin.command?.slice(0, 120),
  }, null, 2));

  console.log("\n工作目录:", WORKSPACE);
  child.kill("SIGKILL");
}

main().catch((e) => { console.error("E2E 失败:", e); process.exit(1); });
