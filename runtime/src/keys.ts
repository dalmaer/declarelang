// Keys — the raw keyboard service (docs/system-design/input.md, Layer 1). The bottom
// of the input stack: key up/down, modifier state, a held-key set, and chords —
// useful with NO focused field (shortcuts, games, key-repeat). DOM is the
// kernel reference (LZX's LzKeyboardKernel is itself a thin wrapper over DOM
// keydown/keyup); keys always originate from the DOM host — canvas included —
// so this service normalizes ONE DOM source regardless of backend, and the
// focus layer (focus.ts, next) subscribes to it to deliver to the focused view.
//
// The CORE is pure: it accepts already-normalized KeyEvents, keeps state, and
// dispatches — so it unit-tests with synthetic events, no browser. `listen()`
// is the thin DOM adapter that feeds the core from a host, self-retiring on the
// `alive` gate exactly like routeInput (input.ts).

/** One normalized key event — the physical `code` (KeyboardEvent.code, layout-
 *  independent, the right key for shortcuts/games), the produced `key`
 *  (KeyboardEvent.key), the modifier flags, and whether it is an auto-repeat.
 *  No `keypress` (deprecated). */
export interface KeyEvent {
  code: string;
  key: string;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
  repeat: boolean;
}

type KeyHandler = (e: KeyEvent) => void;

/** What the keyboard needs to know about the program tree, injected by
 *  services.ts (keys.ts sits below the view layer and stays node-free). A
 *  PROGRAM is a tree mounted as an app — the top-level one or an island's
 *  tenant — named here by its root. */
export interface KeysPrograms {
  /** The program a node belongs to (the root of its tree). */
  programOf(node: object): object;
  /** The program the keyboard goes to now (keyboard-follows-focus.md, Rule 1):
   *  the focused view's, the tenant of a focused island, else the top-level
   *  one. Null when there is no top-level program to fall back on. */
  keyboardProgram(): object | null;
  /** The view a node's claim belongs to: the node itself, or its nearest view. */
  viewOf(node: object): object | null;
  /** Is the view shown — itself and every ancestor visible? */
  shown(view: object): boolean;
  /** Run `fn` when the node is discarded. */
  onGone(node: object, fn: () => void): void;
}
let PROGRAMS: KeysPrograms | null = null;
export function setKeysPrograms(p: KeysPrograms | null): void {
  PROGRAMS = p;
}

/** The node whose compiled body is running, while it runs a body that names
 *  `Keys` (expr.ts sets it around exactly those bodies): who is asking
 *  `Keys.isDown`. Returns the previous caller, for the body to restore. */
let CALLER: object | null = null;
export function keysCaller(node: object | null): object | null {
  const prev = CALLER;
  CALLER = node;
  return prev;
}

/** The modifier keys. A held modifier is the keyboard's state rather than a
 *  press — what a click reads to extend a selection — so every program sees
 *  it, the keyboard moving does not release it, and polling it claims nothing. */
const MODIFIERS = new Set(["ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight"]);

/** A held key whose press no program can claim any more: the keyboard moved
 *  to another program while it was down, and the program that had it was
 *  told it went up. */
const ORPHAN = {};

/** A held key: the press, and the program that had the keyboard when it went
 *  down (null when there were no programs to choose between). */
interface Held {
  e: KeyEvent;
  program: object | null;
}

interface Chord {
  codes: Set<string>;
  fn: () => void;
  /** Fired-and-held: true from the keyDown that completed the chord until one
   *  of its keys releases, so a held chord (or auto-repeat) fires once. */
  active: boolean;
}

/** The keyboard service. A singleton `Keys` is exported for the runtime; tests
 *  construct their own instance and drive `keyDown`/`keyUp` directly. */
/** Injected by index.ts (keys.ts sits below focus.ts in the module graph):
 *  "does a Declare view hold keyboard focus right now?" — the predicate the
 *  listener uses to claim Space/arrows from the browser's scroll defaults. */
let keysFocusProbe: (() => boolean) | null = null;
export function setKeysFocusProbe(fn: () => boolean): void {
  keysFocusProbe = fn;
}

export class KeysService {
  /** The held keys (LZX's downKeysHash) — what is pressed right now, each
   *  with the program it was pressed in. */
  private readonly heldKeys = new Map<string, Held>();

  /** The program that had the keyboard at the last look, to see it move. */
  private lastProgram: object | null = null;

  /** Polled keys → the views that poll them (Rule 2): a key a shown view of
   *  the keyboard program polls is the program's, and the browser's own use
   *  of it stands down. */
  private readonly claims = new Map<string, Set<object>>();

