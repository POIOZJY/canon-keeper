import {
    createEmptyState,
    formatEffectiveMemory,
    getActiveAssistantFingerprints,
    materializeState,
    messageFingerprint,
    normalizeState,
    parseModelJson,
    validateTransaction,
} from './memory.js';
import {
    buildChangeDetectionPrompt,
    buildInjectionPrompt,
    CHANGE_DETECTION_SCHEMA,
    FINAL_COMPLIANCE_REMINDER,
} from './prompts.js';

const MODULE_ID = 'canon_keeper';
const MODULE_PATH = 'third-party/canon-keeper';
const STATE_KEY = 'canon_keeper_state';
const MEMORY_PROMPT_KEY = 'canon_keeper_main_memory';
const REMINDER_PROMPT_KEY = 'canon_keeper_final_compliance';
const POSITION_IN_PROMPT = 0;
const POSITION_IN_CHAT = 1;
const ROLE_SYSTEM = 0;
const INJECTION_DEPTH = 0;

let pendingAssistantIndex = null;
let analysisRunning = false;
let workQueue = Promise.resolve();
let uiReady = false;
const structuredOutputSupport = new Map();

function context() {
    return SillyTavern.getContext();
}

function hasOpenChat(ctx = context()) {
    return Boolean(ctx.groupId) || ctx.characterId !== undefined;
}

function getState({ create = true } = {}) {
    const ctx = context();
    if (!hasOpenChat(ctx)) return null;
    const raw = ctx.chatMetadata?.[STATE_KEY];
    if (!raw && !create) return null;
    const state = normalizeState(raw ?? createEmptyState());
    ctx.chatMetadata[STATE_KEY] = state;
    return state;
}

async function saveState(state) {
    const ctx = context();
    if (!hasOpenChat(ctx)) return;
    state.updatedAt = Date.now();
    ctx.chatMetadata[STATE_KEY] = state;
    await ctx.saveMetadata();
}

function getMaterialized(state = getState()) {
    if (!state) return { userText: '', additions: [], appliedTransactionIds: [], skipped: [] };
    return materializeState(state, getActiveAssistantFingerprints(context().chat));
}

function refreshInjection() {
    const ctx = context();
    const state = getState({ create: false });
    const effective = state ? formatEffectiveMemory(getMaterialized(state)) : '';
    const memoryPrompt = state?.enabled && effective ? buildInjectionPrompt(effective) : '';
    const reminderPrompt = memoryPrompt ? FINAL_COMPLIANCE_REMINDER : '';

    // 完整设定进入主提示区，覆盖对 system 消息位置处理不同的 API。
    ctx.setExtensionPrompt(MEMORY_PROMPT_KEY, memoryPrompt, POSITION_IN_PROMPT, INJECTION_DEPTH, false, ROLE_SYSTEM);
    // 简短核对规则放在聊天最末端，避免长设定导致开头指令失去注意力。
    ctx.setExtensionPrompt(REMINDER_PROMPT_KEY, reminderPrompt, POSITION_IN_CHAT, INJECTION_DEPTH, false, ROLE_SYSTEM);
    return memoryPrompt ? `${memoryPrompt}\n\n${reminderPrompt}` : '';
}

function setStatus(text, kind = 'idle') {
    const element = document.querySelector('#ck_status');
    if (!element) return;
    element.textContent = text;
    element.dataset.kind = kind;
}

function escapeHtml(value) {
    const element = document.createElement('div');
    element.textContent = String(value ?? '');
    return element.innerHTML;
}

async function updateTokenDisplay(effectiveText) {
    const target = document.querySelector('#ck_tokens');
    if (!target) return;
    if (!effectiveText) {
        target.textContent = '实际注入：0 tokens';
        return;
    }
    try {
        const ctx = context();
        const count = await ctx.getTokenCountAsync(effectiveText);
        const ratio = ctx.maxContext ? count / ctx.maxContext : 0;
        target.textContent = `实际注入：${count} tokens（上下文约 ${(ratio * 100).toFixed(1)}%）`;
        target.classList.toggle('ck-warning', ratio > 0.3);
    } catch {
        target.textContent = `实际注入：约 ${effectiveText.length} 字符`;
    }
}

function renderAdditions(materialized) {
    const container = document.querySelector('#ck_additions');
    if (!container) return;
    if (!materialized.additions.length) {
        container.innerHTML = '<div class="ck-empty">暂无剧情确认的长期补充</div>';
        return;
    }
    container.innerHTML = materialized.additions
        .map(item => `<div class="ck-fact"><span>${escapeHtml(item.text)}</span></div>`)
        .join('');
}

