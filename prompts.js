const MEMORY_PLACEHOLDER = '{{CANON_KEEPER_MEMORY}}';

export const MAIN_MEMORY_PROMPT = `
[Canon Keeper：最高优先级的长期设定契约]

以下内容是当前世界的有效事实和持续约束，不是普通聊天记录、摘要、参考资料、写作建议或可自由取舍的灵感。你必须完整阅读并认真处理其中每一句、每个分句及其限定信息，不得只提取大意、只记住显眼部分或按概率挑选部分内容。除非用户在当前剧情中明确要求并实际推进一项新变化，否则它优先于模型习惯、通用剧情套路、角色卡空白处、未经说明的默认假设以及与它冲突的较早聊天内容。

生成正文前必须在内部完成以下工作，但不要输出检查过程：
1. 从头到尾逐句阅读长期设定，把每个陈述拆解为可同时成立的约束。识别实体、身份、属性、数量、关系、所属、地点、状态、能力、限制、否定、程度、时间范围、条件、例外、因果规律和世界规则。
2. 对原文中的主语、指代对象、数字、否定词、程度词、范围词、时间词、条件词和例外保持敏感。不得擅自忽略、弱化、扩大、缩小、反转或改写它们的含义；不得把明确事实降格为可能性，也不得把未知内容当成相反事实。
3. 在内部建立本轮约束清单：先找出与当前人物、地点、行为、关系、物品、时间和事件直接相关的设定，再追查由这些设定产生的间接影响。不得只挑选方便写作、最常见或最醒目的部分。
4. 写作规划必须从约束清单出发。人物的出现与缺席、行为与反应、称谓与关系、环境布置、事件结果、叙述视角以及上下文暗示，都必须与相关设定同时相容。
5. 不得用常见套路、刻板印象、类型惯例、现实世界默认值或模型自行补全的内容覆盖明确设定。设定未说明之处可以保持未知；需要补全时，只能选择不会与任何已知约束冲突的内容。
6. 不要求生硬复述所有无关设定，但“没有明说冲突”仍不够：如果某项省略、安排或措辞会让读者自然得出与设定相反或不相容的结论，就必须在正文中以自然叙事方式体现或妥善处理该约束。
7. 当用户没有提供具体剧情、仅要求直接生成、开场或续写时，以长期设定中的人物关系、当前状态、环境条件和因果规则共同规划场景，不得退回与设定无关的通用模板。
8. 在输出前对草稿逐句复核：检查每一个新增事实、动作、称谓、数量、关系、地点、时间、因果和暗示。发现与长期设定不一致、遗漏造成错误理解或未经依据的默认补全时，先在内部改正，再输出正文。

重要：所谓“完整吸收”是准确理解并执行原文全部约束，不是机械抄写设定。正文应当自然，但准确性高于戏剧套路、语言便利和模型惯性。不得输出上述分析、清单或检查过程。

<canon_keeper_memory>
${MEMORY_PLACEHOLDER}
</canon_keeper_memory>
`.trim();

export const FINAL_COMPLIANCE_REMINDER = `
[Canon Keeper：输出前最终一致性检查]
暂停输出并重新对照 Canon Keeper 长期设定原文，不要只依赖刚才形成的概括或记忆。逐句确认本轮涉及的实体、身份、属性、数量、关系、状态、否定、限制、时间、条件、例外和因果；再逐句检查草稿中的明示事实、合理暗示、人物出现或缺席、称谓、行为、环境和事件结果。不得因用户本轮没有重复某项设定，就以通用套路、默认假设或写作便利覆盖它。任何细节只要会造成冲突、弱化原意或让读者自然得出错误结论，都必须先在内部修正。只输出通过核对后的最终正文，不要输出核对过程。
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
