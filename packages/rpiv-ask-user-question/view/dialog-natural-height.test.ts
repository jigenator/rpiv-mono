import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type Editor, visibleWidth } from "@earendil-works/pi-tui";
import { makeTheme } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it } from "vitest";
import {
	makeQuestionnaireState,
	makeSubmitPickerPropsFromState as submitPickerPropsFromState,
} from "../test-fixtures.js";
import type { QuestionAnswer, QuestionData } from "../tool/types.js";
import type { MultiSelectView } from "./components/multi-select-view.js";
import type { OptionListView } from "./components/option-list-view.js";
import type { PreviewPane } from "./components/preview/preview-pane.js";
import { SUBMIT_LABEL, SubmitPicker } from "./components/submit-picker.js";
import type { TabBar } from "./components/tab-bar.js";
import {
	type DialogConfig,
	type DialogProps,
	type DialogState,
	DialogView,
	HINT_PART_ENTER,
	HINT_PART_NEW_LINE,
	READY_PROMPT,
} from "./dialog-builder.js";
import type { TabComponents } from "./tab-components.js";

const theme = makeTheme() as unknown as Theme;

const stripAnsi = (l: string) => l.replace(/\x1b\[[0-9;]*m/g, "").trim();

function stubComponent(lines: string[]): Component {
	return { render: () => lines, handleInput() {}, invalidate() {} };
}

function stubPreviewPane(lines: string[]): PreviewPane {
	return stubComponent(lines) as unknown as PreviewPane;
}

function stubMultiSelect(lines: string[]): MultiSelectView {
	return {
		...stubComponent(lines),
		naturalHeight: (_w: number) => lines.length,
	} as unknown as MultiSelectView;
}

function stubOptionList(): OptionListView {
	return stubComponent(["<OPTION_LIST>"]) as unknown as OptionListView;
}

interface DialogParts {
	config: DialogConfig;
	initialProps: DialogProps;
}

type MakeConfigOverrides = Partial<Omit<DialogConfig, "tabsByIndex">> & {
	state?: DialogState;
	previewPane?: PreviewPane;
	initialProps?: DialogProps;
	tabsByIndex?: ReadonlyArray<TabComponents>;
	multiSelectByTab?: ReadonlyArray<MultiSelectView | undefined>;
};

function makeConfig(over: MakeConfigOverrides = {}): DialogParts {
	const questions: QuestionData[] = over.questions
		? [...over.questions]
		: [
				{
					question: "Q1?",
					header: "H1",
					options: [
						{ label: "A", description: "a" },
						{ label: "B", description: "b" },
					],
				},
				{
					question: "Q2?",
					header: "H2",
					options: [
						{ label: "X", description: "x" },
						{ label: "Y", description: "y" },
					],
				},
			];
	const state: DialogState = over.state ?? {
		currentTab: 0,
		optionIndex: 0,
		notesVisible: false,
		inputMode: false,
		answers: new Map(),
		multiSelectChecked: new Set(),
		customDraftsByTab: new Map(),
		notesByTab: new Map(),
		submitChoiceIndex: 0,
		notesDraft: "",
		collapsed: false,
	};
	const previewPane = over.previewPane ?? stubPreviewPane(["<PREVIEW>"]);
	const tabsByIndex: ReadonlyArray<TabComponents> =
		over.tabsByIndex ??
		questions.map((_, i) => ({
			optionList: stubOptionList(),
			preview: previewPane,
			multiSelect: over.multiSelectByTab?.[i],
			bodyHeights: () => ({ current: 0, max: 0 }),
		}));
	const config: DialogConfig = {
		theme: over.theme ?? theme,
		questions,
		tabBar: over.tabBar ?? (stubComponent(["<TABBAR>", ""]) as unknown as TabBar),
		notesInput: over.notesInput ?? (stubComponent(["<NOTES_INPUT>"]) as unknown as Editor),
		isMulti: over.isMulti ?? questions.length > 1,
		tabsByIndex,
		submitPicker: over.submitPicker,
		getBodyHeight: over.getBodyHeight ?? (() => 1),
		getCurrentBodyHeight: over.getCurrentBodyHeight ?? (() => 1),
		collapseKey: over.collapseKey ?? "ctrl+]",
	};
	const initialProps: DialogProps = over.initialProps ?? { state, activePreviewPane: previewPane };
	return { config, initialProps };
}

function makeDialog(parts: DialogParts): DialogView {
	return new DialogView(parts.config, parts.initialProps);
}

describe("Dialog natural height — residual padding", () => {
	it("returns full output including residual spacer", () => {
		const dlg = makeDialog(makeConfig({ getBodyHeight: () => 6, getCurrentBodyHeight: () => 1 }));
		const lines = dlg.render(80);
		// Residual spacer rows follow the full dialog.
		const hintIdx = lines.findIndex((l) => l.includes(HINT_PART_ENTER));
		expect(hintIdx).toBeGreaterThan(0);
		const tail = lines.slice(hintIdx + 1);
		// Residual spacer = (6 + 5) - (1 + 2) = 8 rows  (footerRowCount dropped 4→2)
		expect(tail.length).toBe(8);
		expect(tail.every((l) => l.trim() === "")).toBe(true);
	});

	it("retains trailing cross-tab padding", () => {
		const dlg = makeDialog(makeConfig({ getBodyHeight: () => 5, getCurrentBodyHeight: () => 1 }));
		const lines = dlg.render(80);
		// Residual spacer = (5 + 5) - (1 + 2) = 7 rows of trailing blanks  (footerRowCount 4→2)
		const emptyTail = lines.filter((l) => l.trim() === "").length;
		expect(emptyTail).toBeGreaterThanOrEqual(7);
	});
});

describe("Dialog natural height — notes open on a multi-select tab (NFR-2)", () => {
	const multiQ: QuestionData = {
		question: "Areas",
		header: "Areas",
		multiSelect: true,
		options: [
			{ label: "FE", description: "f" },
			{ label: "BE", description: "b" },
		],
	};

	it("flipping notesVisible false→true grows render length by exactly 3; trailing residual-spacer tail unchanged", () => {
		const ms = stubMultiSelect(["<MULTI>"]);
		const common = {
			questions: [multiQ],
			isMulti: false,
			multiSelectByTab: [ms],
			getBodyHeight: () => 8,
			getCurrentBodyHeight: () => 4,
		};
		const closed = makeDialog(makeConfig({ ...common, state: makeQuestionnaireState({ notesVisible: false }) }));
		const open = makeDialog(makeConfig({ ...common, state: makeQuestionnaireState({ notesVisible: true }) }));
		const closedLines = closed.render(80);
		const openLines = open.render(80);
		// midRows = Notes header + notesInput + Spacer = 3 rows; everything else is invariant.
		expect(openLines.length - closedLines.length).toBe(3);
		// NFR-2: growing midRows never desyncs the spacerRows residual math — the trailing
		// residual-spacer tail is identical with notes closed vs open.
		const trailingBlanks = (lines: string[]) => {
			let n = 0;
			for (let i = lines.length - 1; i >= 0 && lines[i].trim() === ""; i--) n++;
			return n;
		};
		expect(trailingBlanks(openLines)).toBe(trailingBlanks(closedLines));
	});

	it("renders all multi-select rows and the notes editor without dropping chrome", () => {
		const ms = stubMultiSelect(Array.from({ length: 40 }, (_, i) => `MULTI-${i}-END`));
		const dlg = makeDialog(
			makeConfig({
				questions: [multiQ],
				isMulti: false,
				state: makeQuestionnaireState({ notesVisible: true }),
				multiSelectByTab: [ms],
				getBodyHeight: () => 40,
				getCurrentBodyHeight: () => 40,
			}),
		);
		const lines = dlg.render(80);
		expect(lines.length).toBeGreaterThan(40);
		for (let i = 0; i < 40; i++) expect(lines.join("\n")).toContain(`MULTI-${i}-END`);
		expect(lines[0]).toMatch(/─/);
		expect(lines.join("\n")).toContain("<NOTES_INPUT>");
		expect(lines.join("\n")).toContain(HINT_PART_ENTER);
	});
});

describe("Dialog natural height — notes open on the Submit tab (NFR-2)", () => {
	const answers = new Map<number, QuestionAnswer>([
		[0, { questionIndex: 0, question: "Q1?", kind: "option", answer: "A" }],
		[1, { questionIndex: 1, question: "Q2?", kind: "option", answer: "X" }],
	]);

	function submitState(over: Partial<DialogState> = {}): DialogState {
		return {
			currentTab: 2,
			optionIndex: 0,
			notesVisible: false,
			inputMode: false,
			answers,
			multiSelectChecked: new Set(),
			customDraftsByTab: new Map(),
			notesByTab: new Map(),
			submitChoiceIndex: 0,
			notesDraft: "",
			collapsed: false,
			...over,
		};
	}

	function makeSubmitDialog(state: DialogState, over: MakeConfigOverrides = {}): DialogView {
		const picker = new SubmitPicker(theme);
		picker.setProps(submitPickerPropsFromState(state, true));
		return makeDialog(
			makeConfig({
				state,
				submitPicker: picker,
				getBodyHeight: () => 8,
				...over,
			}),
		);
	}

	it("flipping notesVisible false→true grows the render by exactly 3; tail identical; hint blanks while open", () => {
		const closedLines = makeSubmitDialog(submitState()).render(80);
		const openLines = makeSubmitDialog(submitState({ notesVisible: true })).render(80);
		// midRows = Global-note header + notesInput (stubbed to 1 row) + Spacer = 3 rows.
		expect(openLines.length - closedLines.length).toBe(3);
		expect(openLines.join("\n")).toContain("Global note:");
		expect(openLines.join("\n")).toContain("<NOTES_INPUT>");
		expect(closedLines.join("\n")).not.toContain("<NOTES_INPUT>");
		// The bottom hint row is always present: the note part shows while closed and
		// gives way to the Shift+Enter newline hint while the editor is open.
		expect(closedLines.join("\n")).toContain("n to add a note");
		expect(openLines.join("\n")).not.toContain("n to add a note");
		expect(openLines.join("\n")).toContain(HINT_PART_NEW_LINE);
		// NFR-2: growing midRows never desyncs the residual-spacer math — the trailing
		// blank tail is identical with the editor closed vs open (footer stays 5 rows).
		const trailingBlanks = (lines: string[]) => {
			let n = 0;
			for (let i = lines.length - 1; i >= 0 && lines[i].trim() === ""; i--) n++;
			return n;
		};
		expect(trailingBlanks(openLines)).toBe(trailingBlanks(closedLines));
	});

	it("notes and picker remain in the full layout while open", () => {
		const dlg = makeSubmitDialog(submitState({ notesVisible: true }), {
			getBodyHeight: () => 20,
		});
		const lines = dlg.render(80);
		expect(lines.join("\n")).toContain("<NOTES_INPUT>");
		expect(lines.join("\n")).toContain(SUBMIT_LABEL);
	});

	it("width-clip: render length is width-invariant in the one-line regime; hint clips to one row, never wraps", () => {
		// READY_PROMPT (30 visible cols) is the widest footer string, so the length sweep
		// starts where every footer row is single-line. A wrapping hint would inflate the
		// submit footer past footerRowCount=5 and desync the cross-tab height equalizer.
		const widths = [40, 60, 80, 120];
		const lengths = new Set(widths.map((w) => makeSubmitDialog(submitState()).render(w).length));
		expect(lengths.size).toBe(1);
		// Ultra-narrow: exactly one hint row survives, clipped (never wrapped to two).
		// The bottom hint opens with HINT_PART_ENTER, so its prefix is the row's signature.
		const narrow = makeSubmitDialog(submitState()).render(10);
		const hintRows = narrow.filter((l) => stripAnsi(l).startsWith("Enter"));
		expect(hintRows.length).toBe(1);
		expect(visibleWidth(hintRows[0]!)).toBeLessThanOrEqual(10);
	});

	it("hint sits BELOW the picker; the prompt reads straight into its options", () => {
		// The #182 review moved the note affordance out of the prompt→picker gap: the
		// footer order is prompt, picker rows, then the bottom key-hint row (the same
		// bottom-row idiom as question tabs).
		const lines = makeSubmitDialog(submitState()).render(80).map(stripAnsi);
		const promptRow = lines.findIndex((l) => l.includes(READY_PROMPT));
		const submitRow = lines.findIndex((l) => l.includes(SUBMIT_LABEL));
		const hintRow = lines.findIndex((l) => l.includes("n to add a note"));
		expect(promptRow).toBeGreaterThanOrEqual(0);
		expect(submitRow).toBe(promptRow + 1);
		expect(hintRow).toBeGreaterThan(submitRow);
	});

	it("a committed global note renders as a review entry while closed and hides while the editor is open", () => {
		// The committed note lives at the questions.length pseudo-index (2 questions here).
		const noted = () => new Map([[2, "Ship behind a feature flag"]]);
		const closed = makeSubmitDialog(submitState({ notesByTab: noted() }))
			.render(80)
			.join("\n");
		expect(closed).toContain("● Note");
		expect(closed).toContain("Ship behind a feature flag");
		// While the editor is open it is the live surface (seeded with this text) — the
		// review entry hides so the note never appears twice.
		const open = makeSubmitDialog(submitState({ notesByTab: noted(), notesVisible: true }))
			.render(80)
			.join("\n");
		expect(open).not.toContain("● Note");
	});
});
