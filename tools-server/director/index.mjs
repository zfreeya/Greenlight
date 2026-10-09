/* ============================================================================
 * Harness Director — 包入口（npm 模块 harness-director）
 *
 * 导出：服务工厂（createDirectorServer）、共享上下文（createDirectorContext）、
 * 域路由工厂，以及全部核心库模块（types / store / generation / ffmpeg /
 * prompt-compiler / qc / timeline / render / tools / providers / skills /
 * asset-upload / keychain / third-party）。
 *
 * 用法：
 *   import { createDirectorServer } from "harness-director";
 *   const srv = createDirectorServer({ port: 8456, workspace: "~/Harness" });
 *   srv.start();
 * ==========================================================================*/
export { createDirectorServer } from "./server.mjs";
export { createDirectorContext, GATE_FOR_PHASE, GATES } from "./server-context.mjs";
export { default as createProjectRoutes } from "./routes/project.mjs";
export { default as createGenerationRoutes } from "./routes/generation.mjs";
export { default as createRenderRoutes } from "./routes/render.mjs";
export { default as createBusinessRoutes } from "./routes/business.mjs";

export * as T from "./types.mjs";
export { DirectorStore } from "./store.mjs";
export { GenerationEngine } from "./generation.mjs";
export * as FF from "./ffmpeg.mjs";
export { compileGenerationPrompt, buildShotPacket, buildMotionPrompt, SYSTEM_SAFETY_RULES } from "./prompt-compiler.mjs";
export { runClipQc, compareClipVersions, QC_VERDICTS } from "./qc.mjs";
export * as TL from "./timeline.mjs";
export { compileRender, renderTimeline, ffmpegAvailable } from "./render.mjs";
export { TOOLS, toolCatalog } from "./tools.mjs";
export { PROVIDERS, getProvider, listProviders } from "./providers.mjs";
export { SKILLS, getSkill, skillsForPhase, orchestratorNext } from "./skills.mjs";
export { AssetUploader } from "./asset-upload.mjs";
export { resolveApiKey } from "./keychain.mjs";
export { THIRD_PARTY_SOURCES, thirdPartyNoticesMarkdown } from "./third-party.mjs";