  /** Views currently claiming the NAVIGATION keys (arrows, Space, Home/End,
   *  PageUp/Down) from the browser's scroll defaults — an open Menu chain,
   *  any overlay that roves with arrows while nothing holds Declare focus.
   *  A Set of claimant owners so overlapping claims (a menu over a menu)
   *  compose; `navClaim(owner, false)` releases only its own. */
  private readonly navClaims = new Set<object>();
  private readonly navHandlers = new Set<(on: boolean) => void>();

  /** Claim (or release) the navigation keys for `owner`. While any claim is
   *  live, the DOM listener prevents the browser's scroll defaults for the
   *  nav keys exactly as it does when a Declare control holds focus — an
   *  open menu's arrows rove the menu, never scroll the page. Idempotent.
   *  0↔1 transitions notify onNavClaim subscribers (the FocusRing stands
   *  down while an overlay owns the keys — the menu's rover is the focus). */
  navClaim(owner: object, on: boolean): void {
    const was = this.navClaims.size > 0;
    if (on) this.navClaims.add(owner);
    else this.navClaims.delete(owner);
    const is = this.navClaims.size > 0;
    if (was !== is) for (const fn of [...this.navHandlers]) fn(is);
  }

  /** Is any navigation-keys claim live right now? */
  navClaimed(): boolean {
    return this.navClaims.size > 0;
  }

  /** Was a claim live when the key now being dispatched arrived? Read once,
   *  before any handler runs: the handler that acts on the key (a menu's
   *  Enter picks and closes it) may release the claim mid-dispatch, and the
   *  rest of the same keypress must still see who owned it. */
  private claimedAtDispatch = false;

  /** Does an overlay own this key? While an overlay claims the navigation
   *  keys — an open menu — the arrows, Enter, Space, Escape and the jump keys
   *  are the overlay's: the focused view beneath does not also receive them
   *  (its Enter would re-press the button that opened the menu; its arrows
   *  would move a list's selection under an open context menu). */
  overlayOwns(e: KeyEvent): boolean {
    return this.claimedAtDispatch && OVERLAY_KEYS.has(e.key);
  }

  /** Subscribe to nav-claim TRANSITIONS (true = an overlay took the keys,
   *  false = the last claim released). Returns the unsubscribe thunk. */
  onNavClaim(fn: (on: boolean) => void): () => void {
    this.navHandlers.add(fn);
    return () => this.navHandlers.delete(fn);
  }
  /** Handlers → the node that owns them (a `Keys` member), or null for the
   *  runtime's own (focus delivery), which hear every key. */
  private readonly downHandlers = new Map<KeyHandler, object | null>();
  private readonly upHandlers = new Map<KeyHandler, object | null>();
  private readonly chords: Chord[] = [];

  /** Is this physical key (KeyboardEvent.code) down right now? The "key
   *  bitmap" query. Asked from a body (expr.ts names the caller), it answers
   *  for the caller's program: a key is down for a program only if it went
   *  down while that program had the keyboard (Rule 1) — and the asking view
   *  claims the key from the browser (Rule 2). */
  isDown(code: string): boolean {
    const h = this.heldKeys.get(code);
    const who = CALLER;
    if (who === null || PROGRAMS === null || MODIFIERS.has(code)) return h !== undefined && h.program !== ORPHAN;
    this.claim(who, code);
    return h !== undefined && (h.program === null || h.program === PROGRAMS.programOf(who));
  }

  /** Every currently-held code (a copy — callers may not mutate the set);
   *  from a body, the ones held in the caller's program. */
  held(): string[] {
    const who = CALLER;
    const p = who !== null && PROGRAMS !== null ? PROGRAMS.programOf(who) : undefined;
    const out: string[] = [];
    for (const [code, h] of this.heldKeys) {
      if (p === undefined || MODIFIERS.has(code) ? h.program !== ORPHAN : h.program === null || h.program === p) out.push(code);
    }
    return out;
  }

  /** Record that `node`'s view polls `code`. The claim lasts until the view
   *  is discarded. */
  private claim(node: object, code: string): void {
    const view = PROGRAMS!.viewOf(node);
    if (view === null) return;
    let set = this.claims.get(code);
    if (set === undefined) this.claims.set(code, (set = new Set()));
    if (set.has(view)) return;
    set.add(view);
    PROGRAMS!.onGone(view, () => { set!.delete(view); });
  }

  /** Does a shown view of the keyboard program poll `code`? */
  claimed(code: string): boolean {
    const set = this.claims.get(code);
    if (set === undefined || set.size === 0 || PROGRAMS === null) return false;
    const kp = PROGRAMS.keyboardProgram();
    for (const v of set) if (PROGRAMS.programOf(v) === kp && PROGRAMS.shown(v)) return true;
    return false;
  }

