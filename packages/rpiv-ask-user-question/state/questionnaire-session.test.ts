import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, type Terminal, TUI, visibleWidth } from "@earendil-works/pi-tui";
import { makeTheme } from "@juicesharp/rpiv-test-utils";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { QuestionnaireResult, QuestionParams } from "../tool/types.js";
import type { WrappingSelectItem } from "../view/components/wrapping-select.js";
import { QuestionnaireSession } from "./questionnaire-session.js";

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ENTER = "<ENTER>";
const ESC = "\x1b";
const CTRL_G = "\x07";
const CTRL_U = "\x15";
const SHIFT_ENTER = "\x1b\r";
const TAB = "\t";

const params: QuestionParams = {
	questions: [
		{
			question: "Which?",
			header: "Pick",
			options: [
				{ label: "A", description: "a" },
				{ label: "B", description: "b" },
			],
		},
	],
};

function itemsFor(value: QuestionParams): WrappingSelectItem[][] {
	return value.questions.map((question) => [
		...question.options.map((option) => ({
			kind: "option" as const,
			label: option.label,
			description: option.description,
		})),
		{ kind: "other" as const, label: "Type something." },
	]);
}

const keybindings = {
	matches(data: string, name: string): boolean {
		switch (name) {
			case "tui.select.up":
				return data === UP;
			case "tui.select.down":
				return data === DOWN;
			case "tui.select.confirm":
				return data === ENTER;
			case "tui.input.newLine":
				return data === SHIFT_ENTER;
			case "tui.editor.cursorUp":
				return data === UP;
			case "tui.editor.cursorDown":
				return data === DOWN;
			case "tui.select.cancel":
				return data === ESC;
			case "tui.editor.deleteToLineStart":
				return data === CTRL_U;
			case "app.editor.external":
				return data === CTRL_G;
			default:
				return false;
		}
	},
};

interface SessionTestOptions {
	tui?: TUI;
	terminal?: { columns: number; rows: number };
	collapseKey?: string;
	params?: QuestionParams;
	itemsByTab?: WrappingSelectItem[][];
	editInput?: (value: string) => Promise<string | undefined>;
	keybindings?: typeof keybindings;
}

function makeSession(options: SessionTestOptions = {}) {
	const sessionParams = options.params ?? params;
	const done = vi.fn<(result: QuestionnaireResult) => void>();
	const session = new QuestionnaireSession({
		tui:
			options.tui ??
			({ terminal: options.terminal ?? { columns: 120, rows: 40 }, requestRender: vi.fn() } as unknown as TUI),
		theme: makeTheme() as unknown as Theme,
		params: sessionParams,
		itemsByTab: options.itemsByTab ?? itemsFor(sessionParams),
		done,
		keybindings: options.keybindings ?? keybindings,
		editInput: options.editInput ?? (async () => undefined),
		collapseKey: options.collapseKey ?? "off",
	});
	return { session, done };
}

function focusCustomAnswer(session: QuestionnaireSession): void {
	session.dispatch(DOWN);
	session.dispatch(DOWN);
}

