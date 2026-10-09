/* ============================================================================
 * Harness Director — 非破坏性时间线（零依赖）
 *
 * video tracks / audio tracks / captions / markers / transitions / speed /
 * crop / transform / volume / fade / source in-out / version reference。
 * 底层为结构化数据，可编译到 FFmpeg / Remotion 等渲染后端。
 * ==========================================================================*/

export function ensureTimeline(project) {
  if (!project.timeline || !Array.isArray(project.timeline.videoTracks)) {
    project.timeline = {
      videoTracks: [{ id: "V1", clips: [] }],
      audioTracks: [{ id: "A1", clips: [] }, { id: "A2", clips: [] }],
      captions: [], markers: [], transitions: [],
      global: { width: 1920, height: 1080, fps: project.fps || 24, audioEnabled: true },
    };
  }
  return project.timeline;
}

export function placeClipOnTimeline(timeline, clip, opts = {}) {
  const track = timeline.videoTracks.find((t) => t.id === (opts.trackId || "V1")) || timeline.videoTracks[0];
  const start = opts.start ?? track.clips.reduce((max, c) => Math.max(max, c.end), 0);
  const duration = clip.duration || 5;
  const rec = {
    clipId: "TC-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6),
    shotId: clip.shotId || "",
    assetId: clip.assetId || "",
    versionRef: clip.versionRef || clip.assetId || "",
    start,
    end: start + duration,
    duration,
    sourceIn: opts.sourceIn ?? 0,
    sourceOut: opts.sourceOut ?? duration,
    speed: opts.speed ?? 1,
    crop: opts.crop || null,
    transform: opts.transform || null,
    volume: opts.volume ?? 1,
    fadeIn: opts.fadeIn ?? 0,
    fadeOut: opts.fadeOut ?? 0,
    label: clip.label || clip.shotId || "",
  };
  track.clips.push(rec);
  track.clips.sort((a, b) => a.start - b.start);
  return rec;
}

export function trimClip(timeline, clipId, start, end) {
  for (const t of timeline.videoTracks) {
    const c = t.clips.find((x) => x.clipId === clipId);
    if (c) { c.start = start; c.end = end; c.duration = end - start; return c; }
  }
  return null;
}

export function replaceClipVersion(timeline, clipId, assetId) {
  for (const t of timeline.videoTracks) {
    const c = t.clips.find((x) => x.clipId === clipId);
    if (c) { c.versionRef = assetId; c.assetId = assetId; return c; }
  }
  return null;
}

export function addTransition(timeline, fromClipId, toClipId, type) {
  const t = timeline.transitions;
  t.push({ id: "TR-" + t.length, from: fromClipId, to: toClipId, type: type || "cut", duration: 0.5 });
  return t[t.length - 1];
}

export function addCaption(timeline, text, start, end) {
  const c = { id: "CAP-" + timeline.captions.length, text, start, end, style: {} };
  timeline.captions.push(c);
  return c;
}

export function addMarker(timeline, time, label) {
  const m = { id: "MK-" + timeline.markers.length, time, label: label || "" };
  timeline.markers.push(m);
  return m;
}

export function addAudioClip(timeline, audio, opts = {}) {
  const track = timeline.audioTracks.find((t) => t.id === (opts.trackId || "A1")) || timeline.audioTracks[0];
  const start = opts.start ?? 0;
  const duration = audio.duration || 0;
  const rec = {
    clipId: "AC-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6),
    assetId: audio.assetId || "",
    label: audio.label || "",
    start, end: start + duration, duration,
    volume: opts.volume ?? 1,
    fadeIn: opts.fadeIn ?? 0,
    fadeOut: opts.fadeOut ?? 0,
    kind: audio.kind || "music", // dialogue | narration | ambience | foley | sfx | music | silence
  };
  track.clips.push(rec);
  track.clips.sort((a, b) => a.start - b.start);
  return rec;
}

export function totalDuration(timeline) {
  return timeline.videoTracks.reduce((max, t) => t.clips.reduce((m, c) => Math.max(m, c.end), max), 0);
}
