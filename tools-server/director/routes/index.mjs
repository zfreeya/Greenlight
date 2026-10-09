/* ============================================================================
 * Harness Director — 域路由集合入口
 * 用法：import { projectRoutes, generationRoutes, renderRoutes, businessRoutes } from "harness-director/routes";
 * 每个工厂接收 ctx（createDirectorContext 返回值），返回 { "/route": handler } 映射。
 * ==========================================================================*/
export { default as projectRoutes } from "./project.mjs";
export { default as generationRoutes } from "./generation.mjs";
export { default as renderRoutes } from "./render.mjs";
export { default as businessRoutes } from "./business.mjs";
