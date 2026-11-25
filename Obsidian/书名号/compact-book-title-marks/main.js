const { Plugin } = require("obsidian");
const { ViewPlugin, Decoration } = require("@codemirror/view");
const { RangeSetBuilder } = require("@codemirror/state");

const OPEN = "《";
const CLOSE = "》";
const CLASS_LEFT = "cn-booktitle-left";
const CLASS_RIGHT = "cn-booktitle-right";

/* ---------- 编辑器（实时预览 / 源码模式） ---------- */

const leftMark = Decoration.mark({ class: CLASS_LEFT });
const rightMark = Decoration.mark({ class: CLASS_RIGHT });

function buildDecorations(view) {
  const builder = new RangeSetBuilder();
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === OPEN) builder.add(from + i, from + i + 1, leftMark);
      else if (ch === CLOSE) builder.add(from + i, from + i + 1, rightMark);
    }
  }
  return builder.finish();
}

const bookTitleEditorExtension = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = buildDecorations(view);
    }
    update(update) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations }
);

/* ---------- 阅读模式（也覆盖实时预览里的表格、标注块等渲染内容） ---------- */

function wrapBookTitleMarks(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!/[《》]/.test(node.nodeValue)) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (parent && parent.closest(`code, pre, .${CLASS_LEFT}, .${CLASS_RIGHT}`)) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const targets = [];
  while (walker.nextNode()) targets.push(walker.currentNode);

  for (const node of targets) {
    const frag = document.createDocumentFragment();
    for (const part of node.nodeValue.split(/([《》])/)) {
      if (part === OPEN || part === CLOSE) {
        const span = document.createElement("span");
        span.className = part === OPEN ? CLASS_LEFT : CLASS_RIGHT;
        span.textContent = part;
        frag.appendChild(span);
      } else if (part) {
        frag.appendChild(document.createTextNode(part));
      }
    }
    node.parentNode.replaceChild(frag, node);
  }
}

/* ---------- 插件入口 ---------- */

module.exports = class CompactBookTitleMarks extends Plugin {
  onload() {
    this.registerEditorExtension(bookTitleEditorExtension);
    this.registerMarkdownPostProcessor((el) => wrapBookTitleMarks(el));
  }
};
