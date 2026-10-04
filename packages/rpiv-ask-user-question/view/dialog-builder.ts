import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, type Editor, Spacer, truncateToWidth } from "@earendil-works/pi-tui";
import { DEFAULT_COLLAPSE_KEY, formatKeySpecForDisplay } from "../config.js";
import type { QuestionnaireState } from "../state/state.js";
import type { QuestionData } from "../tool/types.js";
import type { PreviewPaneProps } from "./components/preview/preview-pane.js";
import type { TabBar } from "./components/tab-bar.js";
import type { StatefulView } from "./stateful-view.js";
import type { TabComponents } from "./tab-components.js";
import { QuestionTabStrategy, SubmitTabStrategy, type TabContentStrategy } from "./tab-content-strategy.js";

export const HINT_PART_ENTER = "Enter to select";
export const HINT_PART_NAV = "↑/↓ to navigate";
export const HINT_PART_NEW_LINE = "Shift+Enter for newline";
export const HINT_PART_CLEAR = "Ctrl+U to clear";
export const HINT_PART_TOGGLE = "Space to toggle";
export const HINT_PART_NOTES = "n to add notes";
export const HINT_PART_TAB = "Tab to switch questions";
export const HINT_PART_CANCEL = "Esc to cancel";
/**
 * Collapse/expand hint copy is templated on `KEY_PLACEHOLDER` because the
 * shortcut is configurable (`collapseKey`) and `rpiv-i18n`'s `tr` has no
 * interpolation — locale entries carry the same `{key}` placeholder and call
 * sites `.replace()` it with `formatKeySpecForDisplay(collapseKey)` after
 * lookup, so per-locale word order is preserved.
 */
export const KEY_PLACEHOLDER = "{key}";
export const HINT_PART_COLLAPSE_TEMPLATE = `${KEY_PLACEHOLDER} to collapse`;
export const HINT_PART_EXPAND_TEMPLATE = `${KEY_PLACEHOLDER} to expand`;
/** Default-key (`Ctrl+]`) rendering of the collapse template, for tests and default-config assertions. */
export const HINT_PART_COLLAPSE = HINT_PART_COLLAPSE_TEMPLATE.replace(
	KEY_PLACEHOLDER,
	formatKeySpecForDisplay(DEFAULT_COLLAPSE_KEY),
);
/**
 * `HINT_SINGLE` / `HINT_MULTI` are the resting core hint for NON-multiSelect
 * question tabs only: `buildHintText` drops `NOTES` while the notes editor is
 * open (`state.notesVisible`) or the "Type something." row is capturing text
 * (`state.inputMode`), and on multiSelect tabs it interleaves `TOGGLE` between
 * `NAV` and `NOTES`, so neither composite is a substring there — assert on
 * `HINT_PART_*` constants in those states instead. The collapse affordance is
 * appended AFTER cancel by `buildHintText` so the resting core stays a contiguous
 * prefix substring of the rendered line. On narrow terminals the collapse tail
 * clips with `…` (`OneLineClippedText`); the core is preserved.
 */
export const HINT_SINGLE = [HINT_PART_ENTER, HINT_PART_NAV, HINT_PART_NOTES, HINT_PART_CANCEL].join(" · ");
export const HINT_MULTI = [HINT_PART_ENTER, HINT_PART_NAV, HINT_PART_NOTES, HINT_PART_TAB, HINT_PART_CANCEL].join(
	" · ",
);
/**
 * Template for the single-line footer shown by `QuestionnaireSession` when
 * `state.collapsed === true`. Bypasses `buildHintText`; the session replaces
 * `KEY_PLACEHOLDER` with the configured key's display form.
 */
export const COLLAPSED_HINT_TEMPLATE = [HINT_PART_EXPAND_TEMPLATE, HINT_PART_CANCEL].join(" · ");
export const REVIEW_HEADING = "Review your answers";
export const READY_PROMPT = "Ready to submit your answers?";
export const INCOMPLETE_WARNING_PREFIX = "⚠ Answer remaining questions before submitting:";

export type DialogState = QuestionnaireState;

/** Per-tick projection of dialog state. Written by the adapter; read by the strategy thunk. */
export interface DialogProps {
	state: DialogState;
	activePreviewPane: StatefulView<PreviewPaneProps>;
}

