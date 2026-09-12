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
import { buildChangeDetectionPrompt, buildInjectionPrompt } from './prompts.js';

const MODULE_ID = 'canon_keeper';
const MODULE_PATH = 'third-party/canon-keeper';
const STATE_KEY = 'canon_keeper_state';
const PROMPT_KEY = 'canon_keeper_main_memory';
const POSITION_IN_CHAT = 1;
const ROLE_SYSTEM = 0;
const INJECTION_DEPTH = 0;

let pendingAssistantIndex = null;
let analysisRunning = false;
let workQueue = Promise.resolve();
let uiReady = false;

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
    const prompt = state?.enabled && effective ? buildInjectionPrompt(effective) : '';
    ctx.setExtensionPrompt(PROMPT_KEY, prompt, POSITION_IN_CHAT, INJECTION_DEPTH, false, ROLE_SYSTEM);
    return effective;
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
        target.textContent = '0 tokens';
        return;
    }
    try {
        const ctx = context();
        const count = await ctx.getTokenCountAsync(effectiveText);
        const ratio = ctx.maxContext ? count / ctx.maxContext : 0;
        target.textContent = `${count} tokens（上下文约 ${(ratio * 100).toFixed(1)}%）`;
        target.classList.toggle('ck-warning', ratio > 0.3);
    } catch {
        target.textContent = `约 ${effectiveText.length} 字符`;
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

function renderHistory(state, materialized) {
    const container = document.querySelector('#ck_history');
    if (!container) return;
    const active = new Set(materialized.appliedTransactionIds);
    if (!state.transactions.length) {
        container.innerHTML = '<div class="ck-empty">暂无自动修改记录</div>';
        return;
    }
    container.innerHTML = [...state.transactions].reverse().map(transaction => {
        const status = active.has(transaction.id) ? '生效中' : '已随消息撤回';
        const lines = (transaction.operations ?? []).map(summarizeOperation).join('<br>');
        return `<div class="ck-history-item ${active.has(transaction.id) ? 'is-active' : 'is-inactive'}">
            <div><strong>${status}</strong> · 消息位置 ${Number(transaction.sourceIndex) + 1}</div>
            <div>${escapeHtml(lines).replaceAll('&lt;br&gt;', '<br>')}</div>
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
    const effective = refreshInjection();
    await updateTokenDisplay(effective);
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

function recordAnalysis(state, fingerprint, outcome, note = '') {
    state.analyzed.push({ fingerprint, outcome, note: String(note).slice(0, 300), at: Date.now() });
    state.analyzed = state.analyzed.slice(-1000);
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
        const raw = await ctx.generateQuietPrompt({
            quietPrompt,
            skipWIAN: true,
            responseLength: 700,
            removeReasoning: true,
        });
        const parsed = parseModelJson(raw);
        if (!parsed) {
            recordAnalysis(state, fingerprint, 'error', '后台返回的 JSON 无法解析');
            await saveState(state);
            setStatus('后台结果格式错误，本轮未修改', 'error');
            return;
        }

        if (parsed.result === 'no_change' || !Array.isArray(parsed.operations) || !parsed.operations.length) {
            recordAnalysis(state, fingerprint, 'no_change');
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
        recordAnalysis(state, fingerprint, transaction ? 'changed' : 'rejected', errors.join('；'));
        await saveState(state);
        setStatus(transaction
            ? `已静默更新 ${transaction.operations.length} 项长期设定`
            : `检测到候选变化，但校验未通过：${errors.join('；') || '无有效操作'}`,
        transaction ? 'ok' : 'error');
    } catch (error) {
        console.error(`[${MODULE_ID}] background analysis failed`, error);
        setStatus(`后台检查失败，本轮未修改：${error.message}`, 'error');
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
