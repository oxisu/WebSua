/**
 * 标签面板：媒体库左侧的自定义分类区。
 * 列出标签（带媒体数）、点击筛选、新建 / 删除标签。
 */
import { api, el } from './utils.js';

export class TagPanel {
    constructor(root, { onSelect } = {}) {
        this.root = root;
        this.onSelect = onSelect || (() => {});
        this.tags = [];
        this.selected = null;   // 当前选中 tag id
        this._setup();
    }

    _setup() {
        this.root.classList.add('tag-panel');
        this.root.innerHTML = '';

        const head = el('div', { class: 'tp-head' },
            el('span', { class: 'tp-title' }, '标签'),
            el('button', {
                class: 'tp-add',
                title: '新建标签',
                onclick: () => this._create(),
            }, '+'));
        this.listWrap = el('div', { class: 'tp-list' });
        this.root.append(head, this.listWrap);
    }

    async load() {
        try {
            const r = await api('/api/tags');
            this.tags = r.tags || [];
            this._render();
        } catch (e) {
            this.listWrap.innerHTML = '';
            this.listWrap.append(el('div', { class: 'ft-empty' }, '加载失败'));
        }
    }

    _render() {
        this.listWrap.innerHTML = '';
        if (!this.tags.length) {
            this.listWrap.append(el('div', { class: 'ft-empty' },
                '暂无标签，点 + 新建'));
            return;
        }
        for (const t of this.tags) {
            const row = el('div', {
                class: 'tp-tag' + (this.selected === t.id ? ' tp-active' : ''),
                onclick: () => this._toggle(t.id),
            },
                el('span', {
                    class: 'tp-dot',
                    style: { background: t.color || '#6c5ce7' },
                }),
                el('span', { class: 'tp-name' }, t.name),
                el('span', { class: 'tp-count' }, String(t.media_count || 0)),
                el('button', {
                    class: 'tp-del',
                    title: '删除标签',
                    onclick: (e) => {
                        e.stopPropagation();
                        this._remove(t);
                    },
                }, '×'));
            this.listWrap.append(row);
        }
    }

    _toggle(id) {
        this.selected = this.selected === id ? null : id;
        this._render();
        this.onSelect(this.selected);
    }

    async _create() {
        const name = prompt('标签名：');
        if (!name || !name.trim()) return;
        try {
            await api('/api/tags', { method: 'POST', body: { name: name.trim() } });
            this.load();
        } catch (e) {
            alert('新建失败：' + e.message);
        }
    }

    async _remove(t) {
        if (!confirm(`删除标签「${t.name}」？\n（只删标签，不删媒体）`)) return;
        try {
            await api(`/api/tags/${t.id}`, { method: 'DELETE' });
            if (this.selected === t.id) {
                this.selected = null;
                this.onSelect(null);
            }
            this.load();
        } catch (e) {
            alert('删除失败：' + e.message);
        }
    }

    clearSelection() {
        this.selected = null;
        this._render();
    }
}
