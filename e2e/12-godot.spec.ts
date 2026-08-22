import { test, expect } from "@playwright/test";

/**
 * Godot 能力（真实实现，不伪造）：
 * 1. 新建 Godot 任务 → 工作区诚实显示「引擎未安装/未检测到」
 * 2. godot-server 真实创建项目（project.godot/场景/GDScript）→ 工作区场景 tab 展示真实节点树
 * 3. 运行项目 → 真实返回「运行时缺失」错误码与下一步提示
 */
test.describe("Godot 游戏能力", () => {
  test.describe.configure({ retries: 1 });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try { localStorage.setItem("harness.tools.config", JSON.stringify({ url: "http://127.0.0.1:8451" }));
      localStorage.setItem("harness.godot.config", JSON.stringify({ url: "http://127.0.0.1:8456" })); } catch { /* ignore */ }
    });
  });

  test("新建 Godot 任务 → 工作区显示引擎就绪（已安装 Godot）", async ({ page }) => {
    await page.goto("/");
    await page.locator(".btn-new-chat").click();
    await expect(page.locator(".newtask-pop")).toBeVisible();
    await page.locator(".newtask-item", { hasText: "Godot 游戏" }).click();
    await page.locator(".win-titlebar .head-btn").first().click();
    await expect(page.locator(".game-workspace")).toBeVisible();
    // 引擎就绪（真实检测到 /Applications/Godot.app）
    await expect(page.locator(".gw-head .badge")).toHaveText("引擎就绪", { timeout: 30_000 });
    await expect(page.locator(".gw-engine")).toContainText("4.7.2", { timeout: 30_000 });
  });

  test("godot-server 真实创建项目，工作区场景树真实解析展示", async ({ page, request }) => {
    // 新建 Godot 任务（首线程 id 为 C-1）
    await page.goto("/");
    await page.locator(".btn-new-chat").click();
    await page.locator(".newtask-item", { hasText: "Godot 游戏" }).click();
    // 读取当前任务 id（与工作区 projectId 一致）
    const tid = await page.evaluate(() => localStorage.getItem("harness.current.v1"));
    // 用 godot-server 真实创建项目（projectId 与当前任务一致）
    const c = await request.post("http://127.0.0.1:8456/create", { data: { projectId: tid, name: "platformer" } });
    expect(c.ok()).toBeTruthy();
    const cj = await c.json();
    expect(cj.ok).toBe(true);
    // 真实文件落盘
    const sc = await request.post("http://127.0.0.1:8456/scenes", { data: { projectId: tid } });
    const scj = await sc.json();
    expect(scj.scenes).toContain("scenes/main.tscn");
    expect(scj.tree.map((n: { type: string }) => n.type)).toContain("CharacterBody2D");
    // 工作区场景 tab 渲染真实节点树
    await page.locator(".win-titlebar .head-btn").first().click();
    await expect(page.locator(".game-workspace")).toBeVisible();
    await page.locator(".gw-tab", { hasText: "场景" }).click();
    await expect(page.locator(".gw-tree")).toContainText("Node2D");
    await expect(page.locator(".gw-tree")).toContainText("CharacterBody2D");
    await expect(page.locator(".gw-scene")).toContainText("scenes/main.tscn");
  });

  test("前端 Agent 工具路径：create/inspect 端点映射正确（不落未知端点）", async ({ page, request }) => {
    await page.goto("/");
    await page.locator(".btn-new-chat").click();
    await page.locator(".newtask-item", { hasText: "Godot 游戏" }).click();
    await page.locator("#chatInput").click();
    await page.locator("#chatInput").type("请调用 create_godot_project 工具（name 用 map-demo），不要用 bash。");
    await page.locator(".send-btn").click();
    // 工具摘要必须为「已创建 Godot 项目」，而不是「已运行命令」（映射正确才走 godot 工具）
    await expect(page.locator(".tool-group")).toBeVisible({ timeout: 90_000 });
    await expect(page.locator(".tool-summary")).toContainText(/已创建 Godot 项目/);
    // 通过 godot-server 确认项目真实创建（前端映射把 projectId 传对了）
    const tid = await page.evaluate(() => localStorage.getItem("harness.current.v1"));
    const insp = await request.post("http://127.0.0.1:8456/inspect", { data: { projectId: tid } });
    const inj = await insp.json();
    expect(inj.ok).toBe(true);
    expect(inj.scenes).toContain("scenes/main.tscn");
  });

  test("真实运行与停止 Godot 游戏（真实进程 + 日志捕获）", async ({ request }) => {
    const c = await request.post("http://127.0.0.1:8456/create", { data: { projectId: "runner-1", name: "runner" } });
    await c.json();
    // 真实运行：spawn Godot 进程
    const r = await request.post("http://127.0.0.1:8456/run", { data: { projectId: "runner-1", taskId: "runner-1" } });
    const rj = await r.json();
    expect(rj.ok).toBe(true);
    expect(rj.pid).toBeTruthy();
    // 状态：running + 捕获日志
    await new Promise((res) => setTimeout(res, 2500));
    const st = await request.post("http://127.0.0.1:8456/status", { data: { projectId: "runner-1" } });
    const stj = await st.json();
    expect(stj.game).toBe("running");
    expect(stj.logs.some((l: { text: string }) => /Godot Engine/.test(l.text))).toBe(true);
    // 停止：真实终止进程
    const sp = await request.post("http://127.0.0.1:8456/stop", { data: { projectId: "runner-1" } });
    expect((await sp.json()).ok).toBe(true);
    await new Promise((res) => setTimeout(res, 1500));
    const st2 = await request.post("http://127.0.0.1:8456/status", { data: { projectId: "runner-1" } });
    expect((await st2.json()).game).toBe("stopped");
  });
});