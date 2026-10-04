# Keyboard and dialog layout

Every key the questionnaire dialog reacts to, the rows it appends for you, and how it
adapts to the size of your terminal.

## Keys

| Key | What it does | Where it applies |
| --- | --- | --- |
| `↑` / `↓` | Move between rows. Wraps at both ends. | Option list, Submit picker |
| `Enter` | Confirm the focused option, commit typed text, close notes, or activate the focused Submit-picker row. | Everywhere |
| `Shift+Enter` | Insert a newline. | `Type something.` input, notes editor |
| `Esc` | Cancel the whole questionnaire. | Everywhere except the notes editor, where it closes notes |
| `Tab` / `Shift+Tab` | Next / previous tab, wrapping. `→` / `←` do the same. | Multi-question dialogs only |
| `Space` | Toggle the focused checkbox. | Multi-select questions |
| `n` | Open the notes editor for the focused question — or, on the Submit tab, the global note for the whole questionnaire. | Every question tab; the Submit tab in multi-question dialogs |
| `Ctrl+G` | Open Pi's configured external editor with the current custom-answer draft. | `Type something.` input |
| `Ctrl+U` | Clear the current custom-answer draft. | `Type something.` input |
| `Ctrl+]` | Collapse or expand the dialog. Configurable via `collapseKey`. | Everywhere, including while collapsed |

The table names the default keys; the dialog actually follows your Pi keybindings.
Confirm listens to both `tui.select.confirm` and `tui.input.submit`, and a key bound to
`tui.input.newLine` always inserts a newline even if it also matches confirm. So a
Slack-style configuration — `enter` folded into `tui.input.newLine`, submit moved to
`ctrl+enter` — keeps working: `enter` breaks lines, and your submit key confirms
everywhere `Enter` does.

In a multi-select question, `Enter` on a regular row toggles its checkbox exactly like
`Space` — it does not submit. Committing the question means focusing the `Next` row and
pressing `Enter`. That is deliberate: it makes `Enter` a zero-cost way to flip boxes
without leaving the home row.

`Space` is suppressed on two rows: `Next` (it is a command, not a choice) and
`Type something.` (it is an inline text input, so the space character belongs to your
answer).

## The rows the dialog adds

| Row | Label | Appended to |
| --- | --- | --- |
| Custom answer | `Type something.` | Every question — single-select and multi-select, with or without previews |
| Commit | `Next` | Multi-select questions only |

Focusing `Type something.` switches the row into an inline multiline editor. In preview
mode it expands to the full pane width while you type, so a long custom answer is not
squeezed into the narrow options column. `Shift+Enter` inserts a line break; vertical
arrows move between lines and return to row navigation at the draft's top and bottom.
The draft replaces the static row label while you browse other options and is isolated
per question. `Ctrl+G` round-trips it through Pi's configured external editor; `Ctrl+U`
clears it, while `Esc` remains the explicit way to cancel the questionnaire. Confirming
it produces an answer of `kind: "custom"`.

Both labels are reserved — the model cannot author an option that collides with them.
Both localize with the rest of the UI chrome; the reserved-label check always compares
against the canonical English strings.

## Notes

`n` opens a notes editor on any question tab, whether the question is single- or
multi-select and whether or not its options carry previews. Notes are stored in a
side-band keyed by tab index, not inside the answer, so writing a note does not mark a
question as answered — the Submit tab still lists it as outstanding. The note merges into
the answer when you confirm it, and reaches the model as `user notes: <text>`.

On the Submit tab, `n` opens the global note editor instead — one note covering the whole
questionnaire. It lives outside every answer, so it survives tab switches and never marks
a question as answered; it reaches the model as `global note: <text>`, and submitting with
nothing but a global note still returns an answered result rather than a decline.

Inside the editor, `Shift+Enter` inserts a newline, while `Esc` and `Enter` close it; other
keystrokes edit the buffer, so `n` types an `n`. Pasted line breaks are preserved.

## Collapse mode

The questionnaire reserves space in Pi's editor area rather than covering the
conversation. Pi's transcript navigation remains available while you answer: in
fullscreen mode use PageUp/PageDown or the mouse wheel; in regular mode use your
terminal's scrollback. A tall questionnaire can fill the visible terminal; collapse frees space when needed.

`Ctrl+]` optionally shrinks the pane to one dim hint row. Press the same key to
restore it with answers, selections, notes, and custom-answer drafts intact. While
shrunk, other questionnaire keys are ignored except `Esc`, which cancels. The pane
keeps focus; it does not open the normal prompt editor. When another overlay has
focus, Pi routes keys to that overlay instead. No raw terminal listener is installed.

The default `ctrl+]` is free in Terminal.app, iTerm2, Warp, tmux, zellij and screen. On
keyboard layouts where `]` sits on the shifted layer — Latin American `es-AR` / `es-MX`,
among others — set a different `collapseKey`, or `"off"` to disable the shortcut.

## Layout

Options render in a vertical list. When any option in a single-select question carries a
`preview`, the dialog splits into a side-by-side layout with the option list on the left
and a bordered monospace preview box on the right — but only when both the terminal and
the dialog pane are at least 100 columns wide. Below that, the preview stacks underneath
the options instead.

The questionnaire renders at its natural height, including long questions and option
lists. It does not reserve a fixed fraction of the terminal, crop to terminal rows,
or replace the standard layout with a compact scrolling view. Preview boxes retain
their normal side-by-side/stacked layout and existing hidden-lines indicator.

Pi owns the viewport and transcript navigation; there are no questionnaire-specific
scroll keys. A tall questionnaire can exceed the visible terminal and leave little
or no transcript on screen. Use host/terminal scrollback where available or the
optional collapse shortcut to free space; the package does not provide a separate
pane viewport. Resizing reflows content by width without changing answers or drafts.

The footer hint line adapts to context — it drops the notes hint and appends the
`Shift+Enter` newline hint whenever a text editor has the keyboard, with `Ctrl+U` still at
the far right for custom answers. It adds the tab hint only in multi-question dialogs. The
Submit tab follows the same idiom: its bottom hint row sits below the picker and carries
an `n to add a note` part that gives way to the `Shift+Enter` newline hint while the
global-note editor is open; a committed note shows as a `Note` entry in the review list.
`Ctrl+G` remains Pi's global external-editor shortcut and is not repeated there. On narrow
terminals the right edge clips with `…` so the core hints survive.
