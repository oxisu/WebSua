/**
 * 文件夹树：媒体库左侧按目录层级浏览。
 * 数据来源 GET /api/folder-tree，点击节点用 folder_prefix 过滤媒体网格。
 */
import { api, el } from './utils.js';

export class FolderTree {
    constructor(root, { onSelect } = {}) {
        this.root = root;
        this.onSelect = onSelect || (() => {});
        this.selected = '';   // 当前选中 folder_prefix
        this.data = [];       // 树数据
        this._setup();
    }

    _setup() {
        this.root.classList.add('folder-tree');
        this.root.innerHTML = '';

        // 折叠开关（手机上默认折叠）
        const toggleBtn = el('button', {
            class: 'ft-toggle',
            'aria-label': '展开/收起目录树',
            onclick: () => this.root.classList.toggle('ft-collapsed'),
        }, el('span', { class: 'ft-toggle-icon' }, '📁'), el('span', {}, '目录树'));

        this.treeWrap = el('div', { class: 'ft-wrap' });
        this.root.append(toggleBtn, this.treeWrap);

        // 手机上默认折叠
        if (window.innerWidth < 768) this.root.classList.add('ft-collapsed');
    }

    async load() {
        try {
            const r = await api('/api/folder-tree');
            this.data = r.sources || [];
            this._render();
        } catch (e) {
            this.treeWrap.innerHTML = '';
            this.treeWrap.append(el('div', { class: 'ft-empty' }, '加载失败'));
        }
    }

    _render() {
        this.treeWrap.innerHTML = '';
        if (!this.data.length) {
            this.treeWrap.append(el('div', { class: 'ft-empty' }, '暂无目录'));
            return;
        }
        for (const src of this.data) {
            const srcNode = el('div', { class: 'ft-source' },
                el('div', {
                    class: 'ft-source-name',
                    style: src.source_color ? { borderLeftColor: src.source_color } : {},
                }, src.source_name || `源 ${src.source_id}`));
            this.treeWrap.append(srcNode);
            if (src.tree && src.tree.length) {
                this._renderNodes(src.tree, srcNode, 0);
            }
        }
        // 恢复选中状态
        if (this.selected) this._markSelected(this.selected);
    }

    _renderNodes(nodes, parent, depth) {
        for (const node of nodes) {
            const hasChildren = node.children && node.children.length > 0;
            const row = el('div', {
                class: 'ft-node',
                style: { paddingLeft: `${12 + depth * 16}px` },
                'data-path': node.path,
                onclick: (e) => {
                    e.stopPropagation();
                    this._select(node.path);
                },
            });

            // 展开/收起箭头
            if (hasChildren) {
                const arrow = el('span', {
                    class: 'ft-arrow',
                    onclick: (e) => {
                        e.stopPropagation();
                        row.classList.toggle('ft-open');
                    },
                }, '▶');
                row.append(arrow);
            } else {
                row.append(el('span', { class: 'ft-arrow ft-arrow-empty' }, ''));
            }

            row.append(
                el('span', { class: 'ft-name' }, node.name),
                el('span', { class: 'ft-count' }, `(${node.count})`),
            );
            parent.append(row);

            if (hasChildren) {
                const childWrap = el('div', { class: 'ft-children' });
                parent.append(childWrap);
                this._renderNodes(node.children, childWrap, depth + 1);
            }
        }
    }

    _select(path) {
        this.selected = path;
        this._markSelected(path);
        this.onSelect(path);
    }

    _markSelected(path) {
        this.treeWrap.querySelectorAll('.ft-node').forEach(n => {
            n.classList.toggle('ft-active', n.dataset.path === path);
        });
    }

    /** 清除选中（回到全部）。 */
    clearSelection() {
        this.selected = '';
        this.treeWrap.querySelectorAll('.ft-node').forEach(n => n.classList.remove('ft-active'));
    }
}
