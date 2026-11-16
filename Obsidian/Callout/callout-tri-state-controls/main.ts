import {
  StateEffect,
  StateField,
  type Extension,
  type TransactionSpec,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type PluginValue,
  type ViewUpdate,
} from "@codemirror/view";
import { Notice, Plugin, setIcon } from "obsidian";

type CalloutMode = "locked" | "edit" | "source";
type ToggleAction = "edit" | "source";

interface CalloutRange {
  from: number;
  to: number;
}

interface ParsedHeader {
  prefix: string;
  base: string;
  spacing: string;
  title: string;
}

interface CalloutSource extends CalloutRange {
  headerTo: number;
  header: ParsedHeader;
  body: string[];
  bodyPrefixes: string[];
  original: string;
}

interface InlineSession {
  view: EditorView;
  widget: HTMLElement;
  callout: HTMLElement;
  titleInput: HTMLInputElement;
  bodyInput: HTMLTextAreaElement;
  content: HTMLElement;
  createdContent: boolean;
  source: CalloutSource;
  from: number;
  to: number;
  cleanups: Array<() => void>;
  resizeObserver: ResizeObserver | null;
}

const WIDGET_SELECTOR = ".cm-embed-block.cm-callout";
const RENDERED_CONTROLS_CLASS = "ctc-rendered-controls";
const SOURCE_CONTROLS_CLASS = "ctc-source-controls";
const INLINE_INPUT_SELECTOR = ".ctc-inline-input";
const NATIVE_EDIT_SELECTOR = ".edit-block-button";
const BASIC_INTERACTIVE_SELECTOR =
  "a.internal-link, a.external-link, .internal-link, .external-link, input[type='checkbox']";
const QUOTE_LINE_RE = /^[\s\p{Cf}]*>/u;
const QUOTE_PREFIX_RE = /^([\s\p{Cf}]*>[\s\p{Cf}]?)/u;
const CALLOUT_HEADER_RE =
  /^([\s\p{Cf}]*>\s?)\[!([^\]]+)\]([+-]?)([ \t]?)(.*)$/u;

function isQuoteLine(text: string): boolean {
  return QUOTE_LINE_RE.test(text);
}

function parseHeader(text: string): ParsedHeader | null {
  const match = CALLOUT_HEADER_RE.exec(text);
  if (!match) return null;
  const prefix = match[1] ?? "> ";
  const type = match[2] ?? "note";
  const fold = match[3] ?? "";
  return {
    prefix,
    base: `${prefix}[!${type}]${fold}`,
    spacing: match[4] ?? "",
    title: match[5] ?? "",
  };
}

function parseCalloutAt(view: EditorView, pos: number): CalloutSource | null {
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

  const body: string[] = [];
  const bodyPrefixes: string[] = [];
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
    original: doc.sliceString(headerLine.from, to),
  };
}