describe("QuestionnaireSession — custom-answer drafts", () => {
	it("preserves a draft while browsing options and restores it on return", () => {
		const { session, done } = makeSession();
		focusCustomAnswer(session);
		session.dispatch("draft answer");
		session.dispatch(UP);
		const browsingView = session.component.render(120).join("\n");
		expect(browsingView).toContain("draft answer");
		expect(browsingView).not.toContain("Type something.");
		session.dispatch(DOWN);
		session.dispatch(ENTER);

		expect(done).toHaveBeenCalledWith({
			answers: [
				{
					questionIndex: 0,
					question: "Which?",
					kind: "custom",
					answer: "draft answer",
				},
			],
			cancelled: false,
		});
	});

	it("submits a multiline custom answer composed with Shift+Enter", () => {
		const { session, done } = makeSession();
		focusCustomAnswer(session);
		session.dispatch("first line");
		session.dispatch(SHIFT_ENTER);
		session.dispatch("second line");
		const view = session.component.render(120).join("\n");
		expect(view).toContain("first line");
		expect(view).toContain("second line");
		session.dispatch(ENTER);

		expect(done).toHaveBeenCalledWith({
			answers: [expect.objectContaining({ kind: "custom", answer: "first line\nsecond line" })],
			cancelled: false,
		});
	});

	it("uses vertical arrows within the draft and returns to row navigation at the boundary", () => {
		const { session, done } = makeSession();
		focusCustomAnswer(session);
		session.dispatch("first");
		session.dispatch(SHIFT_ENTER);
		session.dispatch("second");
		session.dispatch(UP);
		session.dispatch("!");
		session.dispatch(UP);
		session.dispatch(DOWN);
		session.dispatch(ENTER);

		expect(done).toHaveBeenCalledWith({
			answers: [expect.objectContaining({ kind: "custom", answer: "first!\nsecond" })],
			cancelled: false,
		});
	});

	it("clears the whole draft with Pi's Ctrl+U line-kill binding", () => {
		const { session, done } = makeSession();
		focusCustomAnswer(session);
		session.dispatch("discard me");
		session.dispatch(CTRL_U);
		session.dispatch(ENTER);

		expect(done).toHaveBeenCalledWith({
			answers: [expect.objectContaining({ kind: "custom", answer: null })],
			cancelled: false,
		});
	});

	it("replaces the inline draft with the external editor result", async () => {
		const editInput = vi.fn(async (value: string) => `${value} + edited`);
		const { session, done } = makeSession({ editInput });
		focusCustomAnswer(session);
		session.dispatch("draft");
		session.dispatch(CTRL_G);
		await Promise.resolve();
		await Promise.resolve();
		expect(editInput).toHaveBeenCalledWith("draft");
		session.dispatch(ENTER);

		expect(done).toHaveBeenLastCalledWith({
			answers: [expect.objectContaining({ kind: "custom", answer: "draft + edited" })],
			cancelled: false,
		});
	});

	it("keeps input exclusive while the external editor is open", async () => {
		let resolveEditor!: (value: string | undefined) => void;
		const editInput = vi.fn(
			() =>
				new Promise<string | undefined>((resolve) => {
					resolveEditor = resolve;
				}),
		);
		const { session, done } = makeSession({ editInput });
		focusCustomAnswer(session);
		session.dispatch("draft");
		session.dispatch(CTRL_G);

		session.dispatch(UP);
		session.dispatch("late input");
		resolveEditor("edited");
		await Promise.resolve();
		await Promise.resolve();
		session.dispatch(ENTER);

		expect(done).toHaveBeenCalledWith({
			answers: [expect.objectContaining({ kind: "custom", answer: "edited" })],
			cancelled: false,
		});
	});

	it("attaches multiline notes composed with Shift+Enter", () => {
		const { session, done } = makeSession();
		session.dispatch("n");
		session.dispatch("first note");
		session.dispatch(SHIFT_ENTER);
		session.dispatch("second note");
		session.dispatch(ENTER);
		session.dispatch(ENTER);

		expect(done).toHaveBeenCalledWith({
			answers: [expect.objectContaining({ kind: "option", notes: "first note\nsecond note" })],
			cancelled: false,
		});
	});

	it("commits the typed draft with a remapped tui.input.submit key (#156)", () => {
		// Slack-style config: enter is folded into tui.input.newLine (colliding with
		// the default tui.select.confirm), submit lives on its own key. The submit
		// key must confirm the custom answer instead of falling through to the
		// editor, whose own submit handling would wipe the draft.
		const CTRL_ENTER = "<CTRL_ENTER>";
		const remapped: typeof keybindings = {
			matches(data: string, name: string): boolean {
				if (name === "tui.input.submit") return data === CTRL_ENTER;
				if (name === "tui.input.newLine") return data === ENTER || data === SHIFT_ENTER;
				return keybindings.matches(data, name);
			},
		};
		const { session, done } = makeSession({ keybindings: remapped });
		focusCustomAnswer(session);
		session.dispatch("first line");
		session.dispatch(SHIFT_ENTER);
		session.dispatch("second line");
		session.dispatch(CTRL_ENTER);

		expect(done).toHaveBeenCalledWith({
			answers: [expect.objectContaining({ kind: "custom", answer: "first line\nsecond line" })],
			cancelled: false,
		});
	});

	it("a raw Enter byte the router does not match cannot wipe the draft via the editor's own submit (#156)", () => {
		// The session fake matches only the <ENTER> sentinel, so a raw "\r" reaches
		// the headless Editor, whose GLOBAL keybindings still bind tui.input.submit
		// to enter. Without disableSubmit, Editor.submitValue() would reset the
		// buffer and silently destroy the draft.
		const { session, done } = makeSession();
		focusCustomAnswer(session);
		session.dispatch("precious draft");
		session.dispatch("\r");
		expect(session.component.render(120).join("\n")).toContain("precious draft");
		session.dispatch(ENTER);

		expect(done).toHaveBeenCalledWith({
			answers: [expect.objectContaining({ kind: "custom", answer: "precious draft" })],
			cancelled: false,
		});
	});

	it("keeps each question's latest draft isolated through real navigation and tab switches", () => {
		const multiParams: QuestionParams = {
			questions: [
				{ ...params.questions[0]!, question: "First?", header: "First" },
				{ ...params.questions[0]!, question: "Second?", header: "Second" },
			],
		};
		const { session } = makeSession({ params: multiParams });

		focusCustomAnswer(session);
		session.dispatch("first");
		session.dispatch(UP);
		session.dispatch(DOWN);
		session.dispatch("-latest");
		session.dispatch(ENTER);

		focusCustomAnswer(session);
		session.dispatch("second");
		session.dispatch(UP);
		session.dispatch(TAB);
		session.dispatch(TAB);
		expect(session.component.render(120).join("\n")).toContain("first-latest");

		session.dispatch(TAB);
		expect(session.component.render(120).join("\n")).toContain("second");
	});
});