function summarizeOperation(operation) {
    if (operation.type === 'add_long_term_fact') return `新增：${operation.text}`;
    if (operation.type === 'remove_exact') return `删除：${operation.old_text}`;
    return `替换：${operation.old_text} → ${operation.new_text}`;
}

function analysisLabel(outcome) {
    return {
        changed: '已更新长期设定',
        no_change: '没有长期变化',
        rejected: '候选修改未通过校验',
        error: '后台输出无法解析，设定未变',
        request_error: '后台请求失败，设定未变',
        baseline: '手动保存时已存在',
        cleared: '已清空自动记录',
    }[outcome] ?? '检查记录';
}

function renderHistory(state, materialized) {
    const container = document.querySelector('#ck_history');
    if (!container) return;
    const active = new Set(materialized.appliedTransactionIds);
    const analyses = [...state.analyzed].reverse().slice(0, 50);
    if (!analyses.length) {
        container.innerHTML = '<div class="ck-empty">暂无后台检查记录</div>';
        return;
    }
    container.innerHTML = analyses.map(analysis => {
        const transaction = [...state.transactions].reverse()
            .find(item => item.sourceFingerprint === analysis.fingerprint);
        const isActive = transaction ? active.has(transaction.id) : true;
        const operationText = transaction
            ? (transaction.operations ?? []).map(summarizeOperation).map(escapeHtml).join('<br>')
            : '';
        const position = Number.isInteger(Number(analysis.sourceIndex))
            ? ` · 消息位置 ${Number(analysis.sourceIndex) + 1}`
            : '';
        const note = analysis.note ? `<div class="ck-history-note">${escapeHtml(analysis.note)}</div>` : '';
        const raw = analysis.rawOutput
            ? `<details class="ck-raw"><summary>查看后台原始输出</summary><pre>${escapeHtml(analysis.rawOutput)}</pre></details>`
            : '';
        const lifecycle = transaction ? ` · ${isActive ? '生效中' : '已随消息撤回'}` : '';
        return `<div class="ck-history-item ${isActive ? 'is-active' : 'is-inactive'}" data-outcome="${escapeHtml(analysis.outcome)}">
            <div><strong>${escapeHtml(analysisLabel(analysis.outcome))}</strong>${position}${lifecycle}</div>
            ${operationText ? `<div>${operationText}</div>` : ''}
            ${note}${raw}
        </div>`;
    }).join('');
}

async function renderState() {
    if (!uiReady) return;
    const state = hasOpenChat() ? getState() : null;
    const textarea = document.querySelector('#ck_memory_text');
    const controls = document.querySelectorAll('.ck-requires-chat');
    controls.forEach(element => { element.disabled = !state; });
    document.querySelector('#ck_no_chat')?.classList.toggle('is-hidden', Boolean(state));
    if (!state) {
        if (textarea) textarea.value = '';
        renderAdditions({ additions: [] });
        document.querySelector('#ck_history').innerHTML = '<div class="ck-empty">请先打开一个聊天</div>';
        const preview = document.querySelector('#ck_prompt_preview');
        if (preview) preview.textContent = '';
        updateTokenDisplay('');
        setStatus('未打开聊天');
        return;
    }

    const materialized = getMaterialized(state);
    if (textarea && document.activeElement !== textarea) textarea.value = materialized.userText;
    document.querySelector('#ck_enabled').checked = state.enabled;
    document.querySelector('#ck_auto_update').checked = state.autoUpdate;
    document.querySelector('#ck_allow_additions').checked = state.allowAdditions;
    document.querySelector('#ck_addition_ratio').value = Math.round(state.additionRatio * 100);
    renderAdditions(materialized);
    renderHistory(state, materialized);
    const actualInjection = refreshInjection();
    const preview = document.querySelector('#ck_prompt_preview');
    if (preview) preview.textContent = actualInjection;
    await updateTokenDisplay(actualInjection);
}

function enqueue(task) {
    workQueue = workQueue.then(task, task).catch(error => {
        console.error(`[${MODULE_ID}]`, error);
        setStatus(`发生错误：${error.message}`, 'error');
    });
    return workQueue;
}

function latestUserMessageBefore(index) {
    const chat = context().chat;
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
        if (chat[cursor]?.is_user) return String(chat[cursor].mes ?? '');
    }
    return '';
}

function alreadyAnalyzed(state, fingerprint) {
    return state.analyzed.some(item => item.fingerprint === fingerprint);
}

