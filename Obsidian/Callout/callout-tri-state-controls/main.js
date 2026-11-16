"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// main.ts
var main_exports = {};
__export(main_exports, {
  default: () => CalloutTriStateControlsPlugin
});
module.exports = __toCommonJS(main_exports);
var import_state = require("@codemirror/state");
var import_view = require("@codemirror/view");
var import_obsidian = require("obsidian");
var WIDGET_SELECTOR = ".cm-embed-block.cm-callout";
var RENDERED_CONTROLS_CLASS = "ctc-rendered-controls";
var SOURCE_CONTROLS_CLASS = "ctc-source-controls";
var INLINE_INPUT_SELECTOR = ".ctc-inline-input";
var NATIVE_EDIT_SELECTOR = ".edit-block-button";
var BASIC_INTERACTIVE_SELECTOR = "a.internal-link, a.external-link, .internal-link, .external-link, input[type='checkbox']";
var QUOTE_LINE_RE = /^[\s\p{Cf}]*>/u;
var QUOTE_PREFIX_RE = /^([\s\p{Cf}]*>[\s\p{Cf}]?)/u;
var CALLOUT_HEADER_RE = /^([\s\p{Cf}]*>\s?)\[!([^\]]+)\]([+-]?)([ \t]?)(.*)$/u;
function isQuoteLine(text) {
  return QUOTE_LINE_RE.test(text);
}
function parseHeader(text) {
  const match = CALLOUT_HEADER_RE.exec(text);
  if (!match) return null;
  const prefix = match[1] ?? "> ";
  const type = match[2] ?? "note";
  const fold = match[3] ?? "";
  return {
    prefix,
    base: `${prefix}[!${type}]${fold}`,
    spacing: match[4] ?? "",
    title: match[5] ?? ""
  };
}
function parseCalloutAt(view, pos) {
  const doc = view.state.doc;
  if (pos < 0 || pos > doc.length) return null;
  const line = doc.lineAt(pos);
  let first = line.number;
  while (first > 1 && isQuoteLine(doc.line(first - 1).text)) first--;
  let last = line.number;
  while (last < doc.lines && isQuoteLine(doc.line(last + 1).text)) last++;
  const headerLine = doc.line(first);
  const header = parseHeader(headerLine.text);
  if (!header) return null;
  const body = [];
  const bodyPrefixes = [];
  for (let number = first + 1; number <= last; number++) {
    const text = doc.line(number).text;
    const prefix = QUOTE_PREFIX_RE.exec(text)?.[1] ?? header.prefix;
    bodyPrefixes.push(prefix);
    body.push(text.slice(prefix.length));
  }
  const to = doc.line(last).to;
  return {
    from: headerLine.from,
    to,
    headerTo: headerLine.to,
    header,
    body,
    bodyPrefixes,
    original: doc.sliceString(headerLine.from, to)
  };
}
function scanCalloutRanges(view) {
  const ranges = [];
  const doc = view.state.doc;
  let number = 1;
  while (number <= doc.lines) {
    if (!isQuoteLine(doc.line(number).text)) {
      number++;
      continue;
    }
    const first = number;
    while (number < doc.lines && isQuoteLine(doc.line(number + 1).text)) {
      number++;
    }
    const header = parseHeader(doc.line(first).text);
    if (header) {
      ranges.push({ from: doc.line(first).from, to: doc.line(number).to });
    }
    number++;
  }
  return ranges;
}
function parseCalloutFromWidget(view, widget) {
  const candidates = [];
  try {
    candidates.push(view.posAtDOM(widget, 0));
  } catch {
  }
  try {
    const rect = widget.getBoundingClientRect();
    if (rect.height > 0) {
      const pos = view.posAtCoords({
        x: rect.left + 2,
        y: rect.top + Math.min(rect.height / 2, 24)
      });
      if (pos !== null) candidates.push(pos);
    }
  } catch {
  }
  for (const candidate of candidates) {
    for (const delta of [0, -1, 1]) {
      const pos = Math.max(0, Math.min(view.state.doc.length, candidate + delta));
      const source = parseCalloutAt(view, pos);
      if (source) return source;
    }
  }
  return null;
}
var setModeEffect = import_state.StateEffect.define();
var clearModesEffect = import_state.StateEffect.define();
var calloutModeField = import_state.StateField.define({
  create: () => /* @__PURE__ */ new Map(),
  update(value, transaction) {
    let next = null;
    const mutable = () => next ?? (next = new Map(value));
    if (transaction.docChanged) {
      const mapped = /* @__PURE__ */ new Map();
      for (const [from, mode] of value) {
        const newFrom = transaction.changes.mapPos(from, 1);
        if (newFrom < 0 || newFrom > transaction.state.doc.length) continue;
        const line = transaction.state.doc.lineAt(newFrom);
        if (line.from === newFrom && parseHeader(line.text)) mapped.set(newFrom, mode);
      }
      next = mapped;
    }
    for (const effect of transaction.effects) {
      if (effect.is(clearModesEffect)) {
        next = /* @__PURE__ */ new Map();
      } else if (effect.is(setModeEffect)) {
        const { from, mode } = effect.value;
        if (mode === "locked") mutable().delete(from);
        else mutable().set(from, mode);
      }
    }
    return next ?? value;
  }
});
var nextToggleLabelId = 0;
function createToggleButton(doc, action) {
  const button = doc.createElement("button");
  button.type = "button";
  button.className = `ctc-toggle ctc-${action}-toggle`;
  button.dataset.ctcAction = action;
  button.setAttribute("aria-pressed", "false");
  const icon = doc.createElement("span");
  icon.className = "ctc-toggle-icon";
  icon.setAttribute("aria-hidden", "true");
  (0, import_obsidian.setIcon)(icon, action === "edit" ? "pencil" : "code");
  const label = doc.createElement("span");
  label.className = "ctc-toggle-label";
  label.id = `ctc-toggle-label-${++nextToggleLabelId}`;
  label.textContent = action === "edit" ? "\u7F16\u8F91\u6A21\u5F0F" : "\u6E90\u7801\u6A21\u5F0F";
  button.setAttribute("aria-labelledby", label.id);
  button.append(icon, label);
  return button;
}
function updateToggleButton(button, from, active) {
  button.dataset.ctcFrom = String(from);
  button.setAttribute("aria-pressed", String(active));
  button.classList.toggle("is-active", active);
}
function createControls(doc, from, mode, source) {
  const controls = doc.createElement("span");
  controls.className = `ctc-controls ${source ? SOURCE_CONTROLS_CLASS : RENDERED_CONTROLS_CLASS}`;
  controls.contentEditable = "false";
  const edit = createToggleButton(doc, "edit");
  const raw = createToggleButton(doc, "source");
  updateToggleButton(edit, from, mode === "edit");
  updateToggleButton(raw, from, mode === "source");
  controls.append(edit, raw);
  return controls;
}
var SourceControlsWidget = class extends import_view.WidgetType {
  constructor(from) {
    super();
    this.from = from;
  }
  eq(other) {
    return this.from === other.from;
  }
  toDOM(view) {
    return createControls(view.dom.ownerDocument, this.from, "source", true);
  }
  ignoreEvent() {
    return true;
  }
};
function eventElement(event) {
  const target = event.target;
  if (!target || typeof target !== "object") return null;
  if (typeof target.closest === "function") return target;
  return target.parentElement ?? null;
}
function within(target, selector, root) {
  const hit = target.closest(selector);
  return hit && hit !== root && root.contains(hit) ? hit : null;
}
function selectionTouches(view, range) {
  return view.state.selection.ranges.some(
    (selection) => selection.from <= range.to && selection.to >= range.from
  );
}
function isLivePreview(view) {
  return view.dom.closest(".markdown-source-view.is-live-preview, .is-live-preview") !== null;
}
var CalloutViewController = class {
  constructor(view) {
    this.view = view;
    this.decorations = import_view.Decoration.none;
    this.widgetCache = /* @__PURE__ */ new WeakMap();
    this.session = null;
    this.pendingEditFrom = null;
    this.pendingFrame = null;
    this.guardQueued = false;
    this.destroyed = false;
    this.lastMouseDown = null;
    this.suppressedTitles = [];
    this.onMouseOver = (event) => {
      const target = eventElement(event);
      if (!target || !isLivePreview(this.view)) return;
      const region = this.tooltipRegion(target);
      if (!region) return;
      this.restoreSuppressedTitles();
      let element = target;
      while (element) {
        if (element.hasAttribute("title")) {
          this.suppressedTitles.push({ element, value: element.getAttribute("title") ?? "" });
          element.removeAttribute("title");
        }
        if (element === region) break;
        element = element.parentElement;
      }
    };
    this.onMouseOut = (event) => {
      const target = eventElement(event);
      if (!target) return;
      const region = this.tooltipRegion(target);
      if (!region) return;
      const related = event.relatedTarget;
      if (related && typeof related === "object" && "nodeType" in related && region.contains(related)) {
        return;
      }
      this.restoreSuppressedTitles();
    };
    this.onMouseDown = (event) => {
      const target = eventElement(event);
      if (!target || !isLivePreview(this.view)) return;
      this.lastMouseDown = { x: event.clientX, y: event.clientY };
      if (target.closest(".ctc-controls, .ctc-inline-input")) {
        if (target.closest(".ctc-controls")) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      if (target.closest(NATIVE_EDIT_SELECTOR)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const widget = this.resolveWidget(target, event);
      if (!widget) return;
      if (within(target, BASIC_INTERACTIVE_SELECTOR, widget) || within(target, ".callout-fold", widget)) {
        return;
      }
      event.stopPropagation();
    };
    this.onClick = (event) => {
      const target = eventElement(event);
      if (!target || !isLivePreview(this.view)) return;
      const button = target.closest(".ctc-toggle[data-ctc-action]");
      if (button) {
        event.preventDefault();
        event.stopPropagation();
        const from = Number(button.dataset.ctcFrom);
        const action = button.dataset.ctcAction;
        if (Number.isInteger(from)) this.toggleMode(from, action);
        return;
      }
      if (target.closest(NATIVE_EDIT_SELECTOR)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (target.closest(INLINE_INPUT_SELECTOR)) return;
      const widget = this.resolveWidget(target, event);
      if (!widget) return;
      if (within(target, BASIC_INTERACTIVE_SELECTOR, widget) || within(target, ".callout-fold", widget)) {
        return;
      }
      const source = this.sourceForWidget(widget);
      if (!source) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const mode = this.modeAt(source.from);
      if (mode === "source") {
        event.preventDefault();
        event.stopPropagation();
        this.enterSource(source.from);
        return;
      }
      if (mode === "edit") {
        event.preventDefault();
        event.stopPropagation();
        if (!this.session) this.beginInlineSession(widget);
        return;
      }
      if (this.tryToggleFold(target, widget, event)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    this.onKeyDown = (event) => {
      const target = eventElement(event);
      if (target?.closest(INLINE_INPUT_SELECTOR)) return;
      if (!isLivePreview(this.view) || event.altKey || event.ctrlKey || event.metaKey || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        return;
      }
      const doc = this.view.state.doc;
      const head = this.view.state.selection.main.head;
      const locked = this.ranges.filter((range) => this.modeAt(range.from) === "locked");
      let destination = null;
      if (event.key === "ArrowRight") {
        const hit = locked.find(
          (range) => head === range.from || head < range.from && head + 1 >= range.from
        );
        if (hit) destination = hit.to < doc.length ? hit.to + 1 : null;
      } else if (event.key === "ArrowLeft") {
        const hit = locked.find(
          (range) => head === range.to || head > range.to && head <= range.to + 1
        );
        if (hit) destination = hit.from > 0 ? hit.from - 1 : null;
      } else {
        const line = doc.lineAt(head);
        const column = head - line.from;
        if (event.key === "ArrowDown") {
          const hit = locked.find((range) => {
            const first = doc.lineAt(range.from).number;
            const last = doc.lineAt(range.to).number;
            return line.number < first && line.number + 1 >= first && line.number + 1 <= last;
          });
          if (hit) {
            const last = doc.lineAt(hit.to).number;
            destination = last < doc.lines ? doc.line(last + 1).from + Math.min(column, doc.line(last + 1).length) : null;
          }
        } else if (event.key === "ArrowUp") {
          const hit = locked.find((range) => {
            const first = doc.lineAt(range.from).number;
            const last = doc.lineAt(range.to).number;
            return line.number > last && line.number - 1 >= first && line.number - 1 <= last;
          });
          if (hit) {
            const first = doc.lineAt(hit.from).number;
            destination = first > 1 ? doc.line(first - 1).from + Math.min(column, doc.line(first - 1).length) : null;
          }
        }
      }
      const enteringLockedBlock = locked.some((range) => {
        if (event.key === "ArrowRight") {
          return head === range.from || head < range.from && head + 1 >= range.from;
        }
        if (event.key === "ArrowLeft") {
          return head === range.to || head > range.to && head <= range.to + 1;
        }
        const line = doc.lineAt(head).number;
        const first = doc.lineAt(range.from).number;
        const last = doc.lineAt(range.to).number;
        return event.key === "ArrowDown" ? line < first && line + 1 >= first && line + 1 <= last : line > last && line - 1 >= first && line - 1 <= last;
      });
      if (!enteringLockedBlock) return;
      event.preventDefault();
      event.stopPropagation();
      if (destination === null) {
        this.view.contentDOM.blur();
        return;
      }
      this.view.dispatch({ selection: { anchor: destination }, scrollIntoView: true });
    };
    this.ranges = scanCalloutRanges(view);
    this.decorations = this.buildDecorations();
    this.observer = new MutationObserver(() => {
      if (!this.destroyed && isLivePreview(this.view)) this.syncWidgets();
    });
    this.observer.observe(view.dom, { childList: true, subtree: true });
    view.dom.addEventListener("mousedown", this.onMouseDown, true);
    view.dom.addEventListener("click", this.onClick, true);
    view.dom.addEventListener("keydown", this.onKeyDown, true);
    view.dom.addEventListener("mouseover", this.onMouseOver, true);
    view.dom.addEventListener("mouseout", this.onMouseOut, true);
    queueMicrotask(() => {
      if (!this.destroyed) this.syncWidgets();
    });
  }
  update(update) {
    if (update.docChanged) {
      this.updateSessionForDocumentChange(update);
      this.ranges = scanCalloutRanges(update.view);
      this.widgetCache = /* @__PURE__ */ new WeakMap();
    }
    const modeChanged = update.transactions.some(
      (transaction) => transaction.effects.some(
        (effect) => effect.is(setModeEffect) || effect.is(clearModesEffect)
      )
    );
    if (update.docChanged || update.selectionSet || update.focusChanged || modeChanged) {
      this.decorations = this.buildDecorations();
    }
    if (update.docChanged || modeChanged) this.syncWidgets();
    if (update.selectionSet || update.docChanged || update.focusChanged) {
      this.queueSelectionGuard();
    }
  }
  destroy() {
    this.destroyed = true;
    this.observer.disconnect();
    this.view.dom.removeEventListener("mousedown", this.onMouseDown, true);
    this.view.dom.removeEventListener("click", this.onClick, true);
    this.view.dom.removeEventListener("keydown", this.onKeyDown, true);
    this.view.dom.removeEventListener("mouseover", this.onMouseOver, true);
    this.view.dom.removeEventListener("mouseout", this.onMouseOut, true);
    this.restoreSuppressedTitles();
    if (this.pendingFrame !== null) cancelAnimationFrame(this.pendingFrame);
    this.pendingFrame = null;
    this.pendingEditFrom = null;
    this.restoreSession();
    for (const widget of Array.from(this.view.dom.querySelectorAll(WIDGET_SELECTOR))) {
      widget.classList.remove("ctc-is-locked", "ctc-is-edit", "ctc-is-source");
      for (const controls of Array.from(
        widget.querySelectorAll(`.${RENDERED_CONTROLS_CLASS}`)
      )) {
        controls.remove();
      }
    }
    this.decorations = import_view.Decoration.none;
  }
  modeAt(from) {
    return this.view.state.field(calloutModeField).get(from) ?? "locked";
  }
  modeEffects(from, mode) {
    const effects = [setModeEffect.of({ from, mode })];
    for (const [otherFrom, otherMode] of this.view.state.field(calloutModeField)) {
      if (otherFrom !== from && otherMode !== "locked") {
        effects.push(setModeEffect.of({ from: otherFrom, mode: "locked" }));
      }
    }
    return effects;
  }
  buildDecorations() {
    if (!isLivePreview(this.view)) return import_view.Decoration.none;
    const decorations = [];
    for (const range of this.ranges) {
      if (this.modeAt(range.from) !== "source") continue;
      if (!this.view.hasFocus || !selectionTouches(this.view, range)) continue;
      decorations.push(
        import_view.Decoration.widget({
          widget: new SourceControlsWidget(range.from),
          side: -1
        }).range(range.from)
      );
    }
    return import_view.Decoration.set(decorations);
  }
  sourceForWidget(widget) {
    const cached = this.widgetCache.get(widget);
    if (cached) return cached;
    const source = parseCalloutFromWidget(this.view, widget);
    if (source) this.widgetCache.set(widget, source);
    return source;
  }
  rootTitle(widget) {
    const callout = widget.querySelector(".callout");
    if (!callout) return null;
    const title = callout.querySelector(":scope > .callout-title");
    return title ? { callout, title } : null;
  }
  syncWidgets() {
    if (this.destroyed || !isLivePreview(this.view)) return;
    let measureNeeded = false;
    for (const widget of Array.from(this.view.dom.querySelectorAll(WIDGET_SELECTOR))) {
      const source = this.sourceForWidget(widget);
      const root = this.rootTitle(widget);
      if (!source || !root) continue;
      let controls = root.title.querySelector(
        `:scope > .${RENDERED_CONTROLS_CLASS}`
      );
      if (!controls) {
        controls = createControls(root.title.ownerDocument, source.from, "locked", false);
        root.title.appendChild(controls);
        measureNeeded = true;
      }
      const mode = this.modeAt(source.from);
      widget.classList.toggle("ctc-is-locked", mode === "locked");
      widget.classList.toggle("ctc-is-edit", mode === "edit");
      widget.classList.toggle("ctc-is-source", mode === "source");
      for (const button of Array.from(controls.querySelectorAll("[data-ctc-action]"))) {
        const action = button.dataset.ctcAction;
        updateToggleButton(button, source.from, mode === action);
      }
    }
    if (measureNeeded) this.view.requestMeasure();
  }
  tooltipRegion(target) {
    const controls = target.closest(".ctc-controls");
    if (controls && this.view.dom.contains(controls)) return controls;
    const widget = target.closest(WIDGET_SELECTOR);
    if (!widget || !this.view.dom.contains(widget)) return null;
    const region = target.closest(".callout-title, .callout-content");
    return region && widget.contains(region) ? region : null;
  }
  restoreSuppressedTitles() {
    for (const { element, value } of this.suppressedTitles.splice(0)) {
      element.setAttribute("title", value);
    }
  }
  resolveWidget(target, event) {
    const direct = target.closest(WIDGET_SELECTOR);
    if (direct && this.view.dom.contains(direct)) return direct;
    const content = target.closest(".cm-content");
    if (!content || !this.view.dom.contains(content)) return null;
    const contentRect = content.getBoundingClientRect();
    if (event.clientX < contentRect.left || event.clientX > contentRect.right || event.clientY < contentRect.top || event.clientY > contentRect.bottom) {
      return null;
    }
    for (const widget of Array.from(content.querySelectorAll(WIDGET_SELECTOR))) {
      const rect = widget.getBoundingClientRect();
      if (event.clientY >= rect.top && event.clientY <= rect.bottom && event.clientX >= rect.left) {
        return widget;
      }
    }
    return null;
  }
  tryToggleFold(target, widget, event) {
    if (this.session) return false;
    const root = this.rootTitle(widget);
    const title = target.closest(".callout-title");
    if (!root || !title || title !== root.title) return false;
    const fold = title.querySelector(":scope > .callout-fold");
    if (!fold) return false;
    if (this.lastMouseDown && (Math.abs(event.clientX - this.lastMouseDown.x) > 5 || Math.abs(event.clientY - this.lastMouseDown.y) > 5)) {
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    fold.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return true;
  }
  queueSelectionGuard() {
    if (this.guardQueued || this.destroyed) return;
    this.guardQueued = true;
    queueMicrotask(() => {
      this.guardQueued = false;
      if (this.destroyed || !isLivePreview(this.view) || !this.view.hasFocus) return;
      const effects = [];
      for (const range of this.ranges) {
        if (this.modeAt(range.from) === "source" && !selectionTouches(this.view, range)) {
          effects.push(setModeEffect.of({ from: range.from, mode: "locked" }));
        }
      }
      const lockedHit = this.ranges.find(
        (range) => this.modeAt(range.from) === "locked" && selectionTouches(this.view, range)
      );
      const spec = {};
      if (effects.length > 0) spec.effects = effects;
      if (lockedHit) {
        const outside = this.outsidePosition(lockedHit, this.view.state.selection.main.head);
        if (outside === null) {
          if (effects.length > 0) this.view.dispatch(spec);
          this.view.contentDOM.blur();
          return;
        }
        spec.selection = { anchor: outside };
      }
      if (spec.effects || spec.selection) this.view.dispatch(spec);
    });
  }
  outsidePosition(range, head) {
    const before = range.from > 0 ? range.from - 1 : null;
    const after = range.to < this.view.state.doc.length ? range.to + 1 : null;
    if (head <= range.from) return before ?? after;
    if (head >= range.to) return after ?? before;
    return head - range.from <= range.to - head ? before ?? after : after ?? before;
  }
  toggleMode(from, action) {
    const next = this.modeAt(from) === action ? "locked" : action;
    this.transitionTo(from, next);
  }
  transitionTo(from, target) {
    if (!isLivePreview(this.view)) return;
    const current = this.modeAt(from);
    if (current === target) return;
    if (current === "edit" && this.session && this.session.from === from) {
      this.finishInlineSession(target);
      return;
    }
    if (this.session) this.finishInlineSession("locked");
    if (target === "locked") {
      if (current === "source") this.leaveSource(from, "locked");
      else this.view.dispatch({ effects: this.modeEffects(from, "locked") });
      return;
    }
    if (target === "source") {
      this.enterSource(from);
      return;
    }
    if (current === "source") {
      this.pendingEditFrom = from;
      this.leaveSource(from, "edit");
      this.schedulePendingEdit();
      return;
    }
    this.view.dispatch({ effects: this.modeEffects(from, "edit") });
    const widget = this.findRenderedWidget(from);
    if (widget) this.beginInlineSession(widget);
    else {
      this.pendingEditFrom = from;
      this.schedulePendingEdit();
    }
  }
  enterSource(from) {
    const source = parseCalloutAt(this.view, from);
    if (!source) {
      this.view.dispatch({ effects: this.modeEffects(from, "locked") });
      return;
    }
    const titleStart = Math.min(
      source.headerTo,
      source.from + source.header.base.length + source.header.spacing.length
    );
    this.view.focus();
    this.view.dispatch({
      effects: this.modeEffects(source.from, "source"),
      selection: { anchor: titleStart },
      scrollIntoView: true
    });
  }
  leaveSource(from, target) {
    const range = this.ranges.find((candidate) => candidate.from === from) ?? parseCalloutAt(this.view, from);
    const outside = range ? this.outsidePosition(range, this.view.state.selection.main.head) : null;
    this.view.contentDOM.blur();
    const spec = { effects: this.modeEffects(from, target) };
    if (outside !== null) spec.selection = { anchor: outside };
    this.view.dispatch(spec);
  }
  findRenderedWidget(from) {
    for (const widget of Array.from(this.view.dom.querySelectorAll(WIDGET_SELECTOR))) {
      if (this.sourceForWidget(widget)?.from === from) return widget;
    }
    return null;
  }
  schedulePendingEdit() {
    if (this.pendingFrame !== null) cancelAnimationFrame(this.pendingFrame);
    let attempts = 0;
    const step = () => {
      this.pendingFrame = null;
      const from = this.pendingEditFrom;
      if (this.destroyed || from === null || this.modeAt(from) !== "edit") return;
      const widget = this.findRenderedWidget(from);
      if (widget) {
        this.pendingEditFrom = null;
        this.beginInlineSession(widget);
        return;
      }
      attempts++;
      if (attempts >= 60) {
        this.pendingEditFrom = null;
        this.view.dispatch({ effects: this.modeEffects(from, "locked") });
        new import_obsidian.Notice("\u65E0\u6CD5\u5B9A\u4F4D\u8BE5 Callout \u7684\u6E32\u67D3\u5757\uFF0C\u5DF2\u4FDD\u6301\u9501\u5B9A\u72B6\u6001\u3002", 2500);
        return;
      }
      this.view.requestMeasure();
      this.pendingFrame = requestAnimationFrame(step);
    };
    this.pendingFrame = requestAnimationFrame(step);
  }
  beginInlineSession(widget) {
    if (this.session?.widget === widget) return;
    if (this.session) this.finishInlineSession("locked");
    const source = this.sourceForWidget(widget);
    const root = this.rootTitle(widget);
    if (!source || !root) return;
    const titleInner = root.title.querySelector(":scope > .callout-title-inner");
    if (!titleInner) return;
    const doc = widget.ownerDocument;
    let content = root.callout.querySelector(":scope > .callout-content");
    let createdContent = false;
    if (!content) {
      content = doc.createElement("div");
      content.className = "callout-content";
      root.callout.appendChild(content);
      createdContent = true;
    }
    const contentElement = content;
    const titleInput = doc.createElement("input");
    titleInput.type = "text";
    titleInput.className = "ctc-inline-input ctc-title-input";
    titleInput.value = source.header.title;
    titleInput.setAttribute("aria-label", "Callout \u6807\u9898");
    titleInput.spellcheck = false;
    const bodyInput = doc.createElement("textarea");
    bodyInput.className = "ctc-inline-input ctc-body-input";
    bodyInput.value = source.body.join("\n");
    bodyInput.setAttribute("aria-label", "Callout \u6B63\u6587");
    bodyInput.spellcheck = true;
    const controls = root.title.querySelector(`.${RENDERED_CONTROLS_CLASS}`);
    root.title.insertBefore(titleInput, controls);
    contentElement.appendChild(bodyInput);
    root.callout.classList.add("ctc-inline-editing");
    widget.classList.add("ctc-widget-editing");
    const session = {
      view: this.view,
      widget,
      callout: root.callout,
      titleInput,
      bodyInput,
      content: contentElement,
      createdContent,
      source,
      from: source.from,
      to: source.to,
      cleanups: [],
      resizeObserver: null
    };
    this.session = session;
    const listen = (element, type, handler) => {
      element.addEventListener(type, handler);
      session.cleanups.push(() => element.removeEventListener(type, handler));
    };
    const stop = (event) => event.stopPropagation();
    for (const input of [titleInput, bodyInput]) {
      for (const type of [
        "mousedown",
        "click",
        "dblclick",
        "keyup",
        "beforeinput",
        "paste",
        "compositionstart",
        "compositionupdate",
        "compositionend"
      ]) {
        listen(input, type, stop);
      }
    }
    listen(titleInput, "keydown", (event) => {
      const key = event;
      key.stopPropagation();
      if (key.key === "Enter") {
        key.preventDefault();
        bodyInput.focus();
        bodyInput.setSelectionRange(bodyInput.value.length, bodyInput.value.length);
      }
    });
    listen(bodyInput, "keydown", stop);
    const fitBody = () => {
      bodyInput.style.height = "0px";
      bodyInput.style.height = `${bodyInput.scrollHeight}px`;
      this.view.requestMeasure();
    };
    listen(bodyInput, "input", fitBody);
    session.resizeObserver = new ResizeObserver(fitBody);
    session.resizeObserver.observe(contentElement);
    fitBody();
    titleInput.focus({ preventScroll: true });
    const end = titleInput.value.length;
    titleInput.setSelectionRange(end, end);
    this.view.requestMeasure();
  }
  buildEditedSource(session) {
    const title = session.titleInput.value.replace(/[\r\n]+/g, " ");
    const normalizedBody = session.bodyInput.value.replace(/\r\n?/g, "\n");
    if (title === session.source.header.title && normalizedBody === session.source.body.join("\n")) {
      return session.source.original;
    }
    const spacing = title.length > 0 ? session.source.header.spacing || " " : "";
    const header = session.source.header.base + spacing + title;
    const body = normalizedBody.length === 0 && session.source.body.length === 0 ? [] : normalizedBody.split("\n");
    const bodyLines = body.map((line, index) => {
      const prefix = session.source.bodyPrefixes[index] ?? session.source.header.prefix;
      return line.length > 0 ? prefix + line : prefix.trimEnd();
    });
    return [header, ...bodyLines].join("\n");
  }
  finishInlineSession(target) {
    const session = this.session;
    if (!session) return;
    if (this.view.state.doc.sliceString(session.from, session.to) !== session.source.original) {
      this.restoreSession();
      this.view.dispatch({ effects: this.modeEffects(session.from, "locked") });
      new import_obsidian.Notice("Callout \u6E90\u7801\u5DF2\u88AB\u5916\u90E8\u4FEE\u6539\uFF1B\u4E3A\u907F\u514D\u8986\u76D6\uFF0C\u672A\u5199\u56DE\u672C\u6B21\u7F16\u8F91\u3002", 3500);
      return;
    }
    const insert = this.buildEditedSource(session);
    const from = session.from;
    const title = session.titleInput.value.replace(/[\r\n]+/g, " ");
    const sourceAnchor = Math.min(
      from + session.source.header.base.length + (title.length > 0 ? session.source.header.spacing || " " : "").length + title.length,
      from + insert.length
    );
    this.restoreSession();
    const spec = { effects: this.modeEffects(from, target) };
    if (insert !== session.source.original) spec.changes = { from, to: session.to, insert };
    if (target === "source") {
      this.view.focus();
      spec.selection = { anchor: sourceAnchor };
      spec.scrollIntoView = true;
    }
    this.view.dispatch(spec);
  }
  restoreSession() {
    const session = this.session;
    if (!session) return;
    this.session = null;
    session.resizeObserver?.disconnect();
    for (const cleanup of session.cleanups.splice(0)) cleanup();
    session.titleInput.remove();
    session.bodyInput.remove();
    session.callout.classList.remove("ctc-inline-editing");
    session.widget.classList.remove("ctc-widget-editing");
    if (session.createdContent) session.content.remove();
    this.view.requestMeasure();
  }
  updateSessionForDocumentChange(update) {
    const session = this.session;
    if (!session) return;
    const from = update.changes.mapPos(session.from, 1);
    const to = update.changes.mapPos(session.to, -1);
    if (from > to || from < 0 || to > update.state.doc.length || update.state.doc.sliceString(from, to) !== session.source.original) {
      this.restoreSession();
      new import_obsidian.Notice("Callout \u6E90\u7801\u5DF2\u53D8\u5316\uFF0C\u5C31\u5730\u7F16\u8F91\u5DF2\u5B89\u5168\u5173\u95ED\u3002", 2500);
      return;
    }
    session.from = from;
    session.to = to;
  }
};
function createCalloutExtension() {
  const controller = import_view.ViewPlugin.define((view) => new CalloutViewController(view), {
    decorations: (value) => value.decorations
  });
  return [calloutModeField, controller];
}
var CalloutTriStateControlsPlugin = class extends import_obsidian.Plugin {
  onload() {
    this.registerEditorExtension(createCalloutExtension());
  }
};
