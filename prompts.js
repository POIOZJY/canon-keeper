const MEMORY_PLACEHOLDER = '{{CANON_KEEPER_MEMORY}}';

export const MAIN_MEMORY_PROMPT = `
[Canon Keeper：最高优先级的长期设定契约]

以下内容是当前世界的有效事实，不是普通聊天记录、参考资料或可自由取舍的灵感。除非用户在当前剧情中明确要求并实际推进一项新变化，否则它优先于模型习惯、通用剧情套路、角色卡空白处以及与它冲突的较早聊天内容。

生成正文前必须在内部完成以下工作，但不要输出检查过程：
1. 将长期设定理解为一组同时成立的约束，包括实体、属性、关系、状态、时间条件、因果规律和世界规则。
2. 找出其中与当前场景直接或间接相关的全部约束；不得只挑选方便写作的一部分。
3. 把所有相关约束同时应用于人物、环境、事件和叙述含义。正文中的明示信息与合理暗示都不得否定它们。
4. 不得用常见套路、刻板默认值或模型自行补全的内容覆盖明确设定。设定没有说明的部分可以保持未知，但补全时必须与全部已知约束相容。
5. 省略某项设定不等于违反设定；但如果省略会使当前场景产生与设定相反或不相容的自然理解，就必须在正文中以符合叙事的方式处理该约束。
6. 当用户没有提供具体剧情、仅要求直接生成或续写时，以长期设定作为主要场景规划依据，而不是退回通用开场。
7. 不需要机械罗列无关设定；目标是让所有与本轮有关的事实都被真正使用，并使整段正文不存在显性或隐性的设定冲突。

<canon_keeper_memory>
${MEMORY_PLACEHOLDER}
</canon_keeper_memory>
`.trim();

export const FINAL_COMPLIANCE_REMINDER = `
[Canon Keeper：输出前最终一致性检查]
在输出正文前，把当前草稿与 Canon Keeper 长期设定做一次约束一致性核对：每个明示事实、合理暗示和必要省略都必须与本轮相关的全部已知约束相容。不得因用户本轮没有重复某项设定，就以通用套路或默认假设将其覆盖。发现冲突时先在内部修正草稿。只输出最终正文，不要输出检查过程。
`.trim();

export const CHANGE_DETECTION_SCHEMA = {
    name: 'CanonKeeperDecision',
    description: 'Decide whether completed story text changes long-term canon.',
    strict: true,
    value: {
        $schema: 'http://json-schema.org/draft-04/schema#',
        type: 'object',
        additionalProperties: false,
        properties: {
            result: { type: 'string', enum: ['no_change', 'changes'] },
            operations: {
                type: 'array',
                maxItems: 4,
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        type: { type: 'string', enum: ['replace_exact', 'remove_exact', 'add_long_term_fact'] },
                        old_text: { type: 'string' },
                        new_text: { type: 'string' },
                        text: { type: 'string' },
                        reason: { type: 'string' },
                        explicitness: { type: 'number', minimum: 0, maximum: 1 },
                        durability: { type: 'number', minimum: 0, maximum: 1 },
                        future_importance: { type: 'number', minimum: 0, maximum: 1 },
                    },
                    required: ['type', 'old_text', 'new_text', 'text', 'reason', 'explicitness', 'durability', 'future_importance'],
                },
            },
        },
        required: ['result', 'operations'],
    },
};

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