function recordAnalysis(state, fingerprint, outcome, note = '', sourceIndex = null, rawOutput = '') {
    state.analyzed.push({
        fingerprint,
        outcome,
        note: String(note).slice(0, 500),
        sourceIndex,
        rawOutput: String(rawOutput ?? '').slice(0, 1500),
        at: Date.now(),
    });
    state.analyzed = state.analyzed.slice(-1000);
}

function isValidDecision(parsed) {
    if (!parsed || !['no_change', 'changes'].includes(parsed.result) || !Array.isArray(parsed.operations)) return false;
    if (parsed.result === 'no_change') return parsed.operations.length === 0;
    return parsed.operations.length > 0;
}

function connectionKey(ctx) {
    let model = '';
    try {
        model = ctx.getChatCompletionModel?.() ?? '';
    } catch {
        model = '';
    }
    return `${ctx.mainApi}:${model}`;
}

async function requestChangeDecision(ctx, quietPrompt) {
    const baseOptions = {
        quietPrompt,
        skipWIAN: true,
        responseLength: 700,
        removeReasoning: true,
    };
    const key = connectionKey(ctx);
    const mayUseSchema = ctx.mainApi === 'openai' && structuredOutputSupport.get(key) !== false;

    if (mayUseSchema) {
        try {
            const raw = await ctx.generateQuietPrompt({ ...baseOptions, jsonSchema: CHANGE_DETECTION_SCHEMA });
            const parsed = parseModelJson(raw);
            if (isValidDecision(parsed)) {
                structuredOutputSupport.set(key, true);
                return { raw, parsed, usedFallback: false };
            }
            structuredOutputSupport.set(key, false);
        } catch (error) {
            console.warn(`[${MODULE_ID}] structured output unavailable; falling back`, error);
            structuredOutputSupport.set(key, false);
        }
    }

    const raw = await ctx.generateQuietPrompt(baseOptions);
    const parsed = parseModelJson(raw);
    return { raw, parsed: isValidDecision(parsed) ? parsed : null, usedFallback: mayUseSchema };
}

async function analyzeAssistantMessage(index, { force = false } = {}) {
    const ctx = context();
    const state = getState({ create: false });
    const message = ctx.chat?.[index];
    if (!state?.enabled || !state.autoUpdate || !state.baselineText.trim()) return;
    if (!message || message.is_user || message.is_system || !String(message.mes ?? '').trim()) return;

    const fingerprint = messageFingerprint(message);
    if (!force && alreadyAnalyzed(state, fingerprint)) return;
    if (force) state.analyzed = state.analyzed.filter(item => item.fingerprint !== fingerprint);

    analysisRunning = true;
    setStatus('正在后台检查长期设定变化…', 'busy');
    try {
        const activeFingerprints = getActiveAssistantFingerprints(ctx.chat);
        const memoryText = formatEffectiveMemory(materializeState(state, activeFingerprints));
        const quietPrompt = buildChangeDetectionPrompt({
            memoryText,
            userMessage: latestUserMessageBefore(index),
            assistantMessage: message.mes,
        });
        const { raw, parsed, usedFallback } = await requestChangeDecision(ctx, quietPrompt);
        if (!parsed) {
            recordAnalysis(state, fingerprint, 'error', '后台 AI 没有按规定返回有效结果', index, raw);
            await saveState(state);
            setStatus('检查未完成：后台输出格式无效；设定没有变化', 'warning');
            return;
        }

        if (parsed.result === 'no_change') {
            recordAnalysis(state, fingerprint, 'no_change', usedFallback ? '已使用兼容模式解析' : '', index, raw);
            await saveState(state);
            setStatus('检查完成：没有长期设定变化', 'ok');
            return;
        }

        const { transaction, errors } = validateTransaction({
            state,
            activeFingerprints,
            sourceFingerprint: fingerprint,
            sourceIndex: index,
            rawOperations: parsed.operations,
        });
        if (transaction) state.transactions.push(transaction);
        recordAnalysis(state, fingerprint, transaction ? 'changed' : 'rejected', errors.join('；'), index, raw);
        await saveState(state);
        setStatus(transaction
            ? `已静默更新 ${transaction.operations.length} 项长期设定`
            : `检测到候选变化，但校验未通过：${errors.join('；') || '无有效操作'}`,
        transaction ? 'ok' : 'error');
    } catch (error) {
        console.error(`[${MODULE_ID}] background analysis failed`, error);
        recordAnalysis(state, fingerprint, 'request_error', error.message, index);
        await saveState(state);
        setStatus(`后台请求失败；设定没有变化：${error.message}`, 'warning');
    } finally {
        analysisRunning = false;
        await renderState();
    }
}