describe("QuestionnaireSession — collapse disabled", () => {
	it("does not shrink when collapseKey is off", () => {
		const { session } = makeSession();
		const before = session.component.render(120);
		session.dispatch("\x1d");
		expect(session.component.render(120)).toEqual(before);
	});
});

describe("QuestionnaireSession — natural-height pane and resize", () => {
	it("renders independently of terminal height while respecting narrow widths", () => {
		const terminal = { columns: 120, rows: 40 };
		const tallParams: QuestionParams = {
			questions: [
				{
					...params.questions[0]!,
					question: "A long question wrapped over many rows. ".repeat(10),
					options: params.questions[0]!.options.map((option) => ({
						...option,
						preview: Array(80).fill("preview content").join("\n"),
					})),
				},
			],
		};
		const { session, done } = makeSession({ params: tallParams, terminal });
		const initial = session.component.render(80);
		expect(initial.length).toBeGreaterThan(24);
		for (const rows of [40, 24, 12, 6, 2, 1, 40]) {
			terminal.rows = rows;
			terminal.columns = 80;
			expect(session.component.render(80)).toEqual(initial);
			for (const width of [120, 80, 20, 10, 2, 1, 0]) {
				terminal.columns = width;
				const lines = session.component.render(width);
				for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
		session.dispatch(ENTER);
		expect(done).toHaveBeenCalledWith(
			expect.objectContaining({
				cancelled: false,
				answers: [expect.objectContaining({ preview: tallParams.questions[0]!.options[0]!.preview })],
			}),
		);
	});

	it("keeps multiline input cursor and notes visible while resizing, preserving both drafts", () => {
		const terminal = { columns: 80, rows: 24 };
		const { session, done } = makeSession({ terminal, collapseKey: "ctrl+]" });
		session.component.focused = true;
		session.dispatch("n");
		for (let i = 0; i < 8; i++) {
			session.dispatch(`note${i}`);
			session.dispatch(SHIFT_ENTER);
		}
		for (const rows of [24, 12, 6, 40]) {
			terminal.rows = rows;
			expect(session.component.render(80).join("\n")).toContain(CURSOR_MARKER);
		}
		session.component.focused = false;
		expect(session.component.render(80).join("\n")).not.toContain(CURSOR_MARKER);
		session.component.focused = true;
		session.dispatch("\x1d");
		session.dispatch("unseen");
		session.dispatch("\x1d");
		session.dispatch(ENTER);
		focusCustomAnswer(session);
		for (let i = 0; i < 8; i++) {
			session.dispatch(`draft${i}`);
			session.dispatch(SHIFT_ENTER);
		}
		for (const rows of [24, 12, 6, 40]) {
			terminal.rows = rows;
			expect(session.component.render(80).join("\n")).toContain(CURSOR_MARKER);
		}
		session.dispatch(ENTER);
		expect(done).toHaveBeenCalledWith(
			expect.objectContaining({
				answers: [
					expect.objectContaining({
						answer: Array.from({ length: 8 }, (_, i) => `draft${i}\n`).join(""),
						notes: Array.from({ length: 8 }, (_, i) => `note${i}`).join("\n"),
					}),
				],
			}),
		);
	});

	it.each([1, 2, 4, 6, 12, 24])("keeps the Submit picker actionable at %i terminal rows", (rows) => {
		const { session, done } = makeSession({
			terminal: { columns: 40, rows },
			params: {
				questions: [params.questions[0]!, { ...params.questions[0]!, question: "Second?" }],
			},
		});
		session.dispatch(ENTER);
		session.dispatch(ENTER);
		expect(session.component.render(40).join("\n")).toContain("Submit answers");
		session.dispatch(DOWN);
		expect(session.component.render(40).join("\n")).toContain("Cancel");
		session.dispatch(ENTER);
		expect(done).toHaveBeenCalledWith(expect.objectContaining({ cancelled: true, answers: expect.any(Array) }));
	});
});

it("Pi TUI routes collapse to the focused overlay, then restores the pending pane", () => {
	let input!: (data: string) => void;
	const terminal: Terminal = {
		columns: 120,
		rows: 24,
		kittyProtocolActive: false,
		start: (onInput) => {
			input = onInput;
		},
		stop: vi.fn(),
		drainInput: async () => {},
		write: vi.fn(),
		moveBy: vi.fn(),
		hideCursor: vi.fn(),
		showCursor: vi.fn(),
		clearLine: vi.fn(),
		clearFromCursor: vi.fn(),
		clearScreen: vi.fn(),
		setTitle: vi.fn(),
		setProgress: vi.fn(),
	};
	const tui = new TUI(terminal);
	vi.spyOn(tui, "requestRender").mockImplementation(() => {});
	const { session, done } = makeSession({ tui, collapseKey: "ctrl+]" });
	tui.addChild(session.component);
	tui.setFocus(session.component);
	tui.start();
	try {
		input("n");
		input("note draft");
		const before = session.component.render(120);
		const otherInput = vi.fn();
		const overlay = tui.showOverlay({ render: () => ["other overlay"], invalidate() {}, handleInput: otherInput });
		expect(session.component.focused).toBe(false);
		input("\x1d");
		expect(otherInput).toHaveBeenCalledWith("\x1d");
		expect(session.component.render(120).length).toBeGreaterThan(1);
		overlay.hide();
		expect(session.component.focused).toBe(true);
		expect(session.component.render(120)).toEqual(before);
		input("\x1d");
		expect(session.component.render(120)).toHaveLength(1);
		input("\x1d");
		input(ENTER);
		input(ENTER);
		expect(done).toHaveBeenCalledWith(
			expect.objectContaining({ answers: [expect.objectContaining({ notes: "note draft" })] }),
		);
	} finally {
		tui.stop();
	}
});

function previewParams(preview: string): QuestionParams {
	return {
		questions: [
			{
				question: "Which layout should we use?",
				header: "Layout",
				options: [
					{ label: "Alpha", description: "First layout", preview },
					{ label: "Beta", description: "Second layout", preview: "BETA-PREVIEW" },
				],
			},
		],
	};
}

describe("QuestionnaireSession — natural questionnaire content", () => {
	beforeAll(() => initTheme());
	it("keeps the standard question, options and selected preview layout", () => {
		const { session, done } = makeSession({
			params: previewParams("ALPHA-PREVIEW"),
			terminal: { columns: 80, rows: 24 },
		});
		const initial = session.component.render(80);
		expect(initial[0]).toMatch(/─/);
		for (const text of ["Which layout should we use?", "Alpha", "Beta", "ALPHA-PREVIEW", "Type something."]) {
			expect(initial.join("\n")).toContain(text);
		}
		expect(initial.join("\n")).not.toContain("Alt+PgUp/PgDn");
		session.dispatch(DOWN);
		const second = session.component.render(80).join("\n");
		for (const text of ["Which layout should we use?", "Beta", "BETA-PREVIEW"]) expect(second).toContain(text);
		expect(second).not.toContain("ALPHA-PREVIEW");
		expect(done).not.toHaveBeenCalled();
	});

	it("renders every long question/option line in one pass without compacting or pane scrolling", () => {
		const value = previewParams("PREVIEW");
		value.questions[0]!.question = Array.from({ length: 40 }, (_, i) => `QUESTION-${i}-END`).join("\n");
		value.questions[0]!.options[0]!.description = Array.from({ length: 40 }, (_, i) => `DESCRIPTION-${i}-END`).join(
			"\n",
		);
		const { session, done } = makeSession({ params: value, terminal: { columns: 80, rows: 20 } });
		const lines = session.component.render(80);
		expect(lines.length).toBeGreaterThan(80);
		for (let i = 0; i < 40; i++) {
			expect(lines.join("\n")).toContain(`QUESTION-${i}-END`);
			expect(lines.join("\n")).toContain(`DESCRIPTION-${i}-END`);
		}
		for (const text of ["Alpha", "Beta", "Type something.", "Enter to select"])
			expect(lines.join("\n")).toContain(text);
		expect(done).not.toHaveBeenCalled();
		session.dispatch(ENTER);
		expect(done).toHaveBeenCalledWith(
			expect.objectContaining({ answers: [expect.objectContaining({ answer: "Alpha", preview: "PREVIEW" })] }),
		);
	});

	it("has no custom PageUp/PageDown or Alt+PageUp/PageDown handling", () => {
		const { session, done } = makeSession({
			params: previewParams("long preview\n".repeat(60)),
			terminal: { columns: 80, rows: 24 },
		});
		const before = session.component.render(80);
		for (const key of ["\x1b[5~", "\x1b[6~", "\x1b[5;3~", "\x1b[6;3~", "\x1b[6;3:3~"]) session.dispatch(key);
		expect(session.component.render(80)).toEqual(before);
		expect(done).not.toHaveBeenCalled();
	});

	it("retains the full incomplete-answer warning and Submit/Cancel on a short host", () => {
		const value = previewParams("PREVIEW");
		value.questions.push({ ...value.questions[0]!, header: "Second", question: "Second question?" });
		const { session, done } = makeSession({ params: value, terminal: { columns: 80, rows: 5 } });
		session.dispatch(TAB);
		session.dispatch(TAB);
		const lines = session.component.render(80);
		expect(lines.length).toBeGreaterThan(5);
		for (const text of ["Answer remaining questions", "Layout", "Second", "Submit answers", "Cancel"])
			expect(lines.join("\n")).toContain(text);
		session.dispatch(ENTER);
		expect(done).toHaveBeenCalledWith({ answers: [], cancelled: false });
	});
});
