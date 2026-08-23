import { test, expect } from "@playwright/test";

/**
 * 游戏工作台（真实实现，不伪造）：
 * GameSpec 版本化、检查点/版本、输入映射、桥接 Autoload、真实 headless 玩法测试、诚实导出。
 * 全部直连 godot-server（e2e 隔离端口 8456），验证真实落盘与真实进程。
 */
test.describe("游戏工作台后端", () => {
  test.describe.configure({ retries: 0 });
  const GODOT = "http://127.0.0.1:8456";

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try { localStorage.setItem("harness.godot.config", JSON.stringify({ url: "http://127.0.0.1:8456" })); } catch { /* ignore */ }
    });
  });

  test("GameSpec 版本化：create→update 版本递增，history 记录原因与用户请求", async ({ request }) => {
    await request.post(`${GODOT}/create`, { data: { projectId: "ws-spec", name: "平台跳跃" } });
    const c = await request.post(`${GODOT}/spec-create`, {
      data: { projectId: "ws-spec", title: "平台跳跃", userRequest: "做一个平台跳跃游戏", spec: { winConditions: ["到达终点"], genre: "平台跳跃" } },
    });
    const cj = await c.json();
    expect(cj.ok).toBe(true);
    const v1 = cj.spec.version;
    expect(v1).toBeGreaterThanOrEqual(1);
    expect(cj.spec.phase).toBe("concept");
    expect(cj.spec.title).toBe("平台跳跃");
    expect(cj.spec.winConditions).toContain("到达终点");

    const u = await request.post(`${GODOT}/spec-update`, {
      data: { projectId: "ws-spec", spec: { difficultyCurve: "先易后难" }, reason: "数值调整", userRequest: "难度曲线" },
    });
    const uj = await u.json();
    expect(uj.ok).toBe(true);
    expect(uj.spec.version).toBe(v1 + 1);
    expect(uj.spec.difficultyCurve).toBe("先易后难");

    const g = await request.post(`${GODOT}/spec-get`, { data: { projectId: "ws-spec" } });
    const gj = await g.json();
    expect(gj.ok).toBe(true);
    expect(gj.spec.version).toBe(v1 + 1);
    expect(gj.history.length).toBeGreaterThanOrEqual(2);
    expect(gj.history.some((h: { reason?: string; userRequest?: string }) => h.reason === "数值调整" && h.userRequest === "难度曲线")).toBe(true);
  });

  test("检查点：保存 → 列表 → 版本比较", async ({ request }) => {
    await request.post(`${GODOT}/create`, { data: { projectId: "ws-ckpt", name: "快照" } });
    const c1 = await request.post(`${GODOT}/checkpoint`, { data: { projectId: "ws-ckpt", reason: "原型完成", userRequest: "保存进度" } });
    const c1j = await c1.json();
    expect(c1j.ok).toBe(true);
    expect(c1j.ts).toBeTruthy();
    const ts = c1j.ts;

    const v = await request.post(`${GODOT}/versions`, { data: { projectId: "ws-ckpt" } });
    const vj = await v.json();
    expect(vj.ok).toBe(true);
    expect(vj.checkpoints.some((c: { ts: number; reason: string }) => c.ts === ts && c.reason === "原型完成")).toBe(true);

    await request.post(`${GODOT}/write-file`, { data: { projectId: "ws-ckpt", path: "scripts/main.gd", content: "extends Node2D\nfunc _ready():\n    pass\n" } });
    const c2 = await request.post(`${GODOT}/checkpoint`, { data: { projectId: "ws-ckpt", reason: "迭代一" } });
    const c2j = await c2.json();

    const cmp = await request.post(`${GODOT}/compare-versions`, { data: { projectId: "ws-ckpt", a: ts, b: c2j.ts } });
    const cmpj = await cmp.json();
    expect(cmpj.ok).toBe(true);
    expect(cmpj.diff).toHaveProperty("aFiles");
    expect(cmpj.diff).toHaveProperty("bFiles");
  });

  test("输入映射写入 + 桥接 Autoload 已注册", async ({ request }) => {
    await request.post(`${GODOT}/create`, { data: { projectId: "ws-input", name: "输入" } });
    const im = await request.post(`${GODOT}/input-map`, {
      data: { projectId: "ws-input", actions: { jump: { events: { 32: [32] } } } },
    });
    expect((await im.json()).ok).toBe(true);
    const r = await request.post(`${GODOT}/read-file`, { data: { projectId: "ws-input", path: "project.godot" } });
    const rj = await r.json();
    const content = rj.lines.map((x: { text: string }) => x.text).join("\n");
    expect(content).toContain("[autoload]");
    expect(content).toContain("HarnessBridge");
    expect(content).toContain("jump={");
  });

  test("玩法测试：真实 headless 启动 + 桥接 game_ready 事件", async ({ request }) => {
    test.setTimeout(180_000);
    await request.post(`${GODOT}/create`, { data: { projectId: "ws-play", name: "玩法" } });
    const p = await request.post(`${GODOT}/playtest`, { data: { projectId: "ws-play", duration: 3 } });
    const pj = await p.json();
    expect(pj.ok).toBe(true);
    expect(typeof pj.passed).toBe("boolean");
    expect(pj.events.some((e: { event: string }) => e.event === "game_ready")).toBe(true);
    expect(Array.isArray(pj.errors)).toBe(true);
    expect(pj.evidence).toHaveProperty("scene");
  });

  test("导出构建：诚实返回缺失模板（不伪造成功）", async ({ request }) => {
    await request.post(`${GODOT}/create`, { data: { projectId: "ws-export", name: "导出" } });
    const e = await request.post(`${GODOT}/export-build`, { data: { projectId: "ws-export" } });
    const ej = await e.json();
    expect(ej.ok).toBe(false);
    expect(ej.code).toBe("missing_templates");
    expect(ej.hint).toContain("导出模板");
  });
});