function scanCalloutRanges(view: EditorView): CalloutRange[] {
  const ranges: CalloutRange[] = [];
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

function parseCalloutFromWidget(
  view: EditorView,
  widget: HTMLElement,
): CalloutSource | null {
  const candidates: number[] = [];
  try {
    candidates.push(view.posAtDOM(widget, 0));
  } catch {
    // Some CM6 versions cannot map a block widget through posAtDOM.
  }
  try {
    const rect = widget.getBoundingClientRect();
    if (rect.height > 0) {
      const pos = view.posAtCoords({
        x: rect.left + 2,
        y: rect.top + Math.min(rect.height / 2, 24),
      });
      if (pos !== null) candidates.push(pos);
    }
  } catch {
    // Keep the DOM-mapping candidates when coordinate mapping is unavailable.
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

interface ModeChange {
  from: number;
  mode: CalloutMode;
}

const setModeEffect = StateEffect.define<ModeChange>();
const clearModesEffect = StateEffect.define<void>();

/** One enum per source header makes edit/source mutually exclusive by construction. */
const calloutModeField = StateField.define<ReadonlyMap<number, CalloutMode>>({
  create: () => new Map(),
  update(value, transaction) {
    let next: Map<number, CalloutMode> | null = null;
    const mutable = () => next ?? (next = new Map(value));

    if (transaction.docChanged) {
      const mapped = new Map<number, CalloutMode>();
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
        next = new Map();
      } else if (effect.is(setModeEffect)) {
        const { from, mode } = effect.value;
        if (mode === "locked") mutable().delete(from);
        else mutable().set(from, mode);
      }
    }
    return next ?? value;
  },
});

let nextToggleLabelId = 0;

function createToggleButton(
  doc: Document,
  action: ToggleAction,
): HTMLButtonElement {
  const button = doc.createElement("button");
  button.type = "button";
  button.className = `ctc-toggle ctc-${action}-toggle`;
  button.dataset.ctcAction = action;
  button.setAttribute("aria-pressed", "false");

  const icon = doc.createElement("span");
  icon.className = "ctc-toggle-icon";
  icon.setAttribute("aria-hidden", "true");
  setIcon(icon, action === "edit" ? "pencil" : "code");

  // Keep an accessible name without title/aria-label: Obsidian uses the latter
  // as a hover-tooltip trigger, while the visible label itself stays hidden.
  const label = doc.createElement("span");
  label.className = "ctc-toggle-label";
  label.id = `ctc-toggle-label-${++nextToggleLabelId}`;
  label.textContent = action === "edit" ? "编辑模式" : "源码模式";
  button.setAttribute("aria-labelledby", label.id);
  button.append(icon, label);
  return button;
}

function updateToggleButton(
  button: HTMLButtonElement,
  from: number,
  active: boolean,
): void {
  button.dataset.ctcFrom = String(from);
  button.setAttribute("aria-pressed", String(active));
  button.classList.toggle("is-active", active);
}

function createControls(
  doc: Document,
  from: number,
  mode: CalloutMode,
  source: boolean,
): HTMLSpanElement {
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

class SourceControlsWidget extends WidgetType {
  constructor(readonly from: number) {
    super();
  }

  eq(other: SourceControlsWidget): boolean {
    return this.from === other.from;
  }

  toDOM(view: EditorView): HTMLElement {
    return createControls(view.dom.ownerDocument, this.from, "source", true);
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function eventElement(event: Event): HTMLElement | null {
  const target: unknown = event.target;
  if (!target || typeof target !== "object") return null;
  if (typeof (target as Element).closest === "function") return target as HTMLElement;
  return (target as Node).parentElement ?? null;
}

function within(target: HTMLElement, selector: string, root: HTMLElement): HTMLElement | null {
  const hit = target.closest<HTMLElement>(selector);
  return hit && hit !== root && root.contains(hit) ? hit : null;
}

function selectionTouches(view: EditorView, range: CalloutRange): boolean {
  return view.state.selection.ranges.some(
    (selection) => selection.from <= range.to && selection.to >= range.from,
  );
}

function isLivePreview(view: EditorView): boolean {
  return view.dom.closest(".markdown-source-view.is-live-preview, .is-live-preview") !== null;
}

class CalloutViewController implements PluginValue {
  decorations: DecorationSet = Decoration.none;

  private ranges: CalloutRange[];
  private widgetCache = new WeakMap<HTMLElement, CalloutSource>();
  private readonly observer: MutationObserver;
  private session: InlineSession | null = null;
  private pendingEditFrom: number | null = null;
  private pendingFrame: number | null = null;
  private guardQueued = false;
  private destroyed = false;
  private lastMouseDown: { x: number; y: number } | null = null;
  private suppressedTitles: Array<{ element: HTMLElement; value: string }> = [];

  constructor(readonly view: EditorView) {
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

  update(update: ViewUpdate): void {
    if (update.docChanged) {
      this.updateSessionForDocumentChange(update);
      this.ranges = scanCalloutRanges(update.view);
      this.widgetCache = new WeakMap();
    }

    const modeChanged = update.transactions.some((transaction) =>
      transaction.effects.some(
        (effect) => effect.is(setModeEffect) || effect.is(clearModesEffect),
      ),
    );
    if (update.docChanged || update.selectionSet || update.focusChanged || modeChanged) {
      this.decorations = this.buildDecorations();
    }
    if (update.docChanged || modeChanged) this.syncWidgets();
    if (update.selectionSet || update.docChanged || update.focusChanged) {
      this.queueSelectionGuard();
    }
  }

  destroy(): void {
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

    for (const widget of Array.from(this.view.dom.querySelectorAll<HTMLElement>(WIDGET_SELECTOR))) {
      widget.classList.remove("ctc-is-locked", "ctc-is-edit", "ctc-is-source");
      for (const controls of Array.from(
        widget.querySelectorAll<HTMLElement>(`.${RENDERED_CONTROLS_CLASS}`),
      )) {
        controls.remove();
      }
    }
    this.decorations = Decoration.none;
  }

  private modeAt(from: number): CalloutMode {
    return this.view.state.field(calloutModeField).get(from) ?? "locked";
  }

  private modeEffects(from: number, mode: CalloutMode): StateEffect<ModeChange>[] {
    const effects: StateEffect<ModeChange>[] = [setModeEffect.of({ from, mode })];
    for (const [otherFrom, otherMode] of this.view.state.field(calloutModeField)) {
      if (otherFrom !== from && otherMode !== "locked") {
        effects.push(setModeEffect.of({ from: otherFrom, mode: "locked" }));
      }
    }
    return effects;
  }

  private buildDecorations(): DecorationSet {
    if (!isLivePreview(this.view)) return Decoration.none;
    const decorations = [];
    for (const range of this.ranges) {
      if (this.modeAt(range.from) !== "source") continue;
      // Obsidian withdraws its rendered Callout exactly when a focused selection
      // touches the source range. Only then is the raw-source toolbar needed.
      if (!this.view.hasFocus || !selectionTouches(this.view, range)) continue;
      decorations.push(
        Decoration.widget({
          widget: new SourceControlsWidget(range.from),
          side: -1,
        }).range(range.from),
      );
    }
    return Decoration.set(decorations);
  }

  private sourceForWidget(widget: HTMLElement): CalloutSource | null {
    const cached = this.widgetCache.get(widget);
    if (cached) return cached;
    const source = parseCalloutFromWidget(this.view, widget);
    if (source) this.widgetCache.set(widget, source);
    return source;
  }

  private rootTitle(widget: HTMLElement): { callout: HTMLElement; title: HTMLElement } | null {
    const callout = widget.querySelector<HTMLElement>(".callout");
    if (!callout) return null;
    const title = callout.querySelector<HTMLElement>(":scope > .callout-title");
    return title ? { callout, title } : null;
  }

  private syncWidgets(): void {
    if (this.destroyed || !isLivePreview(this.view)) return;
    let measureNeeded = false;
    for (const widget of Array.from(this.view.dom.querySelectorAll<HTMLElement>(WIDGET_SELECTOR))) {
      const source = this.sourceForWidget(widget);
      const root = this.rootTitle(widget);
      if (!source || !root) continue;

      let controls = root.title.querySelector<HTMLElement>(
        `:scope > .${RENDERED_CONTROLS_CLASS}`,
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
      for (const button of Array.from(controls.querySelectorAll<HTMLButtonElement>("[data-ctc-action]"))) {
        const action = button.dataset.ctcAction as ToggleAction;
        updateToggleButton(button, source.from, mode === action);
      }
    }
    if (measureNeeded) this.view.requestMeasure();
  }

  private tooltipRegion(target: HTMLElement): HTMLElement | null {
    const controls = target.closest<HTMLElement>(".ctc-controls");
    if (controls && this.view.dom.contains(controls)) return controls;
    const widget = target.closest<HTMLElement>(WIDGET_SELECTOR);
    if (!widget || !this.view.dom.contains(widget)) return null;
    const region = target.closest<HTMLElement>(".callout-title, .callout-content");
    return region && widget.contains(region) ? region : null;
  }

  private restoreSuppressedTitles(): void {
    for (const { element, value } of this.suppressedTitles.splice(0)) {
      element.setAttribute("title", value);
    }
  }

  private readonly onMouseOver = (event: MouseEvent): void => {
    const target = eventElement(event);
    if (!target || !isLivePreview(this.view)) return;
    const region = this.tooltipRegion(target);
    if (!region) return;

    this.restoreSuppressedTitles();
    let element: HTMLElement | null = target;
    while (element) {
      if (element.hasAttribute("title")) {
        this.suppressedTitles.push({ element, value: element.getAttribute("title") ?? "" });
        element.removeAttribute("title");
      }
      if (element === region) break;
      element = element.parentElement;
    }
  };

  private readonly onMouseOut = (event: MouseEvent): void => {
    const target = eventElement(event);
    if (!target) return;
    const region = this.tooltipRegion(target);
    if (!region) return;
    const related: unknown = event.relatedTarget;
    if (
      related &&
      typeof related === "object" &&
      "nodeType" in related &&
      region.contains(related as Node)
    ) {
      return;
    }
    this.restoreSuppressedTitles();
  };

  private readonly onMouseDown = (event: MouseEvent): void => {
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
    if (
      within(target, BASIC_INTERACTIVE_SELECTOR, widget) ||
      within(target, ".callout-fold", widget)
    ) {
      return;
    }
    // Do not preventDefault: browser text selection remains possible, while CM6
    // never receives the mouse selection that would withdraw the rendered widget.
    event.stopPropagation();
  };

  private readonly onClick = (event: MouseEvent): void => {
    const target = eventElement(event);
    if (!target || !isLivePreview(this.view)) return;

    const button = target.closest<HTMLButtonElement>(".ctc-toggle[data-ctc-action]");
    if (button) {
      event.preventDefault();
      event.stopPropagation();
      const from = Number(button.dataset.ctcFrom);
      const action = button.dataset.ctcAction as ToggleAction;
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
    if (
      within(target, BASIC_INTERACTIVE_SELECTOR, widget) ||
      within(target, ".callout-fold", widget)
    ) {
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

  private resolveWidget(target: HTMLElement, event: MouseEvent): HTMLElement | null {
    const direct = target.closest<HTMLElement>(WIDGET_SELECTOR);
    if (direct && this.view.dom.contains(direct)) return direct;

    const content = target.closest<HTMLElement>(".cm-content");
    if (!content || !this.view.dom.contains(content)) return null;
    const contentRect = content.getBoundingClientRect();
    if (
      event.clientX < contentRect.left ||
      event.clientX > contentRect.right ||
      event.clientY < contentRect.top ||
      event.clientY > contentRect.bottom
    ) {
      return null;
    }
    for (const widget of Array.from(content.querySelectorAll<HTMLElement>(WIDGET_SELECTOR))) {
      const rect = widget.getBoundingClientRect();
      if (
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom &&
        event.clientX >= rect.left
      ) {
        return widget;
      }
    }
    return null;
  }

  private tryToggleFold(target: HTMLElement, widget: HTMLElement, event: MouseEvent): boolean {
    // Editing takes priority over folding for the whole title row. The title input
    // can therefore place a normal caret without also changing collapsed state.
    if (this.session) return false;
    const root = this.rootTitle(widget);
    const title = target.closest<HTMLElement>(".callout-title");
    if (!root || !title || title !== root.title) return false;
    const fold = title.querySelector<HTMLElement>(":scope > .callout-fold");
    if (!fold) return false;

    if (
      this.lastMouseDown &&
      (Math.abs(event.clientX - this.lastMouseDown.x) > 5 ||
        Math.abs(event.clientY - this.lastMouseDown.y) > 5)
    ) {
      return false;
    }

    event.preventDefault();
    event.stopPropagation();
    // Replaying the native arrow click preserves Obsidian's own visual state and
    // fold persistence instead of guessing at its internal storage format.
    fold.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return true;
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const target = eventElement(event);
    if (target?.closest(INLINE_INPUT_SELECTOR)) return;
    if (
      !isLivePreview(this.view) ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
    ) {
      return;
    }

    const doc = this.view.state.doc;
    const head = this.view.state.selection.main.head;
    const locked = this.ranges.filter((range) => this.modeAt(range.from) === "locked");
    let destination: number | null = null;

    if (event.key === "ArrowRight") {
      const hit = locked.find(
        (range) => head === range.from || (head < range.from && head + 1 >= range.from),
      );
      if (hit) destination = hit.to < doc.length ? hit.to + 1 : null;
    } else if (event.key === "ArrowLeft") {
      const hit = locked.find(
        (range) => head === range.to || (head > range.to && head <= range.to + 1),
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
          destination = last < doc.lines
            ? doc.line(last + 1).from + Math.min(column, doc.line(last + 1).length)
            : null;
        }
      } else if (event.key === "ArrowUp") {
        const hit = locked.find((range) => {
          const first = doc.lineAt(range.from).number;
          const last = doc.lineAt(range.to).number;
          return line.number > last && line.number - 1 >= first && line.number - 1 <= last;
        });
        if (hit) {
          const first = doc.lineAt(hit.from).number;
          destination = first > 1
            ? doc.line(first - 1).from + Math.min(column, doc.line(first - 1).length)
            : null;
        }
      }
    }

    const enteringLockedBlock = locked.some((range) => {
      if (event.key === "ArrowRight") {
        return head === range.from || (head < range.from && head + 1 >= range.from);
      }
      if (event.key === "ArrowLeft") {
        return head === range.to || (head > range.to && head <= range.to + 1);
      }
      const line = doc.lineAt(head).number;
      const first = doc.lineAt(range.from).number;
      const last = doc.lineAt(range.to).number;
      return event.key === "ArrowDown"
        ? line < first && line + 1 >= first && line + 1 <= last
        : line > last && line - 1 >= first && line - 1 <= last;
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

  private queueSelectionGuard(): void {
    if (this.guardQueued || this.destroyed) return;
    this.guardQueued = true;
    queueMicrotask(() => {
      this.guardQueued = false;
      if (this.destroyed || !isLivePreview(this.view) || !this.view.hasFocus) return;

      const effects: StateEffect<ModeChange>[] = [];
      for (const range of this.ranges) {
        if (this.modeAt(range.from) === "source" && !selectionTouches(this.view, range)) {
          // Native Obsidian re-renders a Callout when the caret leaves it. Return
          // to locked in that case instead of leaving a falsely active source toggle.
          effects.push(setModeEffect.of({ from: range.from, mode: "locked" }));
        }
      }

      const lockedHit = this.ranges.find(
        (range) => this.modeAt(range.from) === "locked" && selectionTouches(this.view, range),
      );
      const spec: TransactionSpec = {};
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

  private outsidePosition(range: CalloutRange, head: number): number | null {
    const before = range.from > 0 ? range.from - 1 : null;
    const after = range.to < this.view.state.doc.length ? range.to + 1 : null;
    if (head <= range.from) return before ?? after;
    if (head >= range.to) return after ?? before;
    return head - range.from <= range.to - head ? before ?? after : after ?? before;
  }

  private toggleMode(from: number, action: ToggleAction): void {
    const next: CalloutMode = this.modeAt(from) === action ? "locked" : action;
    this.transitionTo(from, next);
  }

  private transitionTo(from: number, target: CalloutMode): void {
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

  private enterSource(from: number): void {
    const source = parseCalloutAt(this.view, from);
    if (!source) {
      this.view.dispatch({ effects: this.modeEffects(from, "locked") });
      return;
    }
    const titleStart = Math.min(
      source.headerTo,
      source.from + source.header.base.length + source.header.spacing.length,
    );
    this.view.focus();
    // A collapsed selection, not Obsidian's native block-sized selection, opens
    // source mode. The raw Markdown is shown without a Select-All flash.
    this.view.dispatch({
      effects: this.modeEffects(source.from, "source"),
      selection: { anchor: titleStart },
      scrollIntoView: true,
    });
  }

  private leaveSource(from: number, target: CalloutMode): void {
    const range = this.ranges.find((candidate) => candidate.from === from) ??
      parseCalloutAt(this.view, from);
    const outside = range ? this.outsidePosition(range, this.view.state.selection.main.head) : null;
    this.view.contentDOM.blur();
    const spec: TransactionSpec = { effects: this.modeEffects(from, target) };
    if (outside !== null) spec.selection = { anchor: outside };
    this.view.dispatch(spec);
  }

  private findRenderedWidget(from: number): HTMLElement | null {
    for (const widget of Array.from(this.view.dom.querySelectorAll<HTMLElement>(WIDGET_SELECTOR))) {
      if (this.sourceForWidget(widget)?.from === from) return widget;
    }
    return null;
  }

  private schedulePendingEdit(): void {
    if (this.pendingFrame !== null) cancelAnimationFrame(this.pendingFrame);
    let attempts = 0;
    const step = (): void => {
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
        new Notice("无法定位该 Callout 的渲染块，已保持锁定状态。", 2500);
        return;
      }
      this.view.requestMeasure();
      this.pendingFrame = requestAnimationFrame(step);
    };
    this.pendingFrame = requestAnimationFrame(step);
  }

  private beginInlineSession(widget: HTMLElement): void {
    if (this.session?.widget === widget) return;
    if (this.session) this.finishInlineSession("locked");
    const source = this.sourceForWidget(widget);
    const root = this.rootTitle(widget);
    if (!source || !root) return;
    const titleInner = root.title.querySelector<HTMLElement>(":scope > .callout-title-inner");
    if (!titleInner) return;

    const doc = widget.ownerDocument;
    let content = root.callout.querySelector<HTMLElement>(":scope > .callout-content");
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
    titleInput.setAttribute("aria-label", "Callout 标题");
    titleInput.spellcheck = false;

    const bodyInput = doc.createElement("textarea");
    bodyInput.className = "ctc-inline-input ctc-body-input";
    bodyInput.value = source.body.join("\n");
    bodyInput.setAttribute("aria-label", "Callout 正文");
    bodyInput.spellcheck = true;

    const controls = root.title.querySelector(`.${RENDERED_CONTROLS_CLASS}`);
    root.title.insertBefore(titleInput, controls);
    contentElement.appendChild(bodyInput);
    root.callout.classList.add("ctc-inline-editing");
    widget.classList.add("ctc-widget-editing");

    const session: InlineSession = {
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
      resizeObserver: null,
    };
    this.session = session;

    const listen = (
      element: HTMLElement,
      type: string,
      handler: EventListener,
    ): void => {
      element.addEventListener(type, handler);
      session.cleanups.push(() => element.removeEventListener(type, handler));
    };
    const stop = (event: Event): void => event.stopPropagation();
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
        "compositionend",
      ]) {
        listen(input, type, stop);
      }
    }
    listen(titleInput, "keydown", (event: Event) => {
      const key = event as KeyboardEvent;
      key.stopPropagation();
      if (key.key === "Enter") {
        key.preventDefault();
        bodyInput.focus();
        bodyInput.setSelectionRange(bodyInput.value.length, bodyInput.value.length);
      }
    });
    listen(bodyInput, "keydown", stop);

    const fitBody = (): void => {
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

  private buildEditedSource(session: InlineSession): string {
    const title = session.titleInput.value.replace(/[\r\n]+/g, " ");
    const normalizedBody = session.bodyInput.value.replace(/\r\n?/g, "\n");
    if (
      title === session.source.header.title &&
      normalizedBody === session.source.body.join("\n")
    ) {
      return session.source.original;
    }
    const spacing = title.length > 0 ? session.source.header.spacing || " " : "";
    const header = session.source.header.base + spacing + title;
    const body = normalizedBody.length === 0 && session.source.body.length === 0
      ? []
      : normalizedBody.split("\n");
    const bodyLines = body.map((line, index) => {
      const prefix = session.source.bodyPrefixes[index] ?? session.source.header.prefix;
      return line.length > 0 ? prefix + line : prefix.trimEnd();
    });
    return [header, ...bodyLines].join("\n");
  }

  private finishInlineSession(target: CalloutMode): void {
    const session = this.session;
    if (!session) return;
    if (this.view.state.doc.sliceString(session.from, session.to) !== session.source.original) {
      this.restoreSession();
      this.view.dispatch({ effects: this.modeEffects(session.from, "locked") });
      new Notice("Callout 源码已被外部修改；为避免覆盖，未写回本次编辑。", 3500);
      return;
    }

    const insert = this.buildEditedSource(session);
    const from = session.from;
    const title = session.titleInput.value.replace(/[\r\n]+/g, " ");
    const sourceAnchor = Math.min(
      from + session.source.header.base.length +
        (title.length > 0 ? session.source.header.spacing || " " : "").length + title.length,
      from + insert.length,
    );
    this.restoreSession();

    const spec: TransactionSpec = { effects: this.modeEffects(from, target) };
    if (insert !== session.source.original) spec.changes = { from, to: session.to, insert };
    if (target === "source") {
      this.view.focus();
      spec.selection = { anchor: sourceAnchor };
      spec.scrollIntoView = true;
    }
    this.view.dispatch(spec);
  }

  private restoreSession(): void {
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

  private updateSessionForDocumentChange(update: ViewUpdate): void {
    const session = this.session;
    if (!session) return;
    const from = update.changes.mapPos(session.from, 1);
    const to = update.changes.mapPos(session.to, -1);
    if (
      from > to ||
      from < 0 ||
      to > update.state.doc.length ||
      update.state.doc.sliceString(from, to) !== session.source.original
    ) {
      this.restoreSession();
      new Notice("Callout 源码已变化，就地编辑已安全关闭。", 2500);
      return;
    }
    session.from = from;
    session.to = to;
  }
}

function createCalloutExtension(): Extension {
  const controller = ViewPlugin.define((view) => new CalloutViewController(view), {
    decorations: (value) => value.decorations,
  });
  return [calloutModeField, controller];
}

export default class CalloutTriStateControlsPlugin extends Plugin {
  onload(): void {
    this.registerEditorExtension(createCalloutExtension());
  }
}
