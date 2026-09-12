import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createEmptyState,
    formatEffectiveMemory,
    getActiveAssistantFingerprints,
    materializeState,
    messageFingerprint,
    parseModelJson,
    resolveContextLimit,
    validateTransaction,
} from '../memory.js';
import { buildInjectionPrompt, FINAL_COMPLIANCE_REMINDER } from '../prompts.js';

function assistant(mes, sendDate = '1') {
    return { mes, send_date: sendDate, name: '角色', is_user: false, is_system: false };
}

test('精确替换会保留其余原文', () => {
    const state = createEmptyState();
    state.baselineText = '角色A是女的。\n角色B住在北境。';
    const message = assistant('手术完成。');
    const fingerprint = messageFingerprint(message);
    const active = getActiveAssistantFingerprints([message]);
    const result = validateTransaction({
        state,
        activeFingerprints: active,
        sourceFingerprint: fingerprint,
        sourceIndex: 0,
        rawOperations: [{
            type: 'replace_exact',
            old_text: '角色A是女的',
            new_text: '角色A是男的',
            reason: '长期改变',
        }],
    });
    assert.ok(result.transaction);
    state.transactions.push(result.transaction);
    assert.equal(materializeState(state, active).userText, '角色A是男的。\n角色B住在北境。');
});

test('来源消息删除后自动回滚', () => {
    const state = createEmptyState();
    state.baselineText = '角色A是女的。';
    const message = assistant('角色A已经完成改变。');
    const fingerprint = messageFingerprint(message);
    const active = new Set([fingerprint]);
    const { transaction } = validateTransaction({
        state,
        activeFingerprints: active,
        sourceFingerprint: fingerprint,
        sourceIndex: 2,
        rawOperations: [{ type: 'replace_exact', old_text: '女', new_text: '男', reason: '明确改变' }],
    });
    state.transactions.push(transaction);
    assert.equal(materializeState(state, active).userText, '角色A是男的。');
    assert.equal(materializeState(state, new Set()).userText, '角色A是女的。');
});

test('高评分长期事实可以进入独立补充区', () => {
    const state = createEmptyState();
    state.baselineText = '这是一个魔法世界。'.repeat(80);
    const message = assistant('北境城被永久摧毁。', '2');
    const fingerprint = messageFingerprint(message);
    const active = new Set([fingerprint]);
    const { transaction } = validateTransaction({
        state,
        activeFingerprints: active,
        sourceFingerprint: fingerprint,
        sourceIndex: 1,
        rawOperations: [{
            type: 'add_long_term_fact',
            text: '北境城已被永久摧毁。',
            reason: '不可逆事件',
            explicitness: 0.99,
            durability: 0.99,
            future_importance: 0.95,
        }],
    });
    assert.ok(transaction);
    state.transactions.push(transaction);
    assert.match(formatEffectiveMemory(materializeState(state, active)), /剧情确认的长期补充/);
});

test('低评分或重复新增会被拒绝', () => {
    const state = createEmptyState();
    state.baselineText = '北境城已被永久摧毁。'.repeat(30);
    const fingerprint = 'abc';
    const result = validateTransaction({
        state,
        activeFingerprints: new Set([fingerprint]),
        sourceFingerprint: fingerprint,
        sourceIndex: 1,
        rawOperations: [{
            type: 'add_long_term_fact',
            text: '北境城已被永久摧毁。',
            explicitness: 0.8,
            durability: 1,
            future_importance: 1,
        }],
    });
    assert.equal(result.transaction, null);
});

test('可解析代码围栏中的 JSON', () => {
    assert.deepEqual(parseModelJson('```json\n{"result":"no_change","operations":[]}\n```'), {
        result: 'no_change',
        operations: [],
    });
});

test('可安全识别简短的无变化结果和正文外 JSON', () => {
    assert.deepEqual(parseModelJson('无需修改。'), { result: 'no_change', operations: [] });
    assert.deepEqual(parseModelJson('检查完成：\n{"result":"no_change","operations":[]}\n谢谢'), {
        result: 'no_change',
        operations: [],
    });
});

test('同一轮存在无效操作时整轮拒绝', () => {
    const state = createEmptyState();
    state.baselineText = '角色A是女的。';
    const fingerprint = 'whole-transaction';
    const result = validateTransaction({
        state,
        activeFingerprints: new Set([fingerprint]),
        sourceFingerprint: fingerprint,
        sourceIndex: 1,
        rawOperations: [
            { type: 'replace_exact', old_text: '女', new_text: '男', reason: '有效操作' },
            { type: 'rewrite_everything', text: '不允许的操作' },
        ],
    });
    assert.equal(result.transaction, null);
});

test('正文注入使用通用约束一致性规则', () => {
    const prompt = buildInjectionPrompt('这里是一条任意类型的长期设定。');
    assert.match(prompt, /一组同时成立的约束/);
    assert.match(prompt, /显性或隐性的设定冲突/);
    assert.match(prompt, /这里是一条任意类型的长期设定/);
    assert.match(FINAL_COMPLIANCE_REMINDER, /全部已知约束相容/);
    assert.doesNotMatch(FINAL_COMPLIANCE_REMINDER, /丈夫|孩子|配偶|独居/);
});

test('Chat Completion 百分比使用独立的上下文上限', () => {
    assert.equal(resolveContextLimit({
        mainApi: 'openai',
        maxContext: 7808,
        chatCompletionSettings: { openai_max_context: 200000 },
    }), 200000);

    assert.equal(resolveContextLimit({
        mainApi: 'textgenerationwebui',
        maxContext: 32768,
        chatCompletionSettings: { openai_max_context: 200000 },
    }), 32768);
});
