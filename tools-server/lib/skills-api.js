/**
 * Skills HTTP 路由：安装 / 列表 / 启用 / 信任 / 渐进式读取 / 卸载 / 路由。
 * 挂载到 tools-server 的 http.createServer 路由表。
 */

import { installSkill, uninstallSkill } from "./skill/install.js";
import { selectSkills } from "./skill/router.js";

const TRUST_LEVELS = new Set(["official", "verified", "community", "local", "untrusted"]);

export function skillsRoutes(app) {
  return {
    // 元数据列表（只含 name/description，不载入全文）
    "/skills/list": () => ({ skills: app.skills.list() }),

    // 路由：根据请求选择技能（只读元数据）
    "/skills/route": (body) => {
      const request = String(body.request ?? "");
      const explicit = Array.isArray(body.explicit) ? body.explicit.map(String) : [];
      const projectType = body.projectType ? String(body.projectType) : undefined;
      const activations = selectSkills(request, app.skills.list(), { explicit, projectType });
      return { activations };
    },

    // 安装：folder / zip / git
    "/skills/install": async (body) => {
      const source = body.source;
      if (!source || typeof source !== "object") throw new Error("缺少 source");
      if (!["folder", "zip", "git"].includes(source.kind)) throw new Error("source.kind 须为 folder|zip|git");
      const trustLevel = TRUST_LEVELS.has(body.trustLevel) ? body.trustLevel : "local";
      const { installed, analysis } = await installSkill({
        source,
        skillsRoot: app.skillsRoot,
        index: app.skills.index,
        trustLevel,
      });
      app.skills.persist();
      return { installed, analysis };
    },

    // 卸载
    "/skills/uninstall": (body) => {
      const rec = uninstallSkill({ skillsRoot: app.skillsRoot, index: app.skills.index, id: String(body.id ?? "") });
      app.skills.persist();
      return { uninstalled: rec.name, version: rec.version };
    },

    // 启用 / 禁用
    "/skills/set-enabled": (body) => {
      const rec = app.skills.setEnabled(String(body.id ?? ""), Boolean(body.enabled));
      return { skill: rec };
    },

    // 信任等级
    "/skills/set-trust": (body) => {
      if (!TRUST_LEVELS.has(body.trustLevel)) throw new Error("非法信任等级");
      const rec = app.skills.setTrustLevel(String(body.id ?? ""), body.trustLevel);
      return { skill: rec };
    },

    // 第二级：加载 SKILL.md 全文（仅选中后）
    "/skills/load": (body) => {
      const name = String(body.name ?? "");
      const body_ = app.skills.loadBody(name);
      if (!body_) throw new Error("技能不存在或已禁用：" + name);
      return body_;
    },

    // 第三级：读取资源文件
    "/skills/resource": (body) => {
      const name = String(body.name ?? "");
      const rel = String(body.rel ?? "");
      const text = app.skills.loadResource(name, rel);
      if (text === null) throw new Error("资源不存在：" + rel);
      return { name, rel, content: text };
    },
  };
}