  /** Subscribe to key-down / key-up. `owner` — the node a `Keys` member is —
   *  hears only the keys of its own program while that program has the
   *  keyboard (Rule 1); without one, every key. Returns an unsubscribe thunk. */
  onKeyDown(fn: KeyHandler, owner: object | null = null): () => void {
    this.downHandlers.set(fn, owner);
    return () => this.downHandlers.delete(fn);
  }
  onKeyUp(fn: KeyHandler, owner: object | null = null): () => void {
    this.upHandlers.set(fn, owner);
    return () => this.upHandlers.delete(fn);
  }

  /** The handlers a key pressed in `program` reaches. */
  private reached(handlers: Map<KeyHandler, object | null>, program: object | null): KeyHandler[] {
    const out: KeyHandler[] = [];
    for (const [fn, owner] of handlers) {
      if (owner === null || program === null || PROGRAMS === null || PROGRAMS.programOf(owner) === program) out.push(fn);
    }
    return out;
  }

  /** The keyboard may have moved to another program (focus moved): the one
   *  that had it is told each key it holds went up, and those presses are no
   *  program's any more — the program now holding the keyboard sees only
   *  keys pressed from here on. */
  keyboardMoved(): void {
    if (PROGRAMS === null) return;
    const now = PROGRAMS.keyboardProgram();
    if (now === this.lastProgram) return;
    this.lastProgram = now;
    for (const [code, h] of this.heldKeys) {
      if (h.program === null || h.program === ORPHAN || h.program === now || MODIFIERS.has(code)) continue;
      const was = h.program;
      h.program = ORPHAN;
      const up = { ...h.e, repeat: false };
      for (const fn of this.reached(this.upHandlers, was)) if (this.upHandlers.get(fn) !== null) fn(up);
      for (const c of this.chords) if (c.active && c.codes.has(code)) c.active = false;
    }
  }

  /** Fire `fn` once when every code in `codes` is simultaneously held (LZX's
   *  callOnKeyCombo). Re-arms once any of the keys releases. Returns an
   *  unsubscribe thunk. (v1 matches physical codes; modifier-normalized
   *  chords — "ctrl"+"KeyS" — are a later refinement.) */
  onChord(codes: readonly string[], fn: () => void): () => void {
    const chord: Chord = { codes: new Set(codes), fn, active: false };
    this.chords.push(chord);
    return () => {
      const i = this.chords.indexOf(chord);
      if (i >= 0) this.chords.splice(i, 1);
    };
  }

  // ── Fed by the adapter (or a test) ────────────────────────────────────────

  /** A key went down: record it, fire the down stream, then complete any chord
   *  whose keys are now all held. */
  keyDown(e: KeyEvent): void {
    const now = PROGRAMS !== null ? PROGRAMS.keyboardProgram() : null;
    this.lastProgram = now;
    // an auto-repeat belongs where its press went, not where the keyboard is now
    const prev = this.heldKeys.get(e.code);
    const program = e.repeat && prev !== undefined ? prev.program : now;
    this.heldKeys.set(e.code, { e, program });
    this.claimedAtDispatch = this.navClaimed();
    for (const h of this.reached(this.downHandlers, program)) h(e);
    for (const c of this.chords) {
      if (!c.active && this.allHeld(c.codes)) {
        c.active = true;
        c.fn();
      }
    }
  }

  /** A key went up: drop it, fire the up stream, then re-arm any chord it broke. */
  keyUp(e: KeyEvent): void {
    const h0 = this.heldKeys.get(e.code);
    this.heldKeys.delete(e.code);
    this.claimedAtDispatch = this.navClaimed();
    // the release goes where the press went; a press the keyboard moved away
    // from was released to its program already, and reaches only the runtime
    const program = h0 !== undefined ? h0.program : PROGRAMS !== null ? PROGRAMS.keyboardProgram() : null;
    for (const h of this.reached(this.upHandlers, program)) h(e);
    for (const c of this.chords) {
      if (c.active && !this.allHeld(c.codes)) c.active = false;
    }
  }

  /** Release everything — on app blur, so a key held across a focus-out does
   *  not stick (a key-up may never arrive while the app is unfocused). */
  clearHeld(): void {
    this.heldKeys.clear();
    for (const c of this.chords) c.active = false;
  }

  private allHeld(codes: Set<string>): boolean {
    for (const code of codes) if (!this.heldKeys.has(code)) return false;
    return true;
  }

