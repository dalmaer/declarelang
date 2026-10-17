# The conventions record: how a program behaves, provided like `theme`

*Design note, 2026-10-16. Status: proposed, not built. The region key is F6, fixed, until
this lands (overlay-language-changes.md #21); Esc then Tab leaves a region on every host
meanwhile (#25), so no browser leaves a keyboard user trapped.*

## The problem

A `theme` says how the interface **looks**. Every library control reads its look from it
and has no per-theme logic (overlay-language-changes.md #20). But an interface also has
**conventions**: which key does what, whether an arrow selects, which button comes first in
a dialog, how long a tooltip waits. Today those live in three places:

- **In the theme, as if they were looks.** `dialogButtonLayout` (Mac order or Windows
  order), `tooltipDelay`, `tooltipPlacement`, and half of `sliderHandleStyle` (how the
  handle behaves under the pointer, not only how it is drawn).
- **Fixed in the runtime.**
  - the region key, F6 (`focus.ts`);
  - the command modifier, ⌘ on a Mac and Ctrl elsewhere (`keys.ts` `IS_MAC`);
  - press-and-hold, 500 ms (`input.ts` `HOLD_MS`);
  - the command-held panel's wait, 700 ms (`keys.ts`).
- **Fixed in library classes.**
  - Whether a group control's arrows select: `RadioGroup` yes, `Segmented` no.
  - Whether they wrap: both do.
  - Which outside press a menu passes on.
  - Whether a menu bar opens on hover once one menu is open.

The region key showed why this matters. F6 is the Windows and GTK key for moving between
panes, but some browsers take F6 for the address bar. Which key works depends on **where
the program runs**, not on how it looks. A program styled Cupertino in Chrome on Windows
needs Windows keys and Cupertino paint.

## Precedent

- **Swing's LookAndFeel** bundled UI defaults with key bindings (each component's focus
  input map). Switching to the Windows LookAndFeel changed keys as well as colours, which is
  convenient until a designer wants one without the other.
- **Qt** separates them. `QStyle` paints, and style *hints* (`SH_…`: does a combo box pop up
  as a menu, does a menu open on hover) are queried separately. `QKeySequence::StandardKey`
  resolves platform key bindings apart from the style.
- **GTK** had a *key theme* (`gtk-key-theme-name`, e.g. Emacs) as a setting beside the
  visual theme.
- **Localization bundles** are the familiar case of the same shape: a record of values the
  host chooses by default and the program can override.

The lesson from Swing and Qt: **look and conventions vary independently and have different
owners.** The designer owns the look. The host owns most conventions, because it knows the
OS and the browser. The designer owns a few conventions too.

## Proposal

A second provided record, **`conventions`**, built exactly as `theme` is:

- **Presets:** `MacConventions`, `WindowsConventions`, `LinuxConventions`, and browser
  variants of each where the browser takes keys the native host leaves free.
- **The host provides the default** for where the program runs. A program overrides fields
  by spreading, as with a theme:
  `conventions = { { ...provided("conventions"), arrowSelects: true } }`.
- **The library reads fields and has no platform logic**, the same uniformity rule as
  themes: no `if (mac)` in a control.
- **Page-wide fields are the top program's.** A field that is the runtime's rather than a
  control's, such as `regionKey`, is read from the top-level program's record. A hosted
  program doesn't change the keys of the page it runs in.

### Fields, first cut

| field | today | Mac | Windows |
|---|---|---|---|
| `regionKey` | F6, fixed | F6 (native); to be measured in browsers | F6 (native); to be measured in browsers |
| `commandModifier` | `IS_MAC` in keys.ts | Meta | Control |
| `arrowSelects` (group controls: segmented, tabs) | per class | false | true |
| `arrowsWrap` | true | true | true |
| `dialogButtonLayout` | theme token | trailing default | leading default |
| `menuBarHoverOpens` | fixed | once one is open | once one is open |
| `outsidePressThroughMenu` | `dismiss` | false | false (Windows lets some presses through) |
| `tooltipDelay` | theme token | ~1000 ms | ~1000 ms |
| `holdDelay` | 500 ms fixed | 500 | 500 |
| `commandHeldDelay` | 700 ms fixed | 700 | 700 |

`RadioGroup` selecting on the arrow is a property of radio buttons everywhere (web, Windows,
GTK, ARIA), not a convention that varies, so it stays a class fact. `arrowSelects` covers
the controls where platforms differ.

### What moves out of `theme`

`dialogButtonLayout` and `tooltipDelay` move to `conventions`. `tooltipPlacement` and
`sliderHandleStyle` stay: they choose a rendition, which is look. For one release a theme
that states a moved token is still read, with a checker hint naming the new home.

### The third record

Strings ("Cancel", "OK", "Search"), text direction, and number and date formats are a
**`locale`** record, by the same pattern with a different owner (the reader's language,
not the platform). It is out of scope here, but the mechanism is shared, so `locale` should
be built the same way when it comes.

## Open questions

- **The browser region key.** Measure what reaches the page in Chrome, Firefox and Safari on
  macOS, Windows and Linux (`~/Desktop/region-key-test.html`), then set each preset's
  `regionKey`.
- **Tab with a modifier as a "super-Tab".** No combination is free everywhere in a browser:
  - Ctrl-Tab switches browser tabs everywhere.
  - Alt-Tab and Ctrl-Alt-Tab are the OS's on Windows and Linux.
  - ⌘-Tab is the Mac's app switcher.
  - Option-Tab on a Mac is the one candidate, but in Safari Option-Tab is the browser's own
    "Tab to every link".

  In the native Mac host, Ctrl-Tab is free and is already the Mac's key for moving focus
  out of a view that takes Tab, so `MacConventions` (native) could add Ctrl-Tab as a second
  region key.
- **Where the host's choice comes from.** It could be detected (user agent, native host) or
  stated by the page that embeds the program. Detection is the default, and a stated value
  wins.
- **Granularity.** The record could be one record or a few (keys, timing, layout order).
  Start with one. Themes have done well as one record.

## Not changing

Programs that never mention `conventions` behave as today: each preset's values are today's
fixed values on that platform.
