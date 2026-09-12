const MEMORY_PLACEHOLDER = '{{CANON_KEEPER_MEMORY}}';

export const MAIN_MEMORY_PROMPT = `
[Canon Keeper：当前有效的长期设定]

以下内容是本次对话的当前有效长期设定。它不是普通聊天记录，而是必须持续遵守的世界事实。
生成正文时，请优先吸收并遵守这些内容；不要擅自反转、忽略或润色它们。只有剧情在正文中明确完成了长期、稳定的改变，旧事实才会在之后由 Canon Keeper 更新。

<canon_keeper_memory>
${MEMORY_PLACEHOLDER}
</canon_keeper_memory>
`.trim();

export const CHANGE_DETECTION_PROMPT = `
你是 Canon Keeper 的后台审计器。你的唯一任务是检查“最新一轮已经完成的剧情正文”是否改变了当前长期设定。

【基本原则】
1. 这里只记录跨越多个场景仍然成立、会明显影响未来剧情理解的长期事实。
2. 不记录情绪、动作、姿势、衣着、天气、时间、临时地点、普通短期伤势、一次性对话、普通战斗过程、无关路人、临时计划或决定。
3. 不把猜测、可能性、谎言、梦境、幻觉、假设、比喻、角色误解、尚未完成的事件或 AI 自己说错设定当成事实变化。
4. 只有正文明确表明变化已经发生，才能修改。不得依靠推论补全。
5. 不得重写或整理整段设定。只能返回精确、最小的操作。

【修改已有内容】
- old_text 必须逐字复制当前设定中唯一存在的连续原文。
- new_text 只能改变必要字词，保留原句措辞、语气、格式和标点。
- 例如“角色A是女的”只能最小改成“角色A是男的”，不得润色为“角色A是男性”。
- 事实被彻底抹除时才可使用 remove_exact；删除范围必须精确且尽量小。

【新增长期事实】
- 只有“明确、长期、重要、现有设定没有”的事实可以新增。
- 每轮最多新增一条。
- 不可逆事件（死亡、结婚、继位、永久毁灭等）可立即新增。
- 普通新属性只有在正文明确确认且长期重要时才可新增。
- 不能因为“以后可能有用”就新增，也不能新增可从现有设定直接推出的内容。
- 新增内容必须是一句简短、独立、无修辞的事实，并对 explicitness、durability、future_importance 分别给出 0 到 1 的评分。

【输出】
只输出一个 JSON 对象，不要 Markdown，不要解释。没有合格变化时：
{"result":"no_change","operations":[]}

有变化时使用以下操作之一：
{"result":"changes","operations":[
  {"type":"replace_exact","old_text":"原文","new_text":"最小修改后的文字","reason":"依据"},
  {"type":"remove_exact","old_text":"要删除的精确原文","reason":"依据"},
  {"type":"add_long_term_fact","text":"新增的一句长期事实","reason":"依据","explicitness":0.95,"durability":0.95,"future_importance":0.95}
]}

不要为了凑操作而修改。宁可返回 no_change，也不要记录不确定或短期内容。
`.trim();

export function buildInjectionPrompt(memoryText) {
    return MAIN_MEMORY_PROMPT.replace(MEMORY_PLACEHOLDER, String(memoryText ?? '').trim());
}

export function buildChangeDetectionPrompt({ memoryText, userMessage, assistantMessage }) {
    return `${CHANGE_DETECTION_PROMPT}

<current_memory>
${String(memoryText ?? '')}
</current_memory>

<latest_user_message>
${String(userMessage ?? '')}
</latest_user_message>

<latest_assistant_body>
${String(assistantMessage ?? '')}
</latest_assistant_body>`;
}