  /** Wire this service to a DOM host: keydown/keyup feed the core, blur clears
   *  the held set. Listeners live on `window` (a key released outside the tree
   *  must still update state) and self-retire once `alive` goes false — the
   *  same discipline as routeInput. Node-free core; only this method touches
   *  the DOM.
   *
   *  IDEMPOTENT PER TARGET. A browser calls this once per document, so
   *  stacking never showed there — but a LONG-LIVED host re-mounts app after
   *  app into one process, and wireInput calls this per mount. Un-guarded,
   *  each mount stacked another listener trio whose `alive` (the old app's)
   *  never went false, so every keydown fed the core once per mount ever
   *  made: N listeners × N delivery handlers = N² focus advances per Tab on
   *  the native host, with N² 's parity alternating per boot — measured
   *  2026-08-01 as nextCalls 9, 16, 25, 36 on four consecutive boots, and
   *  presenting for two days as a focus "coin toss". A repeat call now
   *  REPLACES the previous registration's liveness probe instead of adding
   *  listeners: the newest app owns the wire, exactly re-mount semantics. */
  listen(alive: () => boolean, target: Window = window): void {
    const bound = LISTENING.get(target as object);
    if (bound !== undefined) {
      bound.alive = alive;
      return;
    }
    const box = { alive };
    LISTENING.set(target as object, box);
    const isAlive = (): boolean => box.alive();
    const retire = (): void => {
      LISTENING.delete(target as object);
      target.removeEventListener("keydown", onDown);
      target.removeEventListener("keyup", onUp);
      target.removeEventListener("blur", onBlur);
    };
    const focusHolds = (): boolean => keysFocusProbe !== null && keysFocusProbe();
    const onDown = (ev: KeyboardEvent): void => {
      if (!isAlive()) return retire();
      // Declare owns Tab traversal (Layer 2); stop the browser from also moving its
      // own focus, which would fight the focus service (and skip a canvas app's
      // overlay inputs).
      if (ev.key === "Tab") ev.preventDefault();
      // When a Declare CONTROL holds keyboard focus, Space and the arrows are
      // the control's (Space/Enter activate; arrows adjust a slider) — the
      // browser's defaults (page scroll) must stand down. A native editable
      // (its own element focused) keeps every default: typing a space in a
      // field is a space.
      if (document.activeElement === document.body || document.activeElement === null) {
        const nav = ev.key === " " || ev.key === "ArrowUp" || ev.key === "ArrowDown" || ev.key === "ArrowLeft" || ev.key === "ArrowRight";
        const jump = ev.key === "Home" || ev.key === "End" || ev.key === "PageUp" || ev.key === "PageDown";
        if ((nav && (focusHolds() || this.navClaimed())) || (jump && this.navClaimed())) ev.preventDefault();
      }
      // A key a shown view of the keyboard program polls is the program's
      // (Rule 2): the browser's own use of it — scrolling, Firefox's quick
      // find, Safari showing a hidden cursor — stands down. A chord with a
      // command modifier stays the browser's, and so does typing in a field.
      if (ev.key !== "Tab" && !ev.metaKey && !ev.ctrlKey && !ev.altKey && !isField(document.activeElement) && this.claimed(ev.code)) ev.preventDefault();
      this.keyDown(normalize(ev));
    };
    const onUp = (ev: KeyboardEvent): void => {
      if (!isAlive()) return retire();
      this.keyUp(normalize(ev));
    };
    const onBlur = (): void => {
      if (!isAlive()) return retire();
      this.clearHeld();
    };
    target.addEventListener("keydown", onDown);
    target.addEventListener("keyup", onUp);
    target.addEventListener("blur", onBlur);
  }
}

/** Is the element a native text field — where a key is typing? */
function isField(el: Element | null): boolean {
  if (el === null || typeof HTMLElement === "undefined" || !(el instanceof HTMLElement)) return false;
  return el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
}

/** The keys an overlay holding a navigation claim owns outright. */
const OVERLAY_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", " ", "Escape", "Home", "End", "PageUp", "PageDown"]);

/** A DOM KeyboardEvent → the normalized KeyEvent the core consumes. */
export function normalize(ev: KeyboardEvent): KeyEvent {
  return {
    code: ev.code,
    key: ev.key,
    shift: ev.shiftKey,
    ctrl: ev.ctrlKey,
    alt: ev.altKey,
    meta: ev.metaKey,
    repeat: ev.repeat,
  };
}

/** The runtime's keyboard service (LZX's lz.Keys). */
/** Targets this service is already listening on → the liveness box a repeat
 *  `listen` swaps its probe into (see listen's idempotence note). Weak: a
 *  discarded shim window carries its registration away. */
const LISTENING = new WeakMap<object, { alive: () => boolean }>();

export const Keys = new KeysService();