async function reconcileAfterChatMutation() {
    refreshInjection();
    await renderState();
}

function downloadJson(filename, payload) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
}

async function bindUi() {
    const ctx = context();
    const html = await ctx.renderExtensionTemplateAsync(MODULE_PATH, 'settings');
    document.querySelector('#extensions_settings2')?.insertAdjacentHTML('beforeend', html);
    uiReady = true;

    document.querySelector('#ck_save')?.addEventListener('click', () => enqueue(async () => {
        const state = getState();
        if (!state) return;
        state.baselineText = document.querySelector('#ck_memory_text').value;
        state.transactions = [];
        state.analyzed = [...getActiveAssistantFingerprints(context().chat)]
            .map(fingerprint => ({ fingerprint, outcome: 'baseline', note: '手动保存时已存在', at: Date.now() }));
        await saveState(state);
        setStatus('已保存为新的设定基准；旧自动记录已归零', 'ok');
        await renderState();
    }));

    for (const [selector, key] of [
        ['#ck_enabled', 'enabled'],
        ['#ck_auto_update', 'autoUpdate'],
        ['#ck_allow_additions', 'allowAdditions'],
    ]) {
        document.querySelector(selector)?.addEventListener('change', event => enqueue(async () => {
            const state = getState();
            if (!state) return;
            state[key] = event.target.checked;
            await saveState(state);
            await renderState();
        }));
    }

    document.querySelector('#ck_addition_ratio')?.addEventListener('change', event => enqueue(async () => {
        const state = getState();
        if (!state) return;
        state.additionRatio = Math.min(1, Math.max(0.05, Number(event.target.value) / 100 || 0.25));
        await saveState(state);
        await renderState();
    }));

    document.querySelector('#ck_retry')?.addEventListener('click', () => enqueue(async () => {
        const chat = context().chat;
        const index = chat.findLastIndex(message => message && !message.is_user && !message.is_system);
        if (index >= 0) await analyzeAssistantMessage(index, { force: true });
    }));

    document.querySelector('#ck_clear_auto')?.addEventListener('click', () => enqueue(async () => {
        const state = getState();
        if (!state) return;
        state.transactions = [];
        state.analyzed = [...getActiveAssistantFingerprints(context().chat)]
            .map(fingerprint => ({ fingerprint, outcome: 'cleared', note: '用户清空自动记录', at: Date.now() }));
        await saveState(state);
        setStatus('已清空所有自动修改和补充', 'ok');
        await renderState();
    }));

    document.querySelector('#ck_export')?.addEventListener('click', () => {
        const state = getState({ create: false });
        if (state) downloadJson(`canon-keeper-${Date.now()}.json`, { schema: STATE_KEY, state });
    });

    document.querySelector('#ck_import')?.addEventListener('change', event => enqueue(async () => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        try {
            const parsed = JSON.parse(await file.text());
            const imported = normalizeState(parsed?.state ?? parsed);
            await saveState(imported);
            setStatus('导入完成', 'ok');
            await renderState();
        } catch (error) {
            setStatus(`导入失败：${error.message}`, 'error');
        }
    }));

    await renderState();
}

function registerEvents() {
    const ctx = context();
    const events = ctx.eventTypes;

    ctx.eventSource.on(events.CHARACTER_MESSAGE_RENDERED, index => {
        if (analysisRunning || !Number.isInteger(Number(index))) return;
        pendingAssistantIndex = Number(index);
    });

    ctx.eventSource.on(events.GENERATION_ENDED, () => {
        if (analysisRunning || pendingAssistantIndex === null) return;
        const index = pendingAssistantIndex;
        pendingAssistantIndex = null;
        enqueue(() => analyzeAssistantMessage(index));
    });

    for (const event of [events.MESSAGE_DELETED, events.MESSAGE_EDITED, events.MESSAGE_SWIPED]) {
        ctx.eventSource.on(event, () => enqueue(reconcileAfterChatMutation));
    }

    ctx.eventSource.on(events.CHAT_CHANGED, () => {
        pendingAssistantIndex = null;
        enqueue(reconcileAfterChatMutation);
    });
}

async function initialize() {
    registerEvents();
    refreshInjection();
    await bindUi();
    console.info(`[${MODULE_ID}] initialized`);
}

const ctx = context();
if (ctx.eventTypes.APP_READY) {
    ctx.eventSource.on(ctx.eventTypes.APP_READY, initialize);
} else {
    initialize();
}
