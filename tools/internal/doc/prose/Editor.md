The abstract base every editing control extends — `TextInput` is the one the library ships. It owns the
**edit session**: a draft the user is typing, the committed value it will become,
and the validity derived from both — so a control gets `commitOn` / `error` /
`valid` / `dirty` and the `commit()` / `revert()` verbs without restating them.
Not instantiable: write the concrete control.

**`validate(v)` is a method you declare** on the field — `Editor` does not ship one. The
session calls it with the draft on every edit and before every commit. Return `""` when the
draft is good, and otherwise the message to show. The message becomes `error`, `valid` follows it, and a draft that fails never
reaches the dataset. Keep it pure: it judges the value it is given.

```declare-fragment
TextInput [ text <-> :email, commitOn = "blur",
    validate(v: string) -> string { return v.includes("@") ? "" : "That is not an address" } ]
```

## commitOn
For a `text <-> :path` field, **when** a valid draft commits into the dataset: `"input"`
(live, on every edit — the default), `"blur"` (on losing focus), `"enter"` (on Return), or
`"manual"` (never automatically — only when you call `commit()`). Point the datapath at the
real record for autosave, or at a working copy you commit on a Save button for a transaction.

## error
**Read-only.** The current validation message for the draft, or `""` when valid — the edit
session recomputes it on every edit, so what you own is `validate()`, not this attribute. Show
it with a label that reads it (`text = { app.field.error }`).

## valid
**Read-only.** Whether the draft passes `validate()` — recomputed by the session per edit,
like `error`. A form-wide "can save" is just a constraint over several fields' `valid` (no
form object needed).

## dirty
**Read-only.** Whether the draft differs from the committed dataset value — the session
maintains it; `commit()` and `revert()` are what clear it. For enabling a Save affordance
or an unsaved-changes prompt.

## judgeOn
**When** `error` first says what is wrong with the draft: `"edit"` (on every edit — the
default) or `"leave"` — not until the field has been left once, or `judge()` asked. A field
marked wrong while the person is still typing in it for the first time is a common annoyance;
`"leave"` waits for them to finish. `valid` is true to the draft either way, so a form's
"can this be sent?" never waits. Once judged, the field follows each edit.

## judge()
Say what is wrong with the draft now, without waiting for the field to be left — for a Save
or a Send that checks every field: `onClick() { form.title.judge(); form.body.judge() }`.
Only matters with `judgeOn = "leave"`.

## validate()
Declare it on the field to judge its draft: return `""` (or `true`) when it is fine, and
otherwise the sentence that says what is wrong — it becomes `error`, and `valid` is false.
`validate(v: string) -> string { return v.includes("@") ? "" : "That is not an address" }`.
A draft that fails it never reaches the dataset. When the message first shows is `judgeOn`'s.

## commit()
Commit the current draft into the bound dataset field, if it validates — for a
`commitOn = "manual"` field or a Save button (`onClick() { field.commit() }`). A no-op on a
field that is not `<->`-bound.

## revert()
Discard edits — reset the field to the committed dataset value.

