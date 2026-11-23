const copy = value => value === undefined ? undefined : structuredClone(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const label = item => item.name ?? item.scriptName ?? item.identifier ?? item.id;
const id = item => item.identifier ?? item.id;
const normalized = text => String(text || '').normalize('NFKC').replace(/(?:v?\d+(?:\.\d+)+|[（(](?:新版|原版)[）)])$/gi, '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();

export function parsePreset(text) {
    const data = JSON.parse(text.replace(/^\uFEFF/, ''), (key, value) => {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) throw Error('文件包含不支持的对象键。');
        return value;
    });
    validate(data);
    return data;
}

export function validate(preset) {
    if (!Array.isArray(preset?.prompts) || !Array.isArray(preset.prompt_order)) throw Error('请选择聊天补全预设 JSON，需要 prompts 和 prompt_order。');
    for (const [items, key] of [[preset.prompts, 'identifier'], [preset.extensions?.regex_scripts || [], 'id']]) {
        if (!Array.isArray(items)) throw Error('正则列表格式不正确。');
        const seen = new Set();
        for (const item of items) {
            if (!item || typeof item[key] !== 'string' || !item[key] || seen.has(item[key])) throw Error('条目或正则标识缺失、重复。');
            seen.add(item[key]);
        }
    }
    const ids = new Set(preset.prompts.map(id));
    const profiles = new Set();
    for (const profile of preset.prompt_order) {
        if (!Array.isArray(profile.order) || profiles.has(profile.character_id)) throw Error('预设排序配置重复或格式错误。');
        profiles.add(profile.character_id);
        const seen = new Set();
        for (const entry of profile.order) {
            if (!ids.has(entry.identifier) || seen.has(entry.identifier)) throw Error('排序存在重复或找不到的条目。');
            seen.add(entry.identifier);
        }
    }
}

// Only unique, exact identities/names/text become automatic matches.
function match(item, items) {
    const sameId = items.find(x => id(x) === id(item));
    if (sameId) return sameId;
    const names = items.filter(x => label(x) === label(item));
    if (names.length === 1) return names[0];
    const exact = names.filter(x => (x.content ?? x.findRegex) === (item.content ?? item.findRegex));
    return exact.length === 1 ? exact[0] : null;
}

function mergeFields(old, latest, original) {
    const result = copy(latest);
    const conflicts = [];
    for (const key of new Set([...Object.keys(old), ...Object.keys(original || {})])) {
        if (['identifier', 'id', 'enabled', 'disabled'].includes(key)) continue;
        if (!original) {
            if (!equal(old[key], latest[key])) conflicts.push(key);
            continue;
        }
        if (equal(old[key], original[key])) continue;
        if (!equal(latest[key], original[key]) && !equal(latest[key], old[key])) conflicts.push(key);
        else if (Object.hasOwn(old, key)) result[key] = copy(old[key]);
        else delete result[key];
    }
    return { result, conflicts };
}

export function analyze(old, latest, original = null, selective = false) {
    [old, latest, original].filter(Boolean).forEach(validate);
    const rows = [];
    for (const kind of ['prompts', 'regex']) {
        const items = p => kind === 'prompts' ? p.prompts : p.extensions?.regex_scripts || [];
        const targets = items(latest);
        for (const item of items(old)) {
            const target = match(item, targets);
            const prior = original ? match(item, items(original)) : null;
            const candidates = targets.filter(x => normalized(label(x)) === normalized(label(item)));
            const merged = target ? mergeFields(item, target, prior) : null;
            let action = 'review';
            if (target) action = merged.conflicts.length ? 'review' : 'merge';
            else if (!candidates.length && (!original || !prior)) action = 'add';
            rows.push({ kind, old: item, prior, targetId: target ? id(target) : '', candidates: candidates.map(id), action, conflicts: merged?.conflicts || [], title: label(item) });
        }
    }
    // Unknown extension payloads (including helper scripts) stay opaque and are never executed.
    for (const scope of ['settings', 'extensions']) {
        const excluded = scope === 'settings' ? ['prompts', 'prompt_order', 'extensions'] : ['regex_scripts'];
        const from = scope === 'settings' ? old : old.extensions || {};
        const to = scope === 'settings' ? latest : latest.extensions || {};
        const prior = scope === 'settings' ? original : original?.extensions;
        for (const key of Object.keys(from).filter(k => !excluded.includes(k))) {
            if (equal(from[key], to[key])) continue;
            const userChanged = prior && !equal(from[key], prior[key]);
            const safe = userChanged && equal(to[key], prior[key]);
            const action = prior && !userChanged ? 'new' : safe || !Object.hasOwn(to, key) ? 'old' : 'review';
            rows.push({ kind: scope, title: key, key, old: from[key], latest: to[key], action });
        }
    }
    rows.forEach(row => { row.selected = !selective; });
    return { old, latest, original, rows, selective };
}

export function retarget(plan, row, targetId) {
    row.targetId = targetId;
    const list = row.kind === 'prompts' ? plan.latest.prompts : plan.latest.extensions?.regex_scripts || [];
    const target = list.find(x => id(x) === targetId);
    row.conflicts = target ? mergeFields(row.old, target, row.prior).conflicts : [];
    row.action = target ? row.conflicts.length ? 'review' : 'merge' : 'review';
}

export function build(plan, restoreSwitches = true) {
    const activeRows = plan.rows.filter(r => r.selected !== false);
    if (activeRows.some(r => r.action === 'review')) throw Error('请先处理所有已勾选的“待选择”项目。');
    const output = copy(plan.latest);
    output.extensions ||= {};
    output.extensions.regex_scripts ||= [];
    const mappings = new Map();
    const regexMappings = new Map();
    const addedRegex = new Set();
    const used = new Set();
    for (const row of activeRows.filter(r => ['prompts', 'regex'].includes(r.kind))) {
        if (row.action === 'skip') continue;
        const list = row.kind === 'prompts' ? output.prompts : output.extensions.regex_scripts;
        let target = list.find(x => id(x) === row.targetId);
        if (row.action === 'add') {
            const added = copy(row.old);
            const key = row.kind === 'prompts' ? 'identifier' : 'id';
            let candidate = added[key];
            while (list.some(x => id(x) === candidate)) candidate += '-copy';
            added[key] = candidate;
            list.push(added);
            target = added;
            if (row.kind === 'regex') addedRegex.add(id(added));
        } else {
            if (!target) throw Error('找不到对应项：' + row.title);
            const useKey = row.kind + ':' + id(target);
            if (used.has(useKey)) throw Error('多个旧条目指向同一新版条目，请重新选择：' + row.title);
            used.add(useKey);
            if (row.action === 'old') {
                const key = row.kind === 'prompts' ? 'identifier' : 'id';
                const replacement = { ...copy(row.old), [key]: target[key] };
                if (!restoreSwitches) {
                    for (const flag of ['enabled', 'disabled']) {
                        if (Object.hasOwn(target, flag)) replacement[flag] = target[flag];
                        else delete replacement[flag];
                    }
                }
                list[list.indexOf(target)] = replacement;
                target = replacement;
            } else if (row.action === 'merge') {
                const merged = mergeFields(row.old, target, row.prior);
                if (merged.conflicts.length) throw Error('存在双边修改：' + row.title);
                list[list.indexOf(target)] = merged.result;
                target = merged.result;
            } else if (row.action !== 'new') throw Error('未知处理方式。');
        }
        if (row.kind === 'prompts') mappings.set(id(row.old), id(target));
        else {
            regexMappings.set(id(row.old), id(target));
            if (restoreSwitches) target.disabled = row.old.disabled;
        }
    }
    const sourceRegex = plan.old.extensions?.regex_scripts || [];
    const resolveRegex = source => regexMappings.get(id(source)) || id(match(source, plan.latest.extensions?.regex_scripts || []) || {});
    let previousRegex = null;
    for (const [index, source] of sourceRegex.entries()) {
        const mapped = regexMappings.get(id(source));
        if (!mapped) { previousRegex = resolveRegex(source) || previousRegex; continue; }
        const list = output.extensions.regex_scripts;
        if (addedRegex.has(mapped)) {
            const [item] = list.splice(list.findIndex(x => id(x) === mapped), 1);
            const next = sourceRegex.slice(index + 1).map(resolveRegex).find(value => list.some(x => id(x) === value));
            const at = previousRegex ? list.findIndex(x => id(x) === previousRegex) + 1 : next ? list.findIndex(x => id(x) === next) : list.length;
            list.splice(at, 0, item);
        }
        previousRegex = mapped;
    }
    for (const source of plan.old.prompt_order) {
        if (!source.order.some(state => mappings.has(state.identifier))) continue;
        let target = output.prompt_order.find(x => x.character_id === source.character_id);
        if (!target) {
            target = { ...copy(source), order: [] };
            output.prompt_order.push(target);
        }
        const resolveAnchor = state => {
            const mapped = mappings.get(state.identifier);
            if (mapped) return mapped;
            const old = plan.old.prompts.find(x => id(x) === state.identifier);
            return old ? id(match(old, plan.latest.prompts) || {}) : undefined;
        };
        let previous = null;
        for (const [index, state] of source.order.entries()) {
            const mapped = mappings.get(state.identifier);
            if (!mapped) {
                const anchor = resolveAnchor(state);
                if (target.order.some(x => x.identifier === anchor)) previous = anchor;
                continue;
            }
            let existing = target.order.find(x => x.identifier === mapped);
            if (!existing) {
                existing = { ...copy(state), identifier: mapped };
                const next = source.order.slice(index + 1).map(resolveAnchor).find(value => target.order.some(x => x.identifier === value));
                const at = previous ? target.order.findIndex(x => x.identifier === previous) + 1 : next ? target.order.findIndex(x => x.identifier === next) : target.order.length;
                target.order.splice(at, 0, existing);
            } else if (restoreSwitches) existing.enabled = state.enabled;
            previous = mapped;
        }
    }
    // Restore references in grouping data after old IDs have been translated to new IDs.
    function remap(value) {
        if (typeof value === 'string') return mappings.get(value) || value;
        if (Array.isArray(value)) return value.map(remap);
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, remap(v)]));
        return value;
    }
    for (const row of activeRows.filter(r => ['settings', 'extensions'].includes(r.kind))) {
        if (row.action !== 'old') continue;
        const dest = row.kind === 'settings' ? output : output.extensions;
        dest[row.key] = row.key === 'entryGrouping' ? remap(row.old) : copy(row.old);
    }
    validate(output);
    return output;
}

export function moveItem(preset, kind, profileId, identifier, direction) {
    if (![1, -1].includes(direction)) throw Error('移动方向无效。');
    const list = kind === 'regex' ? preset.extensions.regex_scripts : preset.prompt_order.find(x => x.character_id === profileId)?.order;
    if (!list) throw Error('排序配置不存在。');
    const index = list.findIndex(x => id(x) === identifier);
    if (index < 0) throw Error('移动条目不存在。');
    const next = index + direction;
    if (next < 0 || next >= list.length) return;
    [list[index], list[next]] = [list[next], list[index]];
}
