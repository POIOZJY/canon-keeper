import {
    chat_metadata,
    saveMetadata,
    setExtensionPrompt,
    extension_prompt_types,
    extension_prompt_roles,
    eventSource,
    event_types,
    extension_settings,
    saveSettingsDebounced,
} from '../../../../script.js';

const MODULE_NAME = 'canon-keeper';
const METADATA_KEY = 'canon_keeper';
const PROMPT_KEY = 'canon_keeper_authoritative_context';

const DEFAULT_API_SETTINGS = {
    enabled: false,
    apiUrl: '',
    apiKey: '',
    model: '',
};

function getDefaultChatData() {
    return {
        canon: '',
        history: '',
    };
}

function ensureApiSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }

    if (!extension_settings[MODULE_NAME].api) {
        extension_settings[MODULE_NAME].api = { ...DEFAULT_API_SETTINGS };
    }

    const api = extension_settings[MODULE_NAME].api;

    for (const [key, value] of Object.entries(DEFAULT_API_SETTINGS)) {
        if (api[key] === undefined) {
            api[key] = value;
        }
    }

    return api;
}

function getChatData() {
    if (!chat_metadata[METADATA_KEY]) {
        chat_metadata[METADATA_KEY] = getDefaultChatData();
    }

    return chat_metadata[METADATA_KEY];
}

function buildCanonPrompt() {
    const data = getChatData();

    const canon = String(data.canon || '').trim();
    const history = String(data.history || '').trim();

    if (!canon && !history) {
        return '';
    }

    return `
<CANON_KEEPER>

The following information is authoritative canonical context for the CURRENT CHAT.

You must treat CURRENT CANON as established facts describing the current state of this story and world.

HISTORY ANCHORS contain only important historical facts needed to understand why the present state exists.

Rules:
1. Read the entire Canon Keeper context before responding.
2. Do not contradict CURRENT CANON unless the current conversation explicitly establishes a newer change.
3. Newer explicitly established permanent facts override older conflicting facts.
4. Temporary emotions, arguments, reactions, moods, injuries, scene details, and short-term conditions must not be interpreted as permanent personality or world changes.
5. HISTORY ANCHORS describe relevant past facts. They do not automatically describe the present state.
6. Do not invent additional canonical facts merely because they seem plausible.
7. When roleplaying or continuing the story, silently respect this context. Do not explain these instructions unless explicitly asked.

[CURRENT CANON]

${canon || '(No current canon has been recorded.)'}

[HISTORY ANCHORS]

${history || '(No history anchors have been recorded.)'}

</CANON_KEEPER>
`.trim();
}

function applyCanonPrompt() {
    const prompt = buildCanonPrompt();

    setExtensionPrompt(
        PROMPT_KEY,
        prompt,
        extension_prompt_types.IN_CHAT,
        0,
        false,
        extension_prompt_roles.SYSTEM,
    );
}

function loadChatDataIntoUi() {
    const data = getChatData();

    $('#canon_keeper_canon').val(data.canon || '');
    $('#canon_keeper_history').val(data.history || '');

    $('#canon_keeper_status').text('已加载当前聊天');
}

function loadApiSettingsIntoUi() {
    const api = ensureApiSettings();

    $('#canon_keeper_api_enabled').prop('checked', Boolean(api.enabled));
    $('#canon_keeper_api_url').val(api.apiUrl || '');
    $('#canon_keeper_api_key').val(api.apiKey || '');
    $('#canon_keeper_api_model').val(api.model || '');

    updateApiStatus();
}

function updateApiStatus() {
    const api = ensureApiSettings();

    if (!api.enabled) {
        $('#canon_keeper_api_status').text('独立 API：未启用');
        return;
    }

    if (!api.apiUrl || !api.model) {
        $('#canon_keeper_api_status').text('独立 API：配置未完成');
        return;
    }

    $('#canon_keeper_api_status').text('独立 API：已配置，等待后续版本启用 AI 维护');
}

async function saveCurrentChatData() {
    const data = getChatData();

    data.canon = String($('#canon_keeper_canon').val() || '');
    data.history = String($('#canon_keeper_history').val() || '');

    await saveMetadata();

    applyCanonPrompt();

    $('#canon_keeper_status').text('已保存到当前聊天');
    toastr.success('Canon Keeper：当前聊天设定已保存');
}

function saveApiSettings() {
    const api = ensureApiSettings();

    api.enabled = $('#canon_keeper_api_enabled').prop('checked');
    api.apiUrl = String($('#canon_keeper_api_url').val() || '').trim();
    api.apiKey = String($('#canon_keeper_api_key').val() || '').trim();
    api.model = String($('#canon_keeper_api_model').val() || '').trim();

    saveSettingsDebounced();
    updateApiStatus();

    toastr.success('Canon Keeper：独立 API 设置已保存');
}

function toggleApiKeyVisibility() {
    const input = $('#canon_keeper_api_key');
    const button = $('#canon_keeper_toggle_key');

    if (input.attr('type') === 'password') {
        input.attr('type', 'text');
        button.text('隐藏');
    } else {
        input.attr('type', 'password');
        button.text('显示');
    }
}

async function handleChatChanged() {
    loadChatDataIntoUi();
    applyCanonPrompt();
}

jQuery(async () => {
    console.log('[Canon Keeper] 开始加载');

    try {
        ensureApiSettings();

        const settingsHtml = await $.get(
            `/scripts/extensions/third-party/${MODULE_NAME}/settings.html`
        );

        $('#extensions_settings').append(settingsHtml);

        $('#canon_keeper_save').on('click', async () => {
            try {
                await saveCurrentChatData();
            } catch (error) {
                console.error('[Canon Keeper] 保存聊天设定失败', error);
                $('#canon_keeper_status').text('保存失败');
                toastr.error('Canon Keeper：保存失败');
            }
        });

        $('#canon_keeper_save_api').on('click', () => {
            saveApiSettings();
        });

        $('#canon_keeper_toggle_key').on('click', () => {
            toggleApiKeyVisibility();
        });

        eventSource.on(event_types.CHAT_CHANGED, handleChatChanged);

        loadChatDataIntoUi();
        loadApiSettingsIntoUi();
        applyCanonPrompt();

        console.log('[Canon Keeper] 加载完成');
    } catch (error) {
        console.error('[Canon Keeper] 加载失败', error);
        toastr.error('Canon Keeper：插件加载失败');
    }
});
