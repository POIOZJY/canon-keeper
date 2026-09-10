/* Canon Keeper — per-chat canonical world state for SillyTavern. */

(() => {
    'use strict';

    const MODULE_NAME = 'canon-keeper';
    const METADATA_KEY = 'canon_keeper';
    const PROMPT_KEY = 'canon_keeper_authoritative_context';
    const SCHEMA_VERSION = 2;
    const IN_CHAT_PROMPT_POSITION = 1;
    const SYSTEM_PROMPT_ROLE = 0;
    const MAX_FACT_LENGTH = 600;
    const MAX_ANALYSIS_MESSAGES = 8;
    const MAX_REVALIDATION_MESSAGES = 36;

    let context = null;
    let settingsMounted = false;
    let queueRunning = false;
    let queue = [];
    let queueKeys = new Set();
    let delayedInvalidations = new Map();

    const DEFAULT_SETTINGS = {
        api: {
            enabled: false,
            endpoint: '',
            apiKey: '',
            model: '',
            timeoutMs: 30000,
        },
        automation: {
            enabled: true,
        },
    };

    function deepClone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function now() {
        return new Date().toISOString();
    }

    function makeId(prefix) {
        const random = globalThis.crypto?.randomUUID?.().replace(/-/g, '').slice(0, 12)
            || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        return `${prefix}_${random}`;
    }

    function htmlEscape(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function cleanText(value, maximum = MAX_FACT_LENGTH) {
        return String(value ?? '')
            .replace(/[\r\n]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, maximum);
    }

    function normalisedText(value) {
        return cleanText(value).toLocaleLowerCase();
    }

    function uniqueNumbers(values) {
        return [...new Set((Array.isArray(values) ? values : [])
            .map(value => Number(value))
            .filter(value => Number.isInteger(value) && value >= 0))];
    }

    function unionNumbers(...lists) {
        return uniqueNumbers(lists.flat());
    }

    function toast(kind, message) {
        const api = globalThis.toastr;
        if (api?.[kind]) {
            api[kind](message);
        }
    }

    function setStatus(message, kind = '') {
        const element = globalThis.jQuery?.('#canon_keeper_status');
        if (!element?.length) return;
        element.text(message).removeClass('is-error is-warning is-success');
        if (kind) element.addClass(`is-${kind}`);
    }

    function setApiStatus(message, kind = '') {
        const element = globalThis.jQuery?.('#canon_keeper_api_status');
        if (!element?.length) return;
        element.text(message).removeClass('is-error is-warning is-success');
        if (kind) element.addClass(`is-${kind}`);
    }

    async function resolveContext() {
        if (globalThis.SillyTavern?.getContext) {
            return globalThis.SillyTavern.getContext();
        }

        try {
            const module = await import('../../../st-context.js');
            if (module.getContext) return module.getContext();
        } catch (error) {
            console.warn('[Canon Keeper] st-context unavailable, trying legacy exports.', error);
        }

        try {
            const module = await import('../../../../script.js');
            return {
                chat: module.chat,
                chatMetadata: module.chat_metadata,
                eventSource: module.eventSource,
                eventTypes: module.event_types,
                extensionSettings: module.extension_settings,
                getCurrentChatId: module.getCurrentChatId,
                maxContext: module.max_context,
                saveMetadata: module.saveMetadata,
                saveSettingsDebounced: module.saveSettingsDebounced,
                setExtensionPrompt: module.setExtensionPrompt,
                getTokenCountAsync: module.getTokenCountAsync,
            };
        } catch (error) {
            throw new Error(`无法取得 SillyTavern 扩展接口：${error.message}`);
        }
    }

    async function refreshContext() {
        context = await resolveContext();
        return context;
    }

    function currentChatKey() {
        return String(context?.getCurrentChatId?.() || context?.chatId || '');
    }

    function isChatAvailable() {
        return Boolean(context?.chatMetadata && typeof context.chatMetadata === 'object');
    }

    function createEmptyState() {
        return {
            schemaVersion: SCHEMA_VERSION,
            facts: [],
            history: [],
            versions: [],
            nextVersion: 1,
            lastAnalyzedFingerprint: '',
            lastAnalysisAt: '',
        };
    }

    function makeRecord(text, source = 'manual', sourceMessageIds = []) {
        const timestamp = now();
        return {
            id: makeId('fact'),
            text: cleanText(text),
            active: true,
            pendingValidation: false,
            source,
            sourceMessageIds: uniqueNumbers(sourceMessageIds),
            createdAt: timestamp,
            updatedAt: timestamp,
        };
    }

    function migrateState(raw) {
        if (!raw || typeof raw !== 'object') return createEmptyState();
        if (raw.schemaVersion === SCHEMA_VERSION && Array.isArray(raw.facts) && Array.isArray(raw.history)) {
            raw.versions = Array.isArray(raw.versions) ? raw.versions : [];
            raw.nextVersion = Number.isInteger(raw.nextVersion) ? raw.nextVersion : raw.versions.length + 1;
            raw.lastAnalyzedFingerprint = String(raw.lastAnalyzedFingerprint || '');
            return raw;
        }

        const migrated = createEmptyState();
        const canonLines = String(raw.canon || '')
            .split(/\r?\n/)
            .map(line => cleanText(line))
            .filter(Boolean);
        const historyLines = String(raw.history || '')
            .split(/\r?\n/)
            .map(line => cleanText(line))
            .filter(Boolean);

        migrated.facts = canonLines.map(line => makeRecord(line, 'manual'));
        migrated.history = historyLines.map(line => makeRecord(line, 'manual'));
        if (canonLines.length || historyLines.length) {
            migrated.versions.push({
                number: 1,
                at: now(),
                origin: 'migration',
                reason: 'Migrated Canon Keeper data from the earlier text-only format.',
                sourceMessageIds: [],
                operations: [],
                before: { facts: [], history: [] },
                after: snapshot(migrated),
            });
            migrated.nextVersion = 2;
        }
        return migrated;
    }

    function getState() {
        if (!isChatAvailable()) throw new Error('请先打开一个聊天。');
        const metadata = context.chatMetadata;
        metadata[METADATA_KEY] = migrateState(metadata[METADATA_KEY]);
        return metadata[METADATA_KEY];
    }

    function snapshot(state) {
        return {
            facts: deepClone(state.facts),
            history: deepClone(state.history),
        };
    }

    function restoreSnapshot(state, saved) {
        state.facts = deepClone(saved?.facts || []);
        state.history = deepClone(saved?.history || []);
    }

    function visibleRecords(records) {
        return records.filter(record => record?.active !== false && !record?.pendingValidation && cleanText(record?.text));
    }

    function addVersion(state, { origin, reason, sourceMessageIds = [], operations = [], before, after }) {
        const number = state.nextVersion++;
        state.versions.push({
            number,
            at: now(),
            origin,
            reason: cleanText(reason, 900),
            sourceMessageIds: uniqueNumbers(sourceMessageIds),
            operations: deepClone(operations),
            before: deepClone(before),
            after: deepClone(after),
        });
        return number;
    }

    async function saveMetadata() {
        if (typeof context?.saveMetadata === 'function') {
            await context.saveMetadata();
            return;
        }
        if (typeof context?.saveChat === 'function') {
            await context.saveChat();
            return;
        }
        throw new Error('此 SillyTavern 版本没有可用的聊天 metadata 保存接口。');
    }

    function buildCanonPrompt(state = getState()) {
        const canon = visibleRecords(state.facts).map(record => `- ${record.text}`).join('\n');
        const history = visibleRecords(state.history).map(record => `- ${record.text}`).join('\n');
        if (!canon && !history) return '';

        return [
            '<CANON_KEEPER_CURRENT_WORLD>',
            'This is authoritative current-world context for this chat, supplied by Canon Keeper.',
            'Treat CURRENT CANON as the established present state of this story. Keep it consistent while roleplaying.',
            'HISTORY ANCHORS only explain why the present is this way; they do not override CURRENT CANON.',
            'Do not turn temporary scene details, moods, travel, ordinary dialogue, fights, injuries, or reactions into permanent facts.',
            'Do not invent canon. A later, explicitly established and lasting story change may supersede an older canon fact.',
            'Follow any provider-level system or developer instruction that conflicts with this contextual reference.',
            '',
            '[CURRENT CANON]',
            canon || '(No Canon Keeper facts have been recorded for this chat.)',
            '',
            '[HISTORY ANCHORS]',
            history || '(No history anchors have been recorded.)',
            '</CANON_KEEPER_CURRENT_WORLD>',
        ].join('\n');
    }

    async function applyCanonPrompt() {
        if (!context) await refreshContext();
        if (typeof context?.setExtensionPrompt !== 'function') {
            throw new Error('此 SillyTavern 版本没有 setExtensionPrompt 接口。');
        }
        const prompt = isChatAvailable() ? buildCanonPrompt() : '';
        await context.setExtensionPrompt(
            PROMPT_KEY,
            prompt,
            IN_CHAT_PROMPT_POSITION,
            0,
            false,
            SYSTEM_PROMPT_ROLE,
        );
    }

    function getGlobalSettings() {
        const settingsRoot = context?.extensionSettings;
        if (!settingsRoot || typeof settingsRoot !== 'object') return deepClone(DEFAULT_SETTINGS);
        if (!settingsRoot[MODULE_NAME] || typeof settingsRoot[MODULE_NAME] !== 'object') {
            settingsRoot[MODULE_NAME] = deepClone(DEFAULT_SETTINGS);
        }
        const settings = settingsRoot[MODULE_NAME];
        settings.api = { ...DEFAULT_SETTINGS.api, ...(settings.api || {}) };
        settings.automation = { ...DEFAULT_SETTINGS.automation, ...(settings.automation || {}) };
        return settings;
    }

    function saveGlobalSettings() {
        if (typeof context?.saveSettingsDebounced === 'function') {
            context.saveSettingsDebounced();
        }
    }

    function apiIsReady(settings = getGlobalSettings()) {
        return Boolean(
            settings.api.enabled
            && cleanText(settings.api.endpoint, 2000)
            && cleanText(settings.api.model, 200),
        );
    }

    function normaliseEndpoint(rawEndpoint) {
        let endpoint = cleanText(rawEndpoint, 2000).replace(/\/+$/, '');
        if (!endpoint) return '';
        if (/\/chat\/completions$/i.test(endpoint)) return endpoint;
        if (/\/v1$/i.test(endpoint)) return `${endpoint}/chat/completions`;
        return `${endpoint}/v1/chat/completions`;
    }

    function contentFromApiResponse(data) {
        const content = data?.choices?.[0]?.message?.content;
        if (Array.isArray(content)) {
            return content.map(part => part?.text || part?.content || '').join('');
        }
        return String(content || '');
    }

    async function callIndependentApi(messages, maxTokens = 900) {
        const settings = getGlobalSettings();
        if (!apiIsReady(settings)) throw new Error('独立 API 尚未启用或配置不完整。');

        const endpoint = normaliseEndpoint(settings.api.endpoint);
        const headers = { 'Content-Type': 'application/json' };
        if (cleanText(settings.api.apiKey, 1000)) {
            headers.Authorization = `Bearer ${String(settings.api.apiKey).trim()}`;
        }

        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), Number(settings.api.timeoutMs) || 30000);
        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers,
                signal: controller.signal,
                body: JSON.stringify({
                    model: String(settings.api.model).trim(),
                    messages,
                    temperature: 0,
                    max_tokens: maxTokens,
                }),
            });
            const responseText = await response.text();
            let data = {};
            try { data = responseText ? JSON.parse(responseText) : {}; } catch { /* handled below */ }
            if (!response.ok) {
                const detail = cleanText(data?.error?.message || responseText || response.statusText, 500);
                throw new Error(`API HTTP ${response.status}${detail ? `：${detail}` : ''}`);
            }
            const content = contentFromApiResponse(data);
            if (!content) throw new Error('API 返回成功，但没有 choices[0].message.content。');
            return content;
        } catch (error) {
            if (error?.name === 'AbortError') throw new Error('独立 API 请求超时。');
            throw error;
        } finally {
            window.clearTimeout(timeout);
        }
    }

    function getMessageRecords(limit = MAX_ANALYSIS_MESSAGES) {
        const chat = Array.isArray(context?.chat) ? context.chat : [];
        const records = [];
        for (let index = 0; index < chat.length; index++) {
            const message = chat[index];
            if (!message || message.is_system || !cleanText(message.mes, 10000)) continue;
            records.push({
                id: index,
                role: message.is_user ? 'user' : 'assistant',
                swipeId: Number.isInteger(message.swipe_id) ? message.swipe_id : 0,
                text: String(message.mes).slice(0, 3500),
            });
        }
        return records.slice(-limit);
    }

    function newestAssistantMessageId() {
        const chat = Array.isArray(context?.chat) ? context.chat : [];
        for (let index = chat.length - 1; index >= 0; index--) {
            const message = chat[index];
            if (message && !message.is_user && !message.is_system && cleanText(message.mes, 10000)) return index;
        }
        return null;
    }

    function messageFingerprint(messageId) {
        const message = context?.chat?.[messageId];
        if (!message) return '';
        const text = String(message.mes || '');
        let hash = 0;
        for (let index = 0; index < text.length; index++) {
            hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
        }
        return `${messageId}:${Number(message.swipe_id || 0)}:${hash}:${text.length}`;
    }

    function formatTranscript(records) {
        return records.map(record => [
            `[Message ${record.id}; role=${record.role}; swipe=${record.swipeId}]`,
            record.text,
        ].join('\n')).join('\n\n');
    }

    function analyzerMessages(state, transcript) {
        const facts = visibleRecords(state.facts)
            .map(record => `- id=${record.id} | ${record.text}`)
            .join('\n') || '(none)';
        const history = visibleRecords(state.history)
            .map(record => `- ${record.text}`)
            .join('\n') || '(none)';

        return [
            {
                role: 'system',
                content: [
                    'You maintain a compact CURRENT CANON for one roleplay chat. This is not a memory or recap system.',
                    'Default to NO_CHANGE. Patch only when the transcript explicitly establishes a durable, stable change to the current world state.',
                    'Valid Canon: enduring world rules/background; lasting identity, relationship, faction, organization, important place, social structure, ability/limitation; or a permanently changed result such as death, destruction, succession, or a new regime.',
                    'Never record temporary location, clothing, action, mood, ordinary dialogue, travel, ordinary fight process, hug, kiss, argument, crying, temporary injury, short task, or inferred personality trait.',
                    'Do not infer permanence. If uncertain, output NO_CHANGE. Prefer omission over a wrong fact.',
                    'Never rewrite the whole Canon. Return only a JSON object, with no markdown or explanation outside JSON.',
                ].join(' '),
            },
            {
                role: 'user',
                content: [
                    'CURRENT CANON FACTS (IDs are required for UPDATE and DELETE):', facts,
                    '',
                    'HISTORY ANCHORS:', history,
                    '',
                    'NEW TRANSCRIPT:', transcript,
                    '',
                    'Return exactly this schema:',
                    '{"decision":"NO_CHANGE"|"PATCH","reason":"short reason","operations":[{"type":"ADD"|"UPDATE"|"DELETE","target_id":"required only for UPDATE/DELETE","fact":"required for ADD/UPDATE","reason":"why this is explicit and lasting","source_message_ids":[message IDs from NEW TRANSCRIPT],"history_anchor":"optional, only if essential to explain the new present state"}]}',
                    'Rules for source_message_ids: use only IDs visibly shown in NEW TRANSCRIPT; include the direct evidence; never invent an ID. An UPDATE replaces one existing fact. DELETE is only for a fact explicitly made false, not merely unmentioned. A history_anchor must be very short and must not be a recap.',
                ].join('\n'),
            },
        ];
    }

    function extractJsonObject(raw) {
        const text = String(raw || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
        const start = text.indexOf('{');
        if (start < 0) throw new Error('AI 没有返回 JSON 对象。');
        let depth = 0;
        let quoted = false;
        let escaped = false;
        for (let index = start; index < text.length; index++) {
            const character = text[index];
            if (quoted) {
                if (escaped) escaped = false;
                else if (character === '\\') escaped = true;
                else if (character === '"') quoted = false;
                continue;
            }
            if (character === '"') quoted = true;
            else if (character === '{') depth++;
            else if (character === '}') {
                depth--;
                if (depth === 0) return JSON.parse(text.slice(start, index + 1));
            }
        }
        throw new Error('AI 返回的 JSON 不完整。');
    }

    function validatePatch(rawPatch, state, availableMessageIds) {
        const patch = extractJsonObject(rawPatch);
        if (String(patch?.decision || '').toUpperCase() !== 'PATCH') return { decision: 'NO_CHANGE', reason: cleanText(patch?.reason, 500), operations: [] };
        const validIds = new Set(availableMessageIds);
        const existing = new Map(state.facts.filter(record => record?.id).map(record => [record.id, record]));
        const operations = [];

        for (const proposed of Array.isArray(patch.operations) ? patch.operations.slice(0, 8) : []) {
            const type = String(proposed?.type || '').toUpperCase();
            const targetId = String(proposed?.target_id || '');
            const fact = cleanText(proposed?.fact);
            const sourceMessageIds = uniqueNumbers(proposed?.source_message_ids).filter(id => validIds.has(id));
            const reason = cleanText(proposed?.reason, 500);
            const historyAnchor = cleanText(proposed?.history_anchor, 500);
            if (!['ADD', 'UPDATE', 'DELETE'].includes(type) || !reason || !sourceMessageIds.length) continue;
            if (type === 'ADD') {
                if (!fact) continue;
                const duplicate = visibleRecords(state.facts).some(record => normalisedText(record.text) === normalisedText(fact));
                if (duplicate) continue;
            }
            if (type === 'UPDATE') {
                if (!fact || !existing.has(targetId)) continue;
                if (normalisedText(existing.get(targetId).text) === normalisedText(fact)) continue;
            }
            if (type === 'DELETE' && !existing.has(targetId)) continue;
            operations.push({ type, targetId, fact, reason, sourceMessageIds, historyAnchor });
        }
        return operations.length ? { decision: 'PATCH', reason: cleanText(patch.reason, 500), operations } : { decision: 'NO_CHANGE', reason: cleanText(patch?.reason, 500), operations: [] };
    }

    function applyPatch(state, patch, triggerFingerprint) {
        const before = snapshot(state);
        const operations = [];
        let changed = false;

        for (const proposed of patch.operations) {
            let target;
            if (proposed.type === 'ADD') {
                target = makeRecord(proposed.fact, 'ai', proposed.sourceMessageIds);
                state.facts.push(target);
                operations.push({
                    type: 'ADD', targetKind: 'fact', targetId: target.id,
                    before: null, after: deepClone(target), reason: proposed.reason,
                    sourceMessageIds: proposed.sourceMessageIds,
                });
                changed = true;
            } else {
                target = state.facts.find(record => record.id === proposed.targetId);
                if (!target) continue;
                const prior = deepClone(target);
                target.pendingValidation = false;
                target.source = 'ai';
                target.sourceMessageIds = uniqueNumbers(proposed.sourceMessageIds);
                target.updatedAt = now();
                if (proposed.type === 'UPDATE') {
                    target.text = proposed.fact;
                    target.active = true;
                }
                if (proposed.type === 'DELETE') target.active = false;
                operations.push({
                    type: proposed.type, targetKind: 'fact', targetId: target.id,
                    before: prior, after: deepClone(target), reason: proposed.reason,
                    sourceMessageIds: proposed.sourceMessageIds,
                });
                changed = true;
            }

            if (proposed.historyAnchor) {
                const duplicate = visibleRecords(state.history)
                    .some(record => normalisedText(record.text) === normalisedText(proposed.historyAnchor));
                if (!duplicate) {
                    const anchor = makeRecord(proposed.historyAnchor, 'ai', proposed.sourceMessageIds);
                    anchor.id = makeId('history');
                    state.history.push(anchor);
                    operations.push({
                        type: 'ADD', targetKind: 'history', targetId: anchor.id,
                        before: null, after: deepClone(anchor), reason: proposed.reason,
                        sourceMessageIds: proposed.sourceMessageIds,
                    });
                }
            }
        }

        state.lastAnalyzedFingerprint = triggerFingerprint;
        state.lastAnalysisAt = now();
        if (!changed) return false;
        const after = snapshot(state);
        addVersion(state, {
            origin: 'ai',
            reason: patch.reason || 'Independent AI applied a conservative Canon patch.',
            sourceMessageIds: unionNumbers(...operations.map(operation => operation.sourceMessageIds)),
            operations,
            before,
            after,
        });
        return true;
    }

    function linesFromTextarea(selector) {
        return String(globalThis.jQuery?.(selector).val() || '')
            .split(/\r?\n/)
            .map(line => cleanText(line))
            .filter(Boolean)
            .filter((line, index, lines) => lines.findIndex(other => normalisedText(other) === normalisedText(line)) === index);
    }

    function syncManualLines(records, lines, kind) {
        const active = visibleRecords(records);
        const byText = new Map(active.map(record => [normalisedText(record.text), record]));
        const wanted = new Set(lines.map(normalisedText));
        const operations = [];

        for (const record of active) {
            if (!wanted.has(normalisedText(record.text))) {
                const before = deepClone(record);
                record.active = false;
                record.pendingValidation = false;
                record.source = 'manual';
                record.sourceMessageIds = [];
                record.updatedAt = now();
                operations.push({ type: 'DELETE', targetKind: kind, targetId: record.id, before, after: deepClone(record), reason: 'Manual editor removed this entry.', sourceMessageIds: [] });
            }
        }

        for (const line of lines) {
            if (byText.has(normalisedText(line))) continue;
            const record = makeRecord(line, 'manual');
            if (kind === 'history') record.id = makeId('history');
            records.push(record);
            operations.push({ type: 'ADD', targetKind: kind, targetId: record.id, before: null, after: deepClone(record), reason: 'Manual editor added this entry.', sourceMessageIds: [] });
        }
        return operations;
    }

    async function saveManualEditor() {
        const state = getState();
        const before = snapshot(state);
        const operations = [
            ...syncManualLines(state.facts, linesFromTextarea('#canon_keeper_canon'), 'fact'),
            ...syncManualLines(state.history, linesFromTextarea('#canon_keeper_history'), 'history'),
        ];
        if (operations.length) {
            addVersion(state, {
                origin: 'manual',
                reason: 'Manual Canon or History edit.',
                operations,
                before,
                after: snapshot(state),
            });
            await saveMetadata();
            await applyCanonPrompt();
            setStatus('已保存到当前聊天，并已更新注入内容。', 'success');
            toast('success', 'Canon Keeper：当前聊天设定已保存');
        } else {
            setStatus('没有需要保存的变化。');
        }
        await refreshUi();
    }

    function operationSummary(operation) {
        const before = operation.before?.text ? `“${operation.before.text}”` : '（无）';
        const after = operation.after?.text ? `“${operation.after.text}”` : '（已移除）';
        return `${operation.type}：${before} → ${after}`;
    }

    function renderVersions(state) {
        const target = globalThis.jQuery?.('#canon_keeper_versions');
        if (!target?.length) return;
        if (!state.versions.length) {
            target.html('<div class="canon-keeper-empty">还没有版本记录。</div>');
            return;
        }
        const markup = [...state.versions].reverse().map(version => {
            const sources = version.sourceMessageIds.length ? `来源消息：${version.sourceMessageIds.join(', ')}` : '来源：手动或系统操作';
            const operations = version.operations.length
                ? version.operations.map(operation => `<li>${htmlEscape(operationSummary(operation))}</li>`).join('')
                : '<li>数据格式迁移</li>';
            return [
                '<article class="canon-keeper-version">',
                `<div class="canon-keeper-version-head"><b>版本 ${version.number}</b><span>${htmlEscape(new Date(version.at).toLocaleString())}</span></div>`,
                `<div>${htmlEscape(version.reason || '无说明')}</div>`,
                `<small>${htmlEscape(sources)} · ${htmlEscape(version.origin)}</small>`,
                `<ul>${operations}</ul>`,
                `<button type="button" class="menu_button canon-keeper-restore" data-version="${version.number}">恢复到这次修改之前</button>`,
                '</article>',
            ].join('');
        }).join('');
        target.html(markup);
    }

    async function restoreVersionBefore(number) {
        const state = getState();
        const selected = state.versions.find(version => Number(version.number) === Number(number));
        if (!selected) throw new Error('找不到该版本。');
        const before = snapshot(state);
        restoreSnapshot(state, selected.before);
        addVersion(state, {
            origin: 'restore',
            reason: `Restored the state from before version ${selected.number}.`,
            operations: [{ type: 'RESTORE', targetKind: 'state', targetId: String(selected.number), before, after: snapshot(state), reason: `Restore before version ${selected.number}.`, sourceMessageIds: [] }],
            before,
            after: snapshot(state),
        });
        await saveMetadata();
        await applyCanonPrompt();
        await refreshUi();
        setStatus(`已恢复到版本 ${selected.number} 修改前的状态。`, 'success');
        toast('success', 'Canon Keeper：已恢复旧版本');
    }

    function captureSession() {
        return {
            chatKey: currentChatKey(),
            metadata: context?.chatMetadata,
        };
    }

    async function isSameSession(session) {
        await refreshContext();
        return context?.chatMetadata === session.metadata && currentChatKey() === session.chatKey;
    }

    function enqueue(work) {
        if (queueKeys.has(work.key)) return;
        queueKeys.add(work.key);
        queue.push(work);
        void processQueue();
    }

    async function processQueue() {
        if (queueRunning) return;
        queueRunning = true;
        try {
            while (queue.length) {
                const work = queue.shift();
                queueKeys.delete(work.key);
                try {
                    if (work.type === 'analysis') await processAnalysis(work);
                    if (work.type === 'revalidate') await processRevalidation(work);
                } catch (error) {
                    console.warn('[Canon Keeper] Background work failed:', error);
                    if (await isSameSession(work.session)) {
                        setStatus(`后台维护未完成：${cleanText(error.message, 160)}`, 'warning');
                    }
                }
            }
        } finally {
            queueRunning = false;
        }
    }

    function queueAnalysis(messageId, manual = false) {
        const settings = getGlobalSettings();
        if (!apiIsReady(settings)) {
            if (manual) setStatus('独立 API 未启用或配置不完整，无法分析。', 'warning');
            return;
        }
        if (!manual && !settings.automation.enabled) return;
        const fingerprint = messageFingerprint(messageId);
        if (!fingerprint) return;
        const state = getState();
        if (!manual && state.lastAnalyzedFingerprint === fingerprint) return;
        const session = captureSession();
        const records = getMessageRecords(MAX_ANALYSIS_MESSAGES);
        if (!records.some(record => record.id === messageId)) return;
        enqueue({
            type: 'analysis',
            key: `analysis:${session.chatKey}:${fingerprint}`,
            session,
            messageId,
            fingerprint,
            records,
            manual,
        });
        if (manual) setStatus('正在后台分析最新剧情；不会阻塞角色回复。');
    }

    async function processAnalysis(work) {
        if (!await isSameSession(work.session)) return;
        if (messageFingerprint(work.messageId) !== work.fingerprint) return;
        const state = getState();
        const raw = await callIndependentApi(analyzerMessages(state, formatTranscript(work.records)));
        if (!await isSameSession(work.session)) return;
        if (messageFingerprint(work.messageId) !== work.fingerprint) return;
        const currentState = getState();
        const patch = validatePatch(raw, currentState, work.records.map(record => record.id));
        const changed = applyPatch(currentState, patch, work.fingerprint);
        await saveMetadata();
        if (changed) {
            await applyCanonPrompt();
            setStatus(`后台 AI 已应用 ${patch.operations.length} 个保守 Canon Patch。`, 'success');
        } else if (work.manual) {
            setStatus('分析完成：NO_CHANGE。没有足够明确、长期的世界观变化。');
        }
        await refreshUi();
    }

    function messageIdsFromEvent(payload) {
        if (Number.isInteger(payload)) return [payload];
        if (Array.isArray(payload)) return uniqueNumbers(payload.flatMap(item => messageIdsFromEvent(item)));
        if (payload && typeof payload === 'object') {
            return uniqueNumbers([
                payload.message_id,
                payload.messageId,
                payload.id,
                payload.index,
            ]);
        }
        return [];
    }

    function sourceIntersects(record, messageIds) {
        return uniqueNumbers(record?.sourceMessageIds).some(id => messageIds.includes(id));
    }

    async function startInvalidation(messageIds, kind) {
        const ids = uniqueNumbers(messageIds);
        if (!ids.length || !isChatAvailable()) return;
        const state = getState();
        const candidates = [...state.facts, ...state.history].filter(record => sourceIntersects(record, ids));
        if (!candidates.length) return;

        for (const candidate of candidates) candidate.pendingValidation = true;
        await saveMetadata();
        await applyCanonPrompt();
        await refreshUi();
        setStatus('检测到 Canon 来源被编辑、删除或换 Swipe；正在保守复核。', 'warning');

        const session = captureSession();
        const key = `revalidate:${session.chatKey}:${ids.join(',')}`;
        const oldTimer = delayedInvalidations.get(key);
        if (oldTimer) window.clearTimeout(oldTimer);
        delayedInvalidations.set(key, window.setTimeout(() => {
            delayedInvalidations.delete(key);
            enqueue({ type: 'revalidate', key, session, messageIds: ids, kind });
        }, 400));
    }

    function revalidationMessages(state, messageIds, kind) {
        const visible = getMessageRecords(MAX_REVALIDATION_MESSAGES);
        const invalid = new Set(messageIds);
        const facts = state.facts.filter(record => sourceIntersects(record, messageIds)).map(record => ({
            id: record.id, text: record.text, active: record.active !== false,
        }));
        const history = state.history.filter(record => sourceIntersects(record, messageIds)).map(record => ({
            id: record.id, text: record.text, active: record.active !== false,
        }));
        return [
            {
                role: 'system',
                content: 'You verify whether Canon facts remain supported after chat messages were edited, deleted, or swiped. Be extremely conservative. Keep an item only if currently visible transcript explicitly and durably proves it. If uncertain, choose ROLLBACK for a fact or REMOVE for a history anchor. Return only JSON.',
            },
            {
                role: 'user',
                content: [
                    `Change type: ${kind}. Potentially invalid source IDs: ${messageIds.join(', ')}.`,
                    'A visible changed message can support an item only if its current text explicitly establishes the durable fact. A deleted message is absent. Later messages may independently support an item.',
                    'AFFECTED FACTS:', JSON.stringify(facts),
                    'AFFECTED HISTORY:', JSON.stringify(history),
                    'VISIBLE TRANSCRIPT:', formatTranscript(visible),
                    'Return exactly: {"actions":[{"kind":"fact"|"history","id":"affected ID","action":"KEEP"|"ROLLBACK"|"REMOVE","source_message_ids":[currently visible evidence IDs]}]}.',
                    `KEEP source_message_ids must be visible and must not use an absent invalid ID: ${[...invalid].join(', ')}.`,
                ].join('\n'),
            },
        ];
    }

    function findPriorAiOperation(state, record, messageIds, kind) {
        for (const version of [...state.versions].reverse()) {
            if (version.origin !== 'ai') continue;
            for (const operation of [...(version.operations || [])].reverse()) {
                if (operation.targetKind !== kind || operation.targetId !== record.id) continue;
                if (sourceIntersects(operation, messageIds)) return operation;
            }
        }
        return null;
    }

    function rollbackRecord(state, record, messageIds, kind, operations) {
        const before = deepClone(record);
        if (kind === 'history') {
            record.active = false;
            record.pendingValidation = false;
            record.sourceMessageIds = [];
            record.updatedAt = now();
            operations.push({ type: 'DELETE', targetKind: kind, targetId: record.id, before, after: deepClone(record), reason: 'A source message was invalidated and no durable proof remained.', sourceMessageIds: messageIds });
            return;
        }

        const priorOperation = findPriorAiOperation(state, record, messageIds, kind);
        if (priorOperation?.before) {
            const restored = deepClone(priorOperation.before);
            restored.pendingValidation = false;
            // A prior value that itself depends on the changed message is not safe
            // to resurrect. Omit it rather than injecting a stale world fact.
            if (sourceIntersects(restored, messageIds)) {
                restored.active = false;
                restored.sourceMessageIds = [];
            }
            const index = state.facts.findIndex(item => item.id === record.id);
            if (index >= 0) state.facts[index] = restored;
            operations.push({ type: 'ROLLBACK', targetKind: kind, targetId: record.id, before, after: deepClone(restored), reason: 'Restored the previous Canon fact because its later source became invalid.', sourceMessageIds: messageIds });
            return;
        }

        record.active = false;
        record.pendingValidation = false;
        record.sourceMessageIds = [];
        record.updatedAt = now();
        operations.push({ type: 'DELETE', targetKind: kind, targetId: record.id, before, after: deepClone(record), reason: 'A source message was invalidated and no durable proof remained.', sourceMessageIds: messageIds });
    }

    function localInvalidate(state, messageIds, operations) {
        for (let pass = 0; pass < 8; pass++) {
            const candidates = [
                ...state.facts.map(record => ({ record, kind: 'fact' })),
                ...state.history.map(record => ({ record, kind: 'history' })),
            ].filter(item => sourceIntersects(item.record, messageIds));
            if (!candidates.length) break;
            let progress = false;
            for (const { record, kind } of candidates) {
                const remaining = uniqueNumbers(record.sourceMessageIds).filter(id => !messageIds.includes(id));
                if (remaining.length) {
                    const before = deepClone(record);
                    record.sourceMessageIds = remaining;
                    record.pendingValidation = false;
                    record.updatedAt = now();
                    operations.push({ type: 'SOURCE_UPDATE', targetKind: kind, targetId: record.id, before, after: deepClone(record), reason: 'Removed an invalid source while retaining other recorded evidence.', sourceMessageIds: messageIds });
                } else {
                    rollbackRecord(state, record, messageIds, kind, operations);
                }
                progress = true;
            }
            if (!progress) break;
        }
    }

    function validateRevalidation(raw, state, messageIds) {
        const parsed = extractJsonObject(raw);
        const currentVisibleIds = new Set(getMessageRecords(MAX_REVALIDATION_MESSAGES).map(record => record.id));
        const invalidIds = new Set(messageIds.filter(id => !currentVisibleIds.has(id)));
        const actions = [];
        for (const proposal of Array.isArray(parsed?.actions) ? parsed.actions : []) {
            const kind = proposal?.kind === 'history' ? 'history' : proposal?.kind === 'fact' ? 'fact' : '';
            const id = String(proposal?.id || '');
            const action = String(proposal?.action || '').toUpperCase();
            const records = kind === 'fact' ? state.facts : state.history;
            if (!kind || !records.some(record => record.id === id)) continue;
            const sourceMessageIds = uniqueNumbers(proposal?.source_message_ids)
                .filter(sourceId => currentVisibleIds.has(sourceId) && !invalidIds.has(sourceId));
            if (action === 'KEEP' && sourceMessageIds.length) actions.push({ kind, id, action, sourceMessageIds });
            if ((action === 'ROLLBACK' && kind === 'fact') || (action === 'REMOVE' && kind === 'history')) actions.push({ kind, id, action, sourceMessageIds: [] });
        }
        return actions;
    }

    async function processRevalidation(work) {
        if (!await isSameSession(work.session)) return;
        const state = getState();
        const candidates = [
            ...state.facts.map(record => ({ record, kind: 'fact' })),
            ...state.history.map(record => ({ record, kind: 'history' })),
        ].filter(item => sourceIntersects(item.record, work.messageIds));
        if (!candidates.length) return;

        const before = snapshot(state);
        const operations = [];
        const settings = getGlobalSettings();
        if (apiIsReady(settings)) {
            try {
                const raw = await callIndependentApi(revalidationMessages(state, work.messageIds, work.kind), 800);
                if (!await isSameSession(work.session)) return;
                const actions = validateRevalidation(raw, state, work.messageIds);
                const byKey = new Map(actions.map(action => [`${action.kind}:${action.id}`, action]));
                for (const { record, kind } of candidates) {
                    const action = byKey.get(`${kind}:${record.id}`);
                    if (action?.action === 'KEEP') {
                        const recordBefore = deepClone(record);
                        record.sourceMessageIds = action.sourceMessageIds;
                        record.pendingValidation = false;
                        record.updatedAt = now();
                        operations.push({ type: 'SOURCE_REVALIDATED', targetKind: kind, targetId: record.id, before: recordBefore, after: deepClone(record), reason: 'Visible chat evidence still explicitly supports this item.', sourceMessageIds: action.sourceMessageIds });
                    } else {
                        rollbackRecord(state, record, work.messageIds, kind, operations);
                    }
                }
            } catch (error) {
                console.warn('[Canon Keeper] Revalidation API failed; using local conservative rollback.', error);
                localInvalidate(state, work.messageIds, operations);
            }
        } else {
            localInvalidate(state, work.messageIds, operations);
        }

        if (!operations.length) return;
        addVersion(state, {
            origin: 'source-revalidation',
            reason: `Revalidated Canon sources after ${work.kind}.`,
            sourceMessageIds: work.messageIds,
            operations,
            before,
            after: snapshot(state),
        });
        await saveMetadata();
        await applyCanonPrompt();
        await refreshUi();
        setStatus('来源复核完成；Canon 已保守更新。', 'success');
    }

    async function tokenCount(text) {
        if (!text) return 0;
        try {
            if (typeof context?.getTokenCountAsync === 'function') {
                return await context.getTokenCountAsync(text);
            }
        } catch (error) {
            console.warn('[Canon Keeper] Token counter unavailable:', error);
        }
        return Math.ceil([...text].length / 2);
    }

    function riskLabel(tokens) {
        const maxContext = Number(context?.maxContext || 0);
        if (maxContext > 0) {
            const ratio = tokens / maxContext;
            if (ratio >= 0.16) return ['高风险', 'is-error'];
            if (ratio >= 0.08) return ['注意', 'is-warning'];
            return ['安全', 'is-success'];
        }
        if (tokens >= 2400) return ['高风险', 'is-error'];
        if (tokens >= 1200) return ['注意', 'is-warning'];
        return ['安全', 'is-success'];
    }

    async function refreshUi() {
        const $ = globalThis.jQuery;
        if (!$ || !settingsMounted || !isChatAvailable()) return;
        const state = getState();
        $('#canon_keeper_canon').val(visibleRecords(state.facts).map(record => record.text).join('\n'));
        $('#canon_keeper_history').val(visibleRecords(state.history).map(record => record.text).join('\n'));
        $('#canon_keeper_prompt_preview').val(buildCanonPrompt(state));
        renderVersions(state);

        const settings = getGlobalSettings();
        $('#canon_keeper_api_enabled').prop('checked', Boolean(settings.api.enabled));
        $('#canon_keeper_automation_enabled').prop('checked', Boolean(settings.automation.enabled));
        $('#canon_keeper_api_endpoint').val(settings.api.endpoint || '');
        $('#canon_keeper_api_key').val(settings.api.apiKey || '');
        $('#canon_keeper_api_model').val(settings.api.model || '');
        $('#canon_keeper_api_timeout').val(settings.api.timeoutMs || 30000);

        const canonText = visibleRecords(state.facts).map(record => record.text).join('\n');
        const historyText = visibleRecords(state.history).map(record => record.text).join('\n');
        const prompt = buildCanonPrompt(state);
        const [canonTokens, historyTokens, promptTokens] = await Promise.all([tokenCount(canonText), tokenCount(historyText), tokenCount(prompt)]);
        $('#canon_keeper_canon_size').text(`${canonText.length} 字符 / ~${canonTokens} tokens`);
        $('#canon_keeper_history_size').text(`${historyText.length} 字符 / ~${historyTokens} tokens`);
        const [risk, riskClass] = riskLabel(promptTokens);
        $('#canon_keeper_context_risk').text(`${risk} · 实际注入约 ${promptTokens} tokens`).removeClass('is-error is-warning is-success').addClass(riskClass);

        if (!settings.api.enabled) setApiStatus('独立 API：未启用');
        else if (!apiIsReady(settings)) setApiStatus('独立 API：配置不完整', 'warning');
        else setApiStatus(settings.automation.enabled ? '独立 API：已启用，自动维护开启' : '独立 API：已启用，自动维护关闭', 'success');
    }

    function saveApiForm() {
        const $ = globalThis.jQuery;
        const settings = getGlobalSettings();
        settings.api.enabled = Boolean($('#canon_keeper_api_enabled').prop('checked'));
        settings.automation.enabled = Boolean($('#canon_keeper_automation_enabled').prop('checked'));
        settings.api.endpoint = cleanText($('#canon_keeper_api_endpoint').val(), 2000);
        settings.api.apiKey = String($('#canon_keeper_api_key').val() || '').trim();
        settings.api.model = cleanText($('#canon_keeper_api_model').val(), 200);
        settings.api.timeoutMs = Math.min(120000, Math.max(5000, Number($('#canon_keeper_api_timeout').val()) || 30000));
        saveGlobalSettings();
        void refreshUi();
        setApiStatus('独立 API 设置已保存到本地。', 'success');
        toast('success', 'Canon Keeper：独立 API 设置已保存');
    }

    async function testApi() {
        saveApiForm();
        if (!apiIsReady()) {
            setApiStatus('请先启用并填写 API 地址与模型名称。', 'warning');
            return;
        }
        setApiStatus('正在测试连接……');
        try {
            const reply = await callIndependentApi([
                { role: 'user', content: 'Reply with exactly: CANON_KEEPER_OK' },
            ], 20);
            setApiStatus(`连接成功：${cleanText(reply, 120)}`, 'success');
            toast('success', 'Canon Keeper：独立 API 连接成功');
        } catch (error) {
            setApiStatus(`连接失败：${cleanText(error.message, 220)}`, 'error');
        }
    }

    function toggleApiKey() {
        const $ = globalThis.jQuery;
        const input = $('#canon_keeper_api_key');
        const button = $('#canon_keeper_toggle_key');
        const show = input.attr('type') === 'password';
        input.attr('type', show ? 'text' : 'password');
        button.text(show ? '隐藏' : '显示');
    }

    async function handleChatChanged() {
        try {
            await refreshContext();
            await applyCanonPrompt();
            await refreshUi();
            setStatus('已切换到当前聊天的独立 Canon。');
        } catch (error) {
            console.error('[Canon Keeper] Chat switch failed:', error);
            setStatus(`加载聊天失败：${cleanText(error.message, 160)}`, 'error');
        }
    }

    function bindEvent(eventName, handler) {
        if (!eventName || typeof context?.eventSource?.on !== 'function') return;
        context.eventSource.on(eventName, handler);
    }

    function bindSillyTavernEvents() {
        const events = context?.eventTypes || context?.event_types || {};
        bindEvent(events.CHAT_CHANGED, () => { void handleChatChanged(); });
        bindEvent(events.MESSAGE_RECEIVED, payload => {
            const messageId = messageIdsFromEvent(payload)[0] ?? newestAssistantMessageId();
            if (messageId !== null && messageId !== undefined) {
                window.setTimeout(() => queueAnalysis(messageId, false), 0);
            }
        });
        for (const [eventName, kind] of [
            [events.MESSAGE_EDITED, 'edited'],
            [events.MESSAGE_DELETED, 'deleted'],
            [events.MESSAGE_SWIPED, 'swiped'],
            [events.MESSAGE_SWIPE_DELETED, 'swipe deleted'],
        ]) {
            bindEvent(eventName, payload => {
                const ids = messageIdsFromEvent(payload);
                void startInvalidation(ids, kind);
                if (kind === 'swiped') {
                    const current = newestAssistantMessageId();
                    if (current !== null) window.setTimeout(() => queueAnalysis(current, false), 500);
                }
            });
        }
    }

    async function mountSettings() {
        const $ = globalThis.jQuery;
        if (!$) throw new Error('SillyTavern 的 jQuery 尚未就绪。');
        if (!$('#canon_keeper_settings').length) {
            const html = await $.get(`/scripts/extensions/third-party/${MODULE_NAME}/settings.html`);
            $('#extensions_settings').append(html);
        }
        settingsMounted = true;

        $('#canon_keeper_save').off('.canonKeeper').on('click.canonKeeper', () => {
            void saveManualEditor().catch(error => {
                console.error('[Canon Keeper] Manual save failed:', error);
                setStatus(`保存失败：${cleanText(error.message, 160)}`, 'error');
            });
        });
        $('#canon_keeper_save_api').off('.canonKeeper').on('click.canonKeeper', saveApiForm);
        $('#canon_keeper_test_api').off('.canonKeeper').on('click.canonKeeper', () => { void testApi(); });
        $('#canon_keeper_toggle_key').off('.canonKeeper').on('click.canonKeeper', toggleApiKey);
        $('#canon_keeper_show_prompt').off('.canonKeeper').on('click.canonKeeper', () => {
            $('#canon_keeper_prompt_block').toggleClass('is-hidden');
            $('#canon_keeper_prompt_preview').val(buildCanonPrompt());
        });
        $('#canon_keeper_copy_prompt').off('.canonKeeper').on('click.canonKeeper', async () => {
            const text = String($('#canon_keeper_prompt_preview').val() || '');
            try {
                await navigator.clipboard.writeText(text);
                setStatus('实际注入 Prompt 已复制。', 'success');
            } catch {
                $('#canon_keeper_prompt_preview').trigger('focus').trigger('select');
                setStatus('已选中 Prompt；请使用浏览器复制。', 'warning');
            }
        });
        $('#canon_keeper_analyze_latest').off('.canonKeeper').on('click.canonKeeper', () => {
            const latest = newestAssistantMessageId();
            if (latest === null) {
                setStatus('当前聊天里还没有可分析的角色回复。', 'warning');
                return;
            }
            queueAnalysis(latest, true);
        });
        $('#canon_keeper_versions').off('click.canonKeeper').on('click.canonKeeper', '.canon-keeper-restore', event => {
            const version = Number($(event.currentTarget).data('version'));
            void restoreVersionBefore(version).catch(error => {
                console.error('[Canon Keeper] Restore failed:', error);
                setStatus(`恢复失败：${cleanText(error.message, 160)}`, 'error');
            });
        });
    }

    async function initialize() {
        try {
            await refreshContext();
            getGlobalSettings();
            await mountSettings();
            bindSillyTavernEvents();
            await applyCanonPrompt();
            await refreshUi();
            setStatus('Canon Keeper 已就绪：当前聊天拥有独立 Canon。', 'success');
            console.info('[Canon Keeper] Loaded.');
        } catch (error) {
            console.error('[Canon Keeper] Failed to load:', error);
            toast('error', `Canon Keeper：加载失败：${cleanText(error.message, 180)}`);
        }
    }

    globalThis.jQuery(() => { void initialize(); });
})();
