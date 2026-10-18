# Slot ownership: one rule for who drives an attribute, and who takes it back

*Design note, 2026-10-17. Status: proposed, not built. Written after Cadence 14's two layout
bugs: a `State`'s `height = 100%` never reached the page, and a phone layout entered by
narrowing a desktop window could not scroll. The patches that fixed them
(uncommitted) are listed under "What this replaces"; this note is the change that should
stand instead of them.*

## The problem

Every attribute slot has at most one **driver** at a time: the thing whose value lands in it.
Several kinds of thing can drive a slot, and they come and go at run time.

Today five mechanisms each decide, by themselves, who drives a slot and what happens when
they let go:

| mechanism | where | takes a slot by | gives it back by |
|---|---|---|---|
| author value or `{ }` binding | `attributes.ts` `own()` | `own()`, displacing a *yielding* owner (disposed) | — (it stays) |
| layout claim | `layout.ts` `$claim` / `$unclaim` | `own()`; captures the slot's value as a "base" on first claim | `release()`, then writes the captured base, during a rearm only |
| `State` override | `state.ts` `pushOverride` / `popOverride` | suspends the owner and releases its kernel cell; a per-slot stack | resumes the suspended owner, or writes a snapshot of the value |
| animator | `tween.ts` ledger | suspends the owner, one deep | resumes it |
| auto-extent (a size following its content) | `view.ts` `$bindExtent` | installs only if the slot is unset *and* unowned at the moment it is checked | — (a yielding owner: disposed by any newcomer) |

Each keeps its own idea of "what was there before". The defects come from that:

- **Snapshots stand in for drivers.** The layout's base and the state's `baseValue` record a
  *number*. Written back, the number pins a slot that was following its content.
- **No successor.** Auto-extent installs only when nobody owns the slot at the moment it is
  checked. A state applied at boot takes the slot first, so auto-extent never installs, and
  nothing installs it after the state lets go.
- **Neighbours are not told.** A parent's auto-extent skips a child whose size a percent or a
  flex drives. It decides which children to skip when it installs, and nothing tells it
  when a child stops being percent- or flex-driven.
- **A bad value leaves the table silently.** A claim that ran one last time wrote
  `undefined` into a numeric slot. The write path treats any non-number as a union-typed
  value, so the slot left the kernel's table for good, and the parent's kernel auto-extent
  could no longer see it. Nothing reported it.
- **A State's values skip the binders.** A literal override was stored as written, so `100%`
  was stored as the object `{ percent: 100 }`, where a declared one goes through
  `bindPercent`. The same applied to `x = center` and `flexes`.

## The proposal: one ownership stack per slot

Every slot has an ordered set of **claimants**, highest precedence on top. The top claimant
drives the slot. The others wait, unbuilt where they can be (as `State` does today).

### Claimants and precedence (lowest to highest)

1. **The floor.** What drives the slot when nobody else does:
   - the author's value, if the slot is author-set;
   - else a declared default rule, if the class has one;
   - else, for a `width` or `height` of a view with View children, **auto-extent**;
   - else the attribute's default value.

   The floor is not stored as a snapshot. It is **re-derived** from those facts each time the
   stack empties, so it can never be stale.
2. **The author's `{ }` binding** (or a percent, align or data binding declared on the view).
3. **`State` overrides,** in declaration order (later wins). This is today's state stack.
4. **The layout's claim** (a placed position, a flexed size).
5. **Animators.** They compose rather than replace each other (animation.md §4), so to the
   stack they are one claimant: the ledger's entry.

These ranks are already the language's precedence:
- **layout over author binding:** a binding on a slot a layout places is refused, with a
  diagnostic naming both (`layoutConflictMessage`);
- **state over binding:** states.md §3;
- **animator over everything:** animation.md §2.

The table writes down what each mechanism enforces separately today.

### One push, one pop

Two functions in one module (`slot-owner.ts`) do every hand-over:

- **`claim(view, slot, rank, make)`**: insert at `rank`. If it becomes the top, suspend the
  previous top (keep it, unrun) and build and run the new one.
- **`yieldSlot(view, slot, rank)`**: remove. If it was the top, the next one down takes over,
  resumed and re-evaluated. If the stack is empty, **re-derive the floor and install it**.

Every mechanism calls these and nothing else:
- `own()` remains, as `claim` at rank 2;
- `$claim` and `$unclaim` become `claim` and `yieldSlot` at rank 4;
- `pushOverride` and `popOverride` become rank 3;
- the tween ledger becomes rank 5.

The layout's `bases`, the state's `baseOwner` and `baseValue`, and the tween's `displaced`
all go: the stack holds what they each held.

### Two invariants, enforced in that module

