/*
 * Collapsed Line Marker
 *
 * 配合「隐藏空行.css」使用:被折叠(height: 0px)的空行,行号栏里会显示一条横线,
 * 这条横线紧贴在「下方第一条可见行」的行号上方。本插件让横线的长度跟随那个行号的位数:
 *   下方行号 1~9      -> =
 *   下方行号 10~99    -> ==
 *   下方行号 100~999  -> ===
 *   以此类推
 *
 * 若连续多行都被折叠,则取它们下方第一条「未被折叠」的行;
 * 若下方没有可见行(例如渲染区域的最后一行),退回使用被折叠行自己的行号。
 *
 * 做法:给被折叠的行号元素写入 data-collapsed-marker 属性(值就是对应数量的 "="),
 * styles.css 再用 content: attr(data-collapsed-marker) 把它显示出来。
 * 不修改 CodeMirror 自己的文本节点,所以不会影响编辑器本身。
 */
'use strict';

const { Plugin } = require('obsidian');

/** 横线字符,想换成 "-" 或 "─" 改这里即可 */
const MARKER_CHAR = '=';
/** 写在行号元素上的属性名,styles.css 通过 attr() 读取它 */
const ATTR = 'data-collapsed-marker';
const GUTTER_SELECTOR = '.cm-lineNumbers';

/** 与 CSS 中 [style*="height: 0px"] 的判断保持一致 */
function isCollapsed(el) {
  return (el.getAttribute('style') || '').includes('height: 0px');
}

/** CodeMirror 在行号栏最前面放了一个不可见的占位元素(用来撑开栏宽),需要跳过 */
function isSpacer(el) {
  return el.style.visibility === 'hidden';
}

/** 行号元素里数字的位数;没有数字时返回 null */
function digitsOf(el) {
  const match = (el.textContent || '').match(/\d+/);
  return match ? match[0].length : null;
}

function setMarker(el, digits) {
  const marker = MARKER_CHAR.repeat(digits);
  // 只在值变化时才写入,避免无谓的 DOM 操作
  if (el.getAttribute(ATTR) !== marker) el.setAttribute(ATTR, marker);
}

function clearMarker(el) {
  // CodeMirror 会复用行号元素,元素不再是折叠行时要清掉旧标记
  if (el.hasAttribute(ATTR)) el.removeAttribute(ATTR);
}

/** 从下往上扫描一遍:一边记住「下方最近的可见行号位数」,一边给折叠行写标记,复杂度 O(n) */
function refreshGutter(gutter) {
  const elements = gutter.children;
  let nextVisibleDigits = null;

  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i];
    if (isSpacer(el)) continue;

    if (isCollapsed(el)) {
      setMarker(el, nextVisibleDigits ?? digitsOf(el) ?? 1);
    } else {
      clearMarker(el);
      nextVisibleDigits = digitsOf(el);
    }
  }
}

function refreshAll(doc) {
  doc.querySelectorAll(GUTTER_SELECTOR).forEach(refreshGutter);
}

/** 只关心编辑器内部的变化,其余界面的 DOM 变动直接忽略 */
function touchesEditor(record) {
  const node = record.target;
  const el = node.nodeType === 1 ? node : node.parentElement;
  return !!el && !!el.closest('.cm-editor');
}

module.exports = class CollapsedLineMarkerPlugin extends Plugin {
  onload() {
    /** @type {Map<Document, MutationObserver>} */
    this.observers = new Map();

    this.watch(document);

    // 弹出窗口(popout)有独立的 document,需要单独监听
    this.registerEvent(
      this.app.workspace.on('window-open', (_workspaceWindow, win) => this.watch(win.document))
    );
    this.registerEvent(
      this.app.workspace.on('window-close', (_workspaceWindow, win) => this.unwatch(win.document))
    );

    // 启动时已经存在的弹出窗口
    this.app.workspace.onLayoutReady(() => {
      this.app.workspace.iterateAllLeaves((leaf) => {
        const doc = leaf.view && leaf.view.containerEl && leaf.view.containerEl.ownerDocument;
        if (doc) this.watch(doc);
      });
    });
  }

  onunload() {
    for (const [doc, observer] of this.observers) {
      observer.disconnect();
      doc.querySelectorAll(`[${ATTR}]`).forEach((el) => el.removeAttribute(ATTR));
    }
    this.observers.clear();
  }

  watch(doc) {
    if (!doc || !doc.body || this.observers.has(doc)) return;

    const Observer = (doc.defaultView || window).MutationObserver;
    // MutationObserver 的回调是微任务,会在浏览器绘制之前执行,
    // 所以横线长度在第一帧就是正确的,不会闪烁。
    const observer = new Observer((records) => {
      if (records.some(touchesEditor)) refreshAll(doc);
    });

    observer.observe(doc.body, {
      subtree: true,
      childList: true, // 行号元素增删 / 行号文本被替换
      characterData: true, // 行号文本变化
      attributes: true,
      attributeFilter: ['style'], // 行高变为 0px 或恢复时触发(不会被自己写入的 data 属性触发)
    });

    this.observers.set(doc, observer);
    refreshAll(doc);
  }

  unwatch(doc) {
    const observer = this.observers.get(doc);
    if (!observer) return;
    observer.disconnect();
    this.observers.delete(doc);
  }
};
