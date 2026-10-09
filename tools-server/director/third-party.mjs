/* ============================================================================
 * Harness Director — 第三方来源与许可记录（单一事实来源）
 *
 * 本文件记录 Harness Director 在设计中综合参考的外部方法来源、许可证与
 * 被吸收（抽象为数据模型/工具/工作流）的内容。不复制外部 Skill 实质内容。
 * ==========================================================================*/

export const THIRD_PARTY_SOURCES = [
  {
    name: "山音超级导演大师 (shanyin-director-master)",
    repo: "https://github.com/Shanyin-ai/shanyin-director-master",
    license: "MIT",
    author: "Shanyin-ai",
    version: "（以仓库 HEAD 为准，未固定 commit）",
    introducedAt: "2026-08（Harness Director 设计阶段）",
    absorbed: [
      "每个镜头必须有叙事目的（镜头结束观众多知道/感受/预期什么）",
      "导演定调（director treatment）",
      "六维风格分析 → 抽象为 direction 字段与 visual bible 维度",
      "双轨节奏 → rhythm plan 的情节/情绪强度双轴",
      "镜头组（shot groups）",
      "剧本视听化微调（只写可见动作/可听声音）",
      "分镜阶段确认（gate）",
      "九列分镜结构 → 抽象为 Shot 结构化字段",
      "内部自检 → QC 质量清单",
    ],
    notice: "仅吸收方法论并抽象为 Harness 自有数据模型；不复制其代码或文案。保留 MIT 声明，不声称原创。",
  },
  {
    name: "Cinematic Director Skill (DirectorSKILL)",
    repo: "https://github.com/wuwangzhang1216/DirectorSKILL",
    license: "（引入前需核对仓库 LICENSE 文件；搜索结果未明确标注）",
    author: "wuwangzhang1216",
    version: "（未固定）",
    introducedAt: "2026-08",
    absorbed: [
      "Blocking before framing（先 Blocking 再摄影机设计）",
      "每个动作必须有明确结束状态",
      "每个镜头有限动作预算",
      "连续性 Bible",
      "关键帧 Prompt 与图生视频运动 Prompt 分离",
      "模型能力适配（Provider 能力编译）",
      "失败模式诊断（QC 升级路径）",
      "声音计划 / 剪辑时间线 / QC 修复",
    ],
    notice: "仅抽象为 Harness 的数据模型、Prompt 编译器与 QC 升级路径；不复制原文。",
  },
  {
    name: "Remotion Video Director",
    repo: "https://github.com/BayramAnnakov/remotion-video-director",
    license: "（引入前需核对仓库 LICENSE 文件）",
    author: "BayramAnnakov",
    version: "（未固定）",
    introducedAt: "2026-08",
    absorbed: [
      "目的、受众、观看后行动 → Creative Brief 字段",
      "情绪弧线 → story.emotionalArc / rhythm 情绪强度",
      "场景只服务一个核心信息",
      "可复用数据模板 → 结构化 Shot Packet",
      "渲染与预览 / 专家评分 / 用户反馈迭代",
    ],
    notice: "仅抽象方法论。",
  },
  {
    name: "Remotion 官方 Skills",
    repo: "https://github.com/remotion-dev/remotion/blob/main/packages/skills/README.md",
    license: "Remotion 为 source-available：个人/小团队免费，规模以上公司需商业许可；使用前务必核对官方 LICENSE.md 与商业条款",
    author: "remotion-dev",
    version: "（以仓库 LICENSE.md 为准）",
    introducedAt: "2026-08",
    absorbed: [
      "程序化视频 / 字幕 / 动画 / 音频 / 转场 / 视频模板 / 最终渲染 → 抽象为 Timeline 结构化数据 + 可替换渲染后端",
    ],
    notice: "Timeline 为结构化数据，可编译到 FFmpeg 或 Remotion；当前第一版默认编译到 FFmpeg。",
  },
  {
    name: "Storyboard Prompt Assistant (seaartpublic)",
    repo: "https://github.com/seaartpublic/skills/blob/main/skills/storyboard-prompt-assistant/SKILL.md",
    license: "（引入前需核对仓库 LICENSE 文件）",
    author: "seaartpublic",
    version: "（未固定）",
    introducedAt: "2026-08",
    absorbed: [
      "模型就绪的分镜 Prompt（主体/动作/空间/光线/景别/运镜明确）",
      "避免一个镜头塞入过多动作",
      "连续性说明",
      "增量修改时锁定未修改内容",
    ],
    notice: "仅抽象为 keyframe-prompt skill 的 checklist 与 Prompt 编译器规则。",
  },
];

export function thirdPartyNoticesMarkdown() {
  const lines = [
    "# Harness Director — 第三方来源与许可",
    "",
    "本页面记录 Harness Director 综合参考的外部方法来源、许可证与吸收方式。",
    "Harness Director 不复制外部 Skill 的实质内容；所有方法均已抽象为 Harness 自有的数据模型、",
    "结构化工具与阶段化工作流。",
    "",
  ];
  for (const s of THIRD_PARTY_SOURCES) {
    lines.push("## " + s.name);
    lines.push("");
    lines.push("- 仓库：" + s.repo);
    lines.push("- 许可证：" + s.license);
    lines.push("- 作者：" + s.author);
    lines.push("- 版本/Commit：" + s.version);
    lines.push("- 引入日期：" + s.introducedAt);
    lines.push("- 吸收内容：");
    for (const a of s.absorbed) lines.push("  - " + a);
    lines.push("- 说明：" + s.notice);
    lines.push("");
  }
  return lines.join("\n");
}