1. **A change of driver *kind* tells the parent.** When a size slot's top changes between
   *extent-excluded* (a percent, an align or a flex) and *included* (anything else),
   `yieldSlot` and `claim` re-list the parent's auto-extent once, at the settle's close, where
   it already re-lists today. This is the only place it happens.
2. **A numeric slot accepts numbers.** A driver landing `undefined`, or any non-number, in a
   slot whose declared type is numeric is a reported error naming the driver. It does not
   silently move the slot out of the table. Union-typed slots (`cornerRadius`) keep escaping
   as designed: the check is by declared type, not by the value. Re-entry to the table, for a
   slot that escaped legitimately and later holds a number again, is out of scope here.

### What a State's value becomes

A `State` override is built by **the same binders a declared value uses**: `bindPercent`,
`bindAlign`, a `{ }`, or a literal. The binders return the constraint unowned, so the stack can
own it. `flexes`, an ordinary boolean, already works this way once invariant 1 holds.

## Performance: what must not regress

This is the hottest code in the runtime: every bound slot passes through `own()` at boot, and
every layout rearm claims and releases slots. The design holds the following, and each is a
gate before merging:

- **Pay per use.** A slot with one driver, nearly every slot, carries no stack. Its owner
  stays where it is today, in `$owners[slot]`, with no allocation and no extra indirection on
  read or write. A stack is created only when a second claimant arrives (a state, a layout
  over a binding, an animator), exactly as the State side-table is today.
- **Boot path unchanged.** `own()` at instantiation stays a single store plus the kernel
  cell claim. Floor derivation does not run at boot, only when a stack empties, which is
  rare: a state switching off, a rearm, an animation ending.
- **No new per-settle work.** The parent re-list rides the existing once-per-settle
  `afterSettle` re-list in `$applyChildrenMutated`, and only for a kind change.
- **Kernel untouched.** Cell ownership, rule flags and `extent_run` stay as they are. The
  numeric check is in the JS `write` path's existing branch for non-numbers, which is already
  off the fast path (a number takes the branch above it).

**Gates,** before and after, on the same machine:
1. Boot stages from `window.__declarePerf` for the calendar, tracker, desktop and sampler
   (median of 10).
2. Settle times from `declare-verify` R4 on the same apps.
3. Frame cadence for the calendar's pan, the tracker's 10,000-row scroll and a desktop window
   drag (`tools/internal/benchmarks`).
4. A new micro-benchmark: 10,000 claim/yield cycles on one slot (state on/off, flex on/off)
   and 100,000 `own()` calls.
5. The production size band (`test/declarec.test.mjs`). The module should be a net
   *reduction*, since it replaces four copies of the hand-over.

Any regression beyond run-to-run noise blocks the change.

## Tests: the acceptance cases

Already written against the patches, and kept unchanged as the acceptance cases:
- a State's `height = 100%`, `flexes` and `x = center` resolve as declared ones do;
- released, a content-sized view follows its content again;
- a container's auto-extent sees a child that stops flexing, repeatedly in both directions.

Added for the design:
- a state and an animator on the same slot, released in either order;
- a layout rearm under an active state;
- a numeric slot given `undefined` reports, and stays in the table;
- an author-set size is never replaced by auto-extent;
- the Cadence pattern end to end: boot wide, narrow, widen.

## What this replaces

The uncommitted patches of 2026-10-17, which fix Cadence's bugs as special cases:

| file | patch | becomes |
|---|---|---|
| `state.ts` | on release, re-arm auto-extent for a size; dispose a displaced auto-extent instead of resuming it | the floor, re-derived by `yieldSlot` |
| `layout.ts` | `$unclaim` calls `$sizeReleased`; the flex-size claim skips `undefined` | `yieldSlot`; invariant 2 |
| `view.ts` | `$sizeReleased`; the re-list accepts any auto-extent owner | invariant 1 |
| `bind.ts` / `instantiate.ts` | `percentRule` and `alignRule`, used by a state's literals | kept: the binders that return unowned constraints |

The Safari opacity-layer fix in `dom-backend.ts` is unrelated and stands on its own.

## Open questions

- **The tween ledger's "one deep" displacement.** It becomes rank 5. Does an animator running
  under an active state, which then switches off, re-target to the new driver's value
  (animation.md §2 rule 4 says resumed, not reinstated stale)? The stack makes this
  well-defined; the language's answer needs stating.
- **A layout claim under an author binding** is refused today, with a diagnostic. Should it
  keep being refused, or be ranked as above? Keep refusing; the rank only orders what is
  legal.
- **The floor for a class's declared default rule**, which today is disposed for good when
  displaced (`displaceDeclDefault`). Re-deriving it on yield is the change. Check the cost on
  the sampler, whose classes declare many defaults.
