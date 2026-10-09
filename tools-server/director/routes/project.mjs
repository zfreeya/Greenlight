/* ============================================================================
 * Harness Director — 项目域路由（project / story / bible / shots / scene）
 * 依赖注入：只使用 ctx（createDirectorContext 返回值），不直接 import 服务端内部模块。
 * ==========================================================================*/

/** 创建项目域路由表。ctx 见 server-context.mjs。 */
export default function createProjectRoutes(ctx) {
  const { T, GEN, loadProject, saveProject, nextSeq, findShot, compileGenerationPrompt, resolveProvider } = ctx;

  return {
    "/get_director_project": (b) => ({ ok: true, project: loadProject(String(b.projectId)) }),

    "/create_director_project": (b) => {
      const pid = String(b.projectId);
      const p = loadProject(pid);
      const fields = ["title", "format", "targetAudience", "targetPlatform", "targetDuration", "aspectRatio", "fps", "resolution", "language", "purpose", "coreMessage", "desiredAction", "productionMode", "budgetLimit", "deadline"];
      for (const f of fields) if (b[f] !== undefined) p[f] = b[f];
      if (b.title) p.title = b.title;
      p.phase = "intake";
      saveProject(p);
      return { ok: true, projectId: pid, phase: p.phase };
    },

    "/set_project_phase": (b) => {
      const p = loadProject(String(b.projectId));
      const target = String(b.phase);
      T.assertPhase(target);
      if (!p.completedPhases) p.completedPhases = [];
      const req = T.PHASE_REQUIRES[target] || [];
      if (!b.force && !req.every((x) => p.completedPhases.includes(x))) {
        return { ok: false, code: "dependency_not_met", required: req.filter((x) => !p.completedPhases.includes(x)), hint: "阶段依赖未完成，需先完成前置阶段并确认闸门。" };
      }
      const gate = ctx.GATE_FOR_PHASE[target];
      if (gate && !p.confirmations[gate] && !b.force) {
        return { ok: false, code: "gate_required", gate, hint: "该阶段需用户确认后才能进入。" };
      }
      p.phase = target;
      p.completedPhases = Array.from(new Set([...p.completedPhases, ...req]));
      saveProject(p);
      return { ok: true, phase: target, completedPhases: p.completedPhases };
    },

    "/confirm_gate": (b) => {
      const p = loadProject(String(b.projectId));
      const gate = String(b.gate);
      if (!ctx.GATES.includes(gate)) return { ok: false, code: "unknown_gate" };
      p.confirmations = p.confirmations || {};
      p.confirmations[gate] = { at: Date.now(), auto: Boolean(b.auto) };
      const phase = Object.keys(ctx.GATE_FOR_PHASE).find((ph) => ctx.GATE_FOR_PHASE[ph] === gate);
      if (phase && !p.completedPhases.includes(phase)) p.completedPhases.push(phase);
      saveProject(p);
      return { ok: true, gate, confirmedAt: Date.now() };
    },

    "/import_script": (b) => {
      const p = loadProject(String(b.projectId));
      p.importedScript = { text: String(b.script || ""), format: String(b.format || "text"), importedAt: Date.now() };
      saveProject(p);
      return { ok: true, scriptLength: p.importedScript.text.length };
    },

    "/analyze_script": (b) => {
      const p = loadProject(String(b.projectId));
      if (b.story && typeof b.story === "object") {
        p.story = { ...p.story, ...b.story };
        p.story.characters = Array.isArray(b.story.characters) ? b.story.characters : p.story.characters;
        p.story.scenes = Array.isArray(b.story.scenes) ? b.story.scenes : p.story.scenes;
      }
      saveProject(p);
      return { ok: true, story: p.story };
    },

    "/update_project_bible": (b) => {
      const p = loadProject(String(b.projectId));
      const section = String(b.section || "story");
      p.bible = p.bible || {};
      if (section === "characters") {
        const arr = Array.isArray(b.bible) ? b.bible : (b.bible?.characters || []);
        p.bible.characters = arr.map((c, i) => T.newCharacterBible(nextSeq(p, "char"), c));
      } else if (section === "locations") {
        const arr = Array.isArray(b.bible) ? b.bible : (b.bible?.locations || []);
        p.bible.locations = arr.map((l, i) => T.newLocationBible(nextSeq(p, "loc"), l));
      } else if (section === "visual") {
        p.bible.visual = { ...(p.bible.visual || {}), ...(b.bible || {}) };
      } else if (section === "continuity") {
        const arr = Array.isArray(b.bible) ? b.bible : (b.bible?.continuity || []);
        p.bible.continuity = arr.map((c, i) => T.newContinuityEntry(c.shotId, { ...c, seq: nextSeq(p, "bible") }));
      } else {
        p.bible.storyBible = { ...(p.bible.storyBible || {}), ...(b.bible || {}) };
      }
      saveProject(p);
      return { ok: true, bible: p.bible };
    },

    "/create_director_treatment": (b) => {
      const p = loadProject(String(b.projectId));
      p.directorTreatments = Array.isArray(b.treatments) ? b.treatments : [];
      p.selectedTreatment = b.selected ?? null;
      saveProject(p);
      return { ok: true, treatments: p.directorTreatments, selected: p.selectedTreatment };
    },

    "/create_rhythm_plan": (b) => {
      const p = loadProject(String(b.projectId));
      if (b.rhythmPlan && typeof b.rhythmPlan === "object") p.rhythmPlan = b.rhythmPlan;
      saveProject(p);
      return { ok: true, rhythmPlan: p.rhythmPlan };
    },

    "/create_shot_groups": (b) => {
      const p = loadProject(String(b.projectId));
      const groups = Array.isArray(b.groups) ? b.groups : [];
      p.shotGroups = groups.map((g) => ({ groupId: g.groupId || T.makeId("GRP", nextSeq(p, "group")), ...g }));
      saveProject(p);
      return { ok: true, shotGroups: p.shotGroups };
    },

    "/create_shot_list": (b) => {
      const p = loadProject(String(b.projectId));
      const shots = Array.isArray(b.shots) ? b.shots : [];
      const created = shots.map((s) => {
        const seq = nextSeq(p, "shot");
        const shot = T.newShot(seq, { ...s, shotId: s.shotId || T.makeId("SHOT", seq) });
        p.shots.push(shot);
        return shot;
      });
      saveProject(p);
      return { ok: true, shots: created, count: created.length };
    },

    "/update_shot": (b) => {
      const p = loadProject(String(b.projectId));
      const shot = findShot(p, String(b.shotId));
      if (b.status) {
        T.assertShotTransition(shot.status, b.status);
        shot.status = b.status;
      }
      if (b.patch && typeof b.patch === "object") {
        const GEN_FIELDS = new Set(["narrativePurpose", "subject", "startState", "primaryAction", "endState", "shotSize", "angle", "lens", "cameraPosition", "cameraMovement", "composition", "lighting", "color", "environment", "props", "dialogue", "sfx", "keyframePrompt", "motionPrompt", "keyframes"]);
        if (Object.keys(b.patch).some((k) => GEN_FIELDS.has(k))) {
          GEN.markGenerationDirty(shot, "镜头字段更新：" + Object.keys(b.patch).join(","));
        }
        Object.assign(shot, b.patch);
      }
      shot.updatedAt = Date.now();
      saveProject(p);
      return { ok: true, shot };
    },

    "/create_storyboard": (b) => {
      const p = loadProject(String(b.projectId));
      const boards = Array.isArray(b.storyboard) ? b.storyboard : [];
      p.storyboard = boards;
      saveProject(p);
      return { ok: true, storyboard: p.storyboard };
    },

    "/create_keyframe": (b) => {
      const p = loadProject(String(b.projectId));
      const shot = findShot(p, String(b.shotId));
      shot.keyframes = { ...(shot.keyframes || {}), ...(b.keyframes || {}) };
      if (b.keyframePrompt) shot.keyframePrompt = String(b.keyframePrompt);
      shot.status = "prompt_ready";
      shot.updatedAt = Date.now();
      saveProject(p);
      return { ok: true, shotId: shot.shotId, keyframes: shot.keyframes, keyframePrompt: shot.keyframePrompt };
    },

    "/compile_generation_prompt": (b) => {
      const p = loadProject(String(b.projectId));
      const shot = findShot(p, String(b.shotId));
      const provider = String(b.provider || "local-stub");
      const caps = resolveProvider(provider).getCapabilities();
      const compiled = compileGenerationPrompt(p, shot, caps, { stageSkill: b.stageSkill || "video-motion-prompt" });
      shot.compiledPrompt = compiled;
      shot.motionPrompt = compiled.motionPrompt;
      saveProject(p);
      return { ok: true, ...compiled };
    },

    "/create_scene": (b) => {
      const p = loadProject(String(b.projectId));
      const scene = T.newScene(nextSeq(p, "scene"), { ...(b.scene || {}) });
      p.scenes = p.scenes || [];
      p.scenes.push(scene);
      saveProject(p);
      return { ok: true, scene };
    },

    "/update_scene": (b) => {
      const p = loadProject(String(b.projectId));
      const scene = (p.scenes || []).find((s) => s.sceneId === String(b.sceneId));
      if (!scene) return { ok: false, code: "scene_not_found" };
      Object.assign(scene, b.patch || {});
      scene.updatedAt = Date.now();
      saveProject(p);
      return { ok: true, scene };
    },

    "/create_camera_bible": (b) => {
      const p = loadProject(String(b.projectId));
      const entry = T.newCameraBibleEntry(nextSeq(p, "bible"), b.entry || {});
      p.bible.camera = p.bible.camera || [];
      p.bible.camera.push(entry);
      saveProject(p);
      return { ok: true, entry };
    },

    "/create_sound_bible": (b) => {
      const p = loadProject(String(b.projectId));
      const entry = T.newSoundBibleEntry(nextSeq(p, "bible"), b.entry || {});
      p.bible.sound = p.bible.sound || [];
      p.bible.sound.push(entry);
      saveProject(p);
      return { ok: true, entry };
    },
  };
}