/** Construction-time config for `DialogView`. Frozen after construction. */
export interface DialogConfig {
	theme: Theme;
	questions: readonly QuestionData[];
	tabBar: TabBar | undefined;
	notesInput: Editor;
	isMulti: boolean;
	tabsByIndex: ReadonlyArray<TabComponents>;
	/** Optional so single-question mode and non-submit tests can omit it; SubmitTabStrategy falls back to Spacer rows. */
	submitPicker?: Component;
	/** Worst-case body height across all tabs/options. Determines the stable overall dialog footprint. */
	getBodyHeight: (width: number) => number;
	/** Body height of the CURRENTLY active tab/option. The chrome subtracts this from `getBodyHeight` to absorb the residual OUTSIDE the bordered region. */
	getCurrentBodyHeight: (width: number) => number;
	/**
	 * Resolved collapse/expand key spec (`resolveCollapseKey` output: `"ctrl+]"`,
	 * `"alt+o"`, or `"off"`). Construction-time config, NOT canonical state —
	 * `QuestionnaireRuntime.collapseKey` must never reach view setProps consumers.
	 * The footer hint interpolates it, and drops the collapse part when `"off"`.
	 */
	collapseKey: string;
}

/**
 * The 7th renderable, promoted from a structural literal to a named class so
 * all view-layer components share one explicit `implements StatefulView<P>`
 * contract. `setProps(DialogProps)` writes the live cell read by the
 * strategy thunk during `render()`. `liveProps.activePreviewPane` is a
 * resolved pane reference threaded by the adapter per tick — the dialog
 * itself does not derive it.
 */
export class DialogView implements StatefulView<DialogProps> {
	private liveProps: DialogProps;
	private readonly config: DialogConfig;
	private readonly questionStrategy: TabContentStrategy;
	private readonly submitStrategy: TabContentStrategy | undefined;
	private readonly maxFooterRowCount: number;

	constructor(config: DialogConfig, initialProps: DialogProps) {
		this.config = config;
		this.liveProps = initialProps;
		this.questionStrategy = new QuestionTabStrategy({
			theme: config.theme,
			questions: config.questions,
			getPreviewPane: () => this.liveProps.activePreviewPane,
			tabsByIndex: config.tabsByIndex,
			notesInput: config.notesInput,
			isMulti: config.isMulti,
			getCurrentBodyHeight: config.getCurrentBodyHeight,
			collapseKey: config.collapseKey,
		});
		this.submitStrategy = config.isMulti
			? new SubmitTabStrategy({
					theme: config.theme,
					questions: config.questions,
					submitPicker: config.submitPicker,
					notesInput: config.notesInput,
				})
			: undefined;
		this.maxFooterRowCount = Math.max(this.questionStrategy.footerRowCount, this.submitStrategy?.footerRowCount ?? 0);
	}

	setProps(props: DialogProps): void {
		this.liveProps = props;
	}

	handleInput(_data: string): void {}

	// Invalidation is driven by `QuestionnairePropsAdapter.invalidate()`, which
	// owns the full set of renderables (binding registries + extras like
	// `notesInput`). DialogView has no cached layout of its own.
	invalidate(): void {}

	render(width: number): string[] {
		if (width <= 0) return [""];
		const state = this.liveProps.state;
		const onSubmit = this.config.isMulti && state.currentTab === this.config.questions.length;
		const strategy = onSubmit && this.submitStrategy ? this.submitStrategy : this.questionStrategy;
		const natural = this.buildContainerFromStrategy(strategy, strategy.headingRows(state)).render(width);
		const spacerRows = Math.max(
			0,
			this.config.getBodyHeight(width) +
				this.maxFooterRowCount -
				strategy.bodyHeight(width, state) -
				strategy.footerRowCount,
		);
		// The host owns the viewport; preserve the full questionnaire and cross-tab padding.
		return [...natural, ...Array<string>(spacerRows).fill("")].map((line) => truncateToWidth(line, width, ""));
	}

	private buildContainerFromStrategy(strategy: TabContentStrategy, headingRowCache: Component[]): Container {
		const { theme, isMulti, tabBar } = this.config;
		const state = this.liveProps.state;
		const container = new Container();
		const border = () => new DynamicBorder((s) => theme.fg("accent", s));

		container.addChild(border());
		if (isMulti && tabBar) container.addChild(tabBar);
		container.addChild(new Spacer(1));

		for (const c of headingRowCache) container.addChild(c);
		container.addChild(strategy.bodyComponent(state));
		container.addChild(new Spacer(1));
		for (const c of strategy.midRows(state)) container.addChild(c);

		container.addChild(border());
		for (const c of strategy.footerRows(state)) container.addChild(c);

		// BodyResidualSpacer moved out of Container — handled in render().
		return container;
	}
}
