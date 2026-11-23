import { parsePreset, analyze, retarget, build, moveItem } from './merge.mjs';
import { attachSortable } from './sortable.mjs';

const mountId = 'preset-transfer-panel';
let controller;
let panel;
let revision = 0;
const downloadUrls = new Set();
let stopSorting;

function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
}

export function cleanup() {
    stopSorting?.();
    revision++;
    document.removeEventListener('DOMContentLoaded', activate);
    downloadUrls.forEach(url => URL.revokeObjectURL(url));
    downloadUrls.clear();
    controller?.abort();
    panel?.remove();
    panel = null;
}

export function activate() {
    if (document.getElementById(mountId)) return;
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host) return;
    controller = new AbortController();
    const listen = (element, event, fn) => element.addEventListener(event, fn, { signal: controller.signal });
    panel = node('details');
    panel.id = mountId;
    try { panel.dataset.theme = localStorage.getItem('preset-transfer-theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'); }
    catch { panel.dataset.theme = 'dark'; }
    panel.append(node('summary', '预设迁移助手'));
    const body = node('div', undefined, 'pt-body');
    panel.append(body);
    const mode = node('select');
    mode.setAttribute('aria-label', '缝合模式');
    for (const [value, title] of [['update', '同系列版本更新'], ['select', '从 A 勾选条目缝入 B']]) {
        const option = node('option', title); option.value = value; mode.append(option);
    }
    body.append(mode);
    const theme = node('button', '', 'menu_button pt-theme'); theme.type = 'button';
    const paintTheme = () => {
        theme.textContent = panel.dataset.theme === 'dark' ? '☀ 白天模式' : '☾ 夜间模式';
        theme.setAttribute('aria-label', '切换到' + (panel.dataset.theme === 'dark' ? '白天模式' : '夜间模式'));
    };
    paintTheme();
    listen(theme, 'click', () => {
        panel.dataset.theme = panel.dataset.theme === 'dark' ? 'light' : 'dark';
        try { localStorage.setItem('preset-transfer-theme', panel.dataset.theme); } catch { /* Storage can be unavailable. */ }
        paintTheme();
    });
    body.append(theme);
    body.append(node('p', '选择旧自用版和新原版，核对对应条目后导出。补充旧原版，可以识别你自己的修改。'));
    const fields = {};
    for (const [key, title] of [['old', '来源 A / 旧自用版 JSON'], ['latest', '目标 B / 新原版 JSON'], ['original', '旧原版 JSON（可选）']]) {
        const label = node('label', title);
        const input = node('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        fields[key] = input;
        label.append(input);
        body.append(label);
    }
    const switchesLabel = node('label', undefined, 'pt-inline');
    const switches = node('input');
    switches.type = 'checkbox';
    switches.checked = true;
    switchesLabel.append(switches, document.createTextNode('恢复旧版条目与正则开关'));
    body.append(switchesLabel);
    const start = node('button', '分析文件', 'menu_button');
    start.type = 'button';
    const status = node('p');
    status.setAttribute('role', 'status');
    const filter = node('input');
    filter.type = 'search';
    filter.placeholder = '筛选条目或正则名称';
    filter.setAttribute('aria-label', '筛选条目或正则名称');
    const pendingLabel = node('label', undefined, 'pt-inline');
    const pending = node('input');
    pending.type = 'checkbox';
    pendingLabel.append(pending, document.createTextNode('只看待选择项'));
    const list = node('div', undefined, 'pt-list');
    const download = node('button', '导出合并预设', 'menu_button');
    download.type = 'button';
    download.disabled = true;
    const filename = node('input');
    filename.type = 'text';
    filename.value = '我的合并预设';
    filename.setAttribute('aria-label', '导出文件名');
    body.append(start, status, filter, pendingLabel, list, node('label', '导出文件名'), filename, download);
    const arrange = node('button', '预览并调整最终顺序', 'menu_button');
    arrange.type = 'button'; arrange.disabled = true;
    const ordering = node('div');
    body.insertBefore(arrange, filename.previousSibling);
    body.insertBefore(ordering, filename.previousSibling);
    host.append(panel);
    let plan;
    let draft;
    let rendered = [];

    function invalidate() {
        stopSorting?.();
        revision++;
        plan = null;
        draft = null;
        ordering.replaceChildren();
        arrange.disabled = true;
        rendered = [];
        list.replaceChildren();
        download.disabled = true;
        status.textContent = '文件已更换，请重新分析。';
    }
    Object.values(fields).forEach(field => listen(field, 'change', invalidate));
    listen(mode, 'change', invalidate);

    function visibleRows() {
        const query = filter.value.trim().toLowerCase();
        for (const { row, card } of rendered) card.hidden = !String(row.title).toLowerCase().includes(query) || pending.checked && row.action !== 'review';
    }

    function update() {
        if (!plan) return;
        stopSorting?.();
        draft = null;
        ordering.replaceChildren();
        const chosen = plan.rows.filter(r => r.selected);
        const remaining = chosen.filter(r => r.action === 'review').length;
        download.disabled = true;
        arrange.disabled = true;
        status.textContent = `${plan.rows.length} 项已比较，勾选 ${chosen.length} 项，${remaining} 项待选择。`;
        if (!remaining) {
            try {
                const result = build(plan, switches.checked);
                status.textContent += ` 可导出 ${result.prompts.length} 个条目和 ${result.extensions.regex_scripts.length} 条正则。`;
                download.disabled = false;
                arrange.disabled = false;
            } catch (error) { status.textContent += ' ' + error.message; }
        }
        visibleRows();
    }

    function render() {
        list.replaceChildren();
        rendered = [];
        const kinds = { prompts: '条目', regex: '正则', extensions: '扩展数据', settings: '生成设置' };
        for (const row of plan.rows) {
            const card = node('details', undefined, 'pt-row');
            const heading = node('summary');
            card.append(heading);
            const caption = node('span');
            const paintHeading = () => { caption.textContent = `${kinds[row.kind]} · ${row.title} · ${!row.selected ? '未勾选' : row.action === 'review' ? '待选择' : '已选择'}`; };
            const include = node('input'); include.type = 'checkbox'; include.checked = row.selected;
            include.setAttribute('aria-label', '缝入 ' + row.title);
            heading.append(include, document.createTextNode(' '), caption);
            listen(include, 'click', event => event.stopPropagation());
            listen(include, 'change', () => { row.selected = include.checked; paintHeading(); update(); });
            const actions = node('select');
            actions.setAttribute('aria-label', row.title + ' 处理方式');
            let targets;
            const comparison = node('div', undefined, 'pt-comparison');
            function showSource() {
                comparison.replaceChildren();
                let newest = row.latest;
                if (targets) newest = targets.find(x => (x.identifier ?? x.id) === row.targetId);
                for (const [title, value] of [['旧自用版', row.old], ['新版对应项', newest], ['旧原版依据', row.prior]]) {
                    if (value === undefined || value === null) continue;
                    const section = node('div');
                    section.append(node('strong', title), node('pre', JSON.stringify(value, null, 2)));
                    comparison.append(section);
                }
            }
            function populateActions() {
                const choices = { review: '待选择', new: '使用新版内容', old: '使用旧自用内容' };
                if (targets) {
                    if (row.targetId && !row.conflicts.length) choices.merge = '接入已识别的自用修改';
                    choices.add = '作为独立条目加入';
                    choices.skip = '略过这项旧内容';
                    if (!row.targetId) { delete choices.new; delete choices.old; }
                }
                actions.replaceChildren(...Object.entries(choices).map(([value, title]) => {
                    const option = node('option', title);
                    option.value = value;
                    return option;
                }));
                actions.value = row.action;
                paintHeading();
            }
            if (['prompts', 'regex'].includes(row.kind)) {
                targets = row.kind === 'prompts' ? plan.latest.prompts : plan.latest.extensions?.regex_scripts || [];
                const select = node('select');
                select.setAttribute('aria-label', row.title + ' 新版对应项');
                const empty = node('option', '请选择新版对应项，或作为独立条目加入');
                empty.value = '';
                select.append(empty);
                targets.forEach((target, index) => {
                    const identifier = target.identifier ?? target.id;
                    const suggested = row.candidates.includes(identifier) ? '可能对应 · ' : '';
                    const option = node('option', `${suggested}${target.name ?? target.scriptName}（第 ${index + 1} 项）`);
                    option.value = identifier;
                    select.append(option);
                });
                select.value = row.targetId;
                listen(select, 'change', () => {
                    retarget(plan, row, select.value);
                    populateActions();
                    showSource();
                    update();
                });
                card.append(select);
            }
            populateActions();
            showSource();
            listen(actions, 'change', () => { row.action = actions.value; paintHeading(); update(); });
            card.append(actions, comparison);
            list.append(card);
            rendered.push({ row, card });
        }
        update();
    }

    listen(start, 'click', async () => {
        invalidate();
        const token = revision;
        try {
            if (!fields.old.files[0] || !fields.latest.files[0]) throw Error('请先选择旧自用版和新原版。');
            status.textContent = '正在读取文件…';
            const values = await Promise.all(['old', 'latest', 'original'].map(async key => {
                const file = fields[key].files[0];
                if (!file) return null;
                if (file.size > 30 * 1024 * 1024) throw Error('文件超过 30 MB，请先检查是否选择了正确的预设。');
                return parsePreset(await file.text());
            }));
            if (token !== revision) return;
            plan = analyze(...values, mode.value === 'select');
            filename.value = fields.latest.files[0].name.replace(/\.json$/i, '') + '-自用迁移';
            render();
        } catch (error) { if (token === revision) status.textContent = error.message; }
    });
    listen(filter, 'input', visibleRows);
    listen(pending, 'change', visibleRows);
    listen(switches, 'change', update);
    listen(arrange, 'click', () => {
        try {
            stopSorting?.();
            draft = build(plan, switches.checked);
            ordering.replaceChildren();
            const select = node('select'); select.setAttribute('aria-label', '调整哪个排序');
            for (const [index, profile] of draft.prompt_order.entries()) {
                const option = node('option', '条目配置 ' + profile.character_id); option.value = String(index); select.append(option);
            }
            const regexOption = node('option', '正则执行顺序'); regexOption.value = 'regex'; select.append(regexOption);
            const primary = draft.prompt_order.findIndex(x => x.character_id === 100001);
            select.value = String(Math.max(0, primary));
            const rows = node('div', undefined, 'pt-order-list');
            const moveStatus = node('p'); moveStatus.setAttribute('role', 'status');
            ordering.append(node('p', '按住左侧手柄拖动排序，靠近列表边缘可自动滚动。修改勾选或处理方式后，需要重新调整顺序。'), select, rows, moveStatus);
            function draw(focusId, direction) {
                const scroll = rows.scrollTop;
                rows.replaceChildren();
                const isRegex = select.value === 'regex';
                const profile = isRegex ? null : draft.prompt_order[Number(select.value)];
                const items = isRegex ? draft.extensions.regex_scripts : profile.order;
                for (const [index, state] of items.entries()) {
                    const id = state.identifier ?? state.id;
                    const item = isRegex ? state : draft.prompts.find(x => x.identifier === id);
                    const line = node('div', undefined, 'pt-order-row');
                    line.dataset.index = String(index);
                    const handle = node('button', '⠿', 'pt-drag-handle'); handle.type = 'button';
                    handle.setAttribute('aria-label', '拖动 ' + (item.name ?? item.scriptName));
                    handle.title = '按住拖动，Esc 取消';
                    line.append(handle);
                    line.append(node('span', `${index + 1}. ${item.name ?? item.scriptName} · ${(isRegex ? !state.disabled : state.enabled) ? '开' : '关'}`));
                    for (const step of [-1, 1]) {
                        const button = node('button', step < 0 ? '上移' : '下移', 'menu_button'); button.type = 'button';
                        button.disabled = step < 0 ? index === 0 : index === items.length - 1;
                        button.setAttribute('aria-label', (step < 0 ? '上移 ' : '下移 ') + (item.name ?? item.scriptName));
                        button.addEventListener('click', () => { moveItem(draft, isRegex ? 'regex' : 'prompts', profile?.character_id, id, step); draw(id, step); }, { once: true });
                        line.append(button);
                        if (id === focusId && step === direction) queueMicrotask(() => button.focus({ preventScroll: true }));
                    }
                    rows.append(line);
                }
                rows.scrollTop = scroll;
            }
            select.addEventListener('change', () => draw());
            stopSorting = attachSortable(rows, (from, to) => {
                const items = select.value === 'regex' ? draft.extensions.regex_scripts : draft.prompt_order[Number(select.value)].order;
                const [item] = items.splice(from, 1); items.splice(to, 0, item);
                draw();
                rows.children[to]?.querySelector('.pt-drag-handle')?.focus({ preventScroll: true });
                moveStatus.textContent = '已从第 ' + (from + 1) + ' 项移到第 ' + (to + 1) + ' 项，导出时将使用此顺序。';
            });
            draw();
        } catch (error) { status.textContent = error.message; }
    });
    listen(download, 'click', () => {
        try {
            const output = draft || build(plan, switches.checked);
            const url = URL.createObjectURL(new Blob([JSON.stringify(output, null, 2) + '\n'], { type: 'application/json' }));
            downloadUrls.add(url);
            const anchor = node('a');
            anchor.href = url;
            anchor.download = (filename.value.trim() || '合并预设').replace(/[\\/:*?"<>|]/g, '_') + '.json';
            anchor.click();
            setTimeout(() => { URL.revokeObjectURL(url); downloadUrls.delete(url); }, 1000);
        } catch (error) { status.textContent = error.message; }
    });
}

// Supported older loaders execute the entry module without lifecycle hooks.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', activate, { once: true });
else activate();
