export const STATE_VERSION = 1;
export const AUTO_SECTION_TITLE = '【剧情确认的长期补充】';

const DEFAULTS = Object.freeze({
    version: STATE_VERSION,
    enabled: true,
    autoUpdate: true,
    allowAdditions: true,
    additionRatio: 0.25,
    baselineText: '',
    transactions: [],
    analyzed: [],
    updatedAt: 0,
});

export function createEmptyState() {
    return structuredClone(DEFAULTS);
}

export function normalizeState(raw) {
    const state = { ...createEmptyState(), ...(raw && typeof raw === 'object' ? raw : {}) };
    state.version = STATE_VERSION;
    state.enabled = state.enabled !== false;
    state.autoUpdate = state.autoUpdate !== false;
    state.allowAdditions = state.allowAdditions !== false;
    state.additionRatio = clampNumber(state.additionRatio, 0.05, 1, 0.25);
    state.baselineText = String(state.baselineText ?? '');
    state.transactions = Array.isArray(state.transactions) ? state.transactions.filter(Boolean) : [];
    state.analyzed = Array.isArray(state.analyzed) ? state.analyzed.filter(Boolean).slice(-1000) : [];
    state.updatedAt = Number(state.updatedAt) || 0;
    return state;
}

function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

export function hashText(value) {
    const text = String(value ?? '');
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

export function messageFingerprint(message) {
    if (!message || typeof message !== 'object') return '';
    return hashText(JSON.stringify([
        message.send_date ?? '',
        message.name ?? '',
        message.mes ?? '',
        message.swipe_id ?? '',
    ]));
}

export function getActiveAssistantFingerprints(chat) {
    return new Set((Array.isArray(chat) ? chat : [])
        .filter(message => message && !message.is_user && !message.is_system)
        .map(messageFingerprint)
        .filter(Boolean));
}

function countExact(haystack, needle) {
    if (!needle) return 0;
    let count = 0;
    let offset = 0;
    while ((offset = haystack.indexOf(needle, offset)) !== -1) {
        count += 1;
        offset += Math.max(1, needle.length);
    }
    return count;
}

function normalizeFact(value) {
    return String(value ?? '')
        .toLocaleLowerCase()
        .replace(/[\s，。！？、；：“”‘’（）()《》〈〉【】\-—…,.!?;:'"`]/g, '');
}

function isMinimalReplacement(oldText, newText) {
    if (oldText.length <= 12) return true;

    let prefix = 0;
    const minLength = Math.min(oldText.length, newText.length);
    while (prefix < minLength && oldText[prefix] === newText[prefix]) prefix += 1;

    let suffix = 0;
    while (
        suffix < minLength - prefix
        && oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
    ) suffix += 1;

    const preserved = prefix + suffix;
    const changedOld = oldText.length - preserved;
    const changedNew = newText.length - preserved;
    return preserved >= Math.floor(minLength * 0.4)
        && changedOld <= Math.max(80, Math.ceil(oldText.length * 0.6))
        && changedNew <= Math.max(80, Math.ceil(newText.length * 0.6));
}

function cloneMaterialized(materialized) {
    return {
        userText: String(materialized.userText ?? ''),
        additions: (materialized.additions ?? []).map(item => ({ ...item })),
    };
}

function locateExact(materialized, oldText) {
    const userCount = countExact(materialized.userText, oldText);
    const additionMatches = [];
    materialized.additions.forEach((item, index) => {
        const count = countExact(item.text, oldText);
        if (count) additionMatches.push({ index, count });
    });
    const total = userCount + additionMatches.reduce((sum, item) => sum + item.count, 0);
    if (total !== 1) return null;
    if (userCount === 1) return { kind: 'user' };
    return { kind: 'addition', index: additionMatches[0].index };
}

function applyOperation(materialized, operation, sourceFingerprint) {
    const next = cloneMaterialized(materialized);

    if (operation.type === 'add_long_term_fact') {
        const normalized = normalizeFact(operation.text);
        const duplicate = normalizeFact(formatEffectiveMemory(next)).includes(normalized);
        if (!normalized || duplicate) return { ok: false, error: '新增内容为空或重复', value: materialized };
        next.additions.push({
            id: operation.id,
            text: operation.text,
            reason: operation.reason,
            sourceFingerprint,
        });
        return { ok: true, value: next };
    }

    const oldText = String(operation.old_text ?? '');
    const target = locateExact(next, oldText);
    if (!target) return { ok: false, error: '待修改原文不存在或出现多次', value: materialized };
    const replacement = operation.type === 'remove_exact' ? '' : String(operation.new_text ?? '');

    if (target.kind === 'user') {
        next.userText = next.userText.replace(oldText, replacement);
    } else {
        next.additions[target.index].text = next.additions[target.index].text.replace(oldText, replacement);
        if (!next.additions[target.index].text.trim()) next.additions.splice(target.index, 1);
    }
    return { ok: true, value: next };
}

export function materializeState(stateInput, activeFingerprints = new Set()) {
    const state = normalizeState(stateInput);
    let value = { userText: state.baselineText, additions: [] };
    const appliedTransactionIds = [];
    const skipped = [];

    for (const transaction of state.transactions) {
        if (!activeFingerprints.has(transaction.sourceFingerprint)) continue;
        let candidate = cloneMaterialized(value);
        let valid = true;
        for (const operation of transaction.operations ?? []) {
            const result = applyOperation(candidate, operation, transaction.sourceFingerprint);
            if (!result.ok) {
                valid = false;
                skipped.push({ transactionId: transaction.id, error: result.error });
                break;
            }
            candidate = result.value;
        }
        if (valid) {
            value = candidate;
            appliedTransactionIds.push(transaction.id);
        }
    }

    return { ...value, appliedTransactionIds, skipped };
}

export function formatEffectiveMemory(materialized) {
    const userText = String(materialized?.userText ?? '').trim();
    const additions = (materialized?.additions ?? [])
        .map(item => String(item.text ?? '').trim())
        .filter(Boolean);
    if (!additions.length) return userText;
    const autoText = `${AUTO_SECTION_TITLE}\n${additions.map(text => `- ${text}`).join('\n')}`;
    return userText ? `${userText}\n\n${autoText}` : autoText;
}

function sanitizeOperation(raw, index) {
    if (!raw || typeof raw !== 'object') return null;
    const type = String(raw.type ?? '');
    const reason = String(raw.reason ?? '').trim().slice(0, 300);
    if (type === 'replace_exact') {
        return {
            id: `op-${index}`,
            type,
            old_text: String(raw.old_text ?? ''),
            new_text: String(raw.new_text ?? ''),
            reason,
        };
    }
    if (type === 'remove_exact') {
        return { id: `op-${index}`, type, old_text: String(raw.old_text ?? ''), reason };
    }
    if (type === 'add_long_term_fact') {
        return {
            id: `fact-${index}`,
            type,
            text: String(raw.text ?? '').trim(),
            reason,
            explicitness: Number(raw.explicitness),
            durability: Number(raw.durability),
            future_importance: Number(raw.future_importance),
        };
    }
    return null;
}

export function validateTransaction({ state: stateInput, activeFingerprints, sourceFingerprint, sourceIndex, rawOperations }) {
    const state = normalizeState(stateInput);
    const errors = [];
    const providedOperations = Array.isArray(rawOperations) ? rawOperations : [];
    if (providedOperations.length > 4) errors.push('单轮操作数量超过上限');
    const operations = providedOperations.slice(0, 4).map((operation, index) => {
        const sanitized = sanitizeOperation(operation, index);
        if (!sanitized) errors.push('包含未知或无效的操作类型');
        return sanitized;
    }).filter(Boolean);
    let materialized = materializeState(state, activeFingerprints);
    const accepted = [];
    let additionCount = 0;

    for (const operation of operations) {
        if (operation.type === 'add_long_term_fact') {
            additionCount += 1;
            const scores = [operation.explicitness, operation.durability, operation.future_importance];
            const additionChars = materialized.additions.reduce((sum, item) => sum + item.text.length, 0);
            const additionBudget = Math.max(240, Math.floor(materialized.userText.length * state.additionRatio));
            if (!state.allowAdditions) errors.push('已关闭自动新增');
            else if (additionCount > 1) errors.push('每轮最多新增一条');
            else if (operation.text.length < 4 || operation.text.length > 180 || /[\r\n]/.test(operation.text)) errors.push('新增事实长度或格式不合格');
            else if (scores.some(score => !Number.isFinite(score) || score < 0.9 || score > 1)) errors.push('新增事实评分不足');
            else if (materialized.additions.length >= 50 || additionChars + operation.text.length > additionBudget) errors.push('自动补充区已达到上限');
            else {
                const result = applyOperation(materialized, operation, sourceFingerprint);
                if (result.ok) {
                    accepted.push(operation);
                    materialized = result.value;
                } else errors.push(result.error);
            }
            continue;
        }

        const oldText = operation.old_text;
        if (!oldText || oldText.length > 400) {
            errors.push('待修改原文为空或过长');
            continue;
        }
        if (operation.type === 'replace_exact') {
            if (!operation.new_text || operation.new_text === oldText || operation.new_text.length > 400) {
                errors.push('替换文本为空、未变化或过长');
                continue;
            }
            if (!oldText.includes('\n') && operation.new_text.includes('\n')) {
                errors.push('不允许把单行原文扩写为多行');
                continue;
            }
            if (!isMinimalReplacement(oldText, operation.new_text)) {
                errors.push('替换范围不是最小修改');
                continue;
            }
        }
        const result = applyOperation(materialized, operation, sourceFingerprint);
        if (result.ok) {
            accepted.push(operation);
            materialized = result.value;
        } else errors.push(result.error);
    }

    // 同一轮候选修改必须整体通过，防止模型输出中只有部分内容被意外采纳。
    if (!accepted.length || errors.length) return { transaction: null, errors };
    const now = Date.now();
    accepted.forEach((operation, index) => {
        operation.id = `${sourceFingerprint}-${now}-${index}`;
    });
    return {
        transaction: {
            id: `tx-${sourceFingerprint}-${now}`,
            sourceFingerprint,
            sourceIndex,
            createdAt: now,
            operations: accepted,
        },
        errors,
    };
}

export function parseModelJson(value) {
    const text = String(value ?? '').trim();
    if (!text) return null;
    if (/^(?:no[_\s-]?change|无(?:长期设定)?变化|没有(?:长期设定)?变化|无需修改|不需要修改)[。.!！]?$/i.test(text)) {
        return { result: 'no_change', operations: [] };
    }
    const unfenced = text
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
    try {
        return JSON.parse(unfenced);
    } catch {
        let depth = 0;
        let start = -1;
        let inString = false;
        let escaped = false;
        for (let index = 0; index < unfenced.length; index += 1) {
            const char = unfenced[index];
            if (inString) {
                if (escaped) escaped = false;
                else if (char === '\\') escaped = true;
                else if (char === '"') inString = false;
                continue;
            }
            if (char === '"') {
                inString = true;
                continue;
            }
            if (char === '{') {
                if (depth === 0) start = index;
                depth += 1;
            } else if (char === '}' && depth > 0) {
                depth -= 1;
                if (depth === 0 && start !== -1) {
                    try {
                        return JSON.parse(unfenced.slice(start, index + 1));
                    } catch {
                        start = -1;
                    }
                }
            }
        }
        return null;
    }
}

export function resolveContextLimit(ctx = {}) {
    const chatCompletionLimit = Number(ctx.chatCompletionSettings?.openai_max_context);
    const genericLimit = Number(ctx.maxContext);

    // OpenAI-compatible Chat Completion providers (including DeepSeek) keep
    // their context setting separately from the generic completion setting.
    if (ctx.mainApi === 'openai' && Number.isFinite(chatCompletionLimit) && chatCompletionLimit > 0) {
        return chatCompletionLimit;
    }
    return Number.isFinite(genericLimit) && genericLimit > 0 ? genericLimit : 0;
}
