import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getKeybindings, type TUI } from "@earendil-works/pi-tui";
import { createMockPi, makeTheme } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it, vi } from "vitest";
import { registerAskUserQuestionTool } from "./ask-user-question.js";
import type { QuestionnaireSessionComponent } from "./state/questionnaire-session.js";

const params = {
	questions: [{ question: "Pick one", header: "Choice", options: [{ label: "Alpha" }, { label: "Beta" }] }],
};

async function drive(script: (component: QuestionnaireSessionComponent) => void, collapseKey?: string) {
	if (collapseKey) {
		const dir = join(process.env.HOME!, ".config", "rpiv-ask-user-question");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "config.json"), JSON.stringify({ collapseKey }));
	}
	const { pi, captured } = createMockPi();
	registerAskUserQuestionTool(pi);
	const onTerminalInput = vi.fn();
	const custom = vi.fn(
		(factory) =>
			new Promise((resolve) => {
				const component = factory(
					{ requestRender: vi.fn(), terminal: { columns: 120, rows: 40 } } as unknown as TUI,
					makeTheme(),
					getKeybindings(),
					resolve,
				) as QuestionnaireSessionComponent;
				script(component);
				component.handleInput("\x1b");
			}),
	);
	const result = await captured.tools.get("ask_user_question")!.execute!(
		"tc",
		params as never,
		undefined as never,
		undefined as never,
		{ hasUI: true, ui: { custom, onTerminalInput } } as never,
	);
	expect(custom).toHaveBeenCalledWith(expect.any(Function), { overlay: false });
	expect(onTerminalInput).not.toHaveBeenCalled();
	return result;
}

// The raw overlay escape listener is deliberately gone: Pi owns focus and scrolling.
describe("ask_user_question — non-overlay input lifecycle", () => {
	it("reserves the editor area without installing a global collapse listener", async () => {
		await drive((component) => {
			const expanded = component.render(120);
			component.handleInput("\x1d");
			expect(component.render(120)).toHaveLength(1);
			expect(component.render(120)[0]).toContain("Ctrl+] to expand");
			component.handleInput("\x1d");
			expect(component.render(120)).toEqual(expanded);
		});
	});

	it("toggles only on Kitty press, never repeat/release", async () => {
		await drive((component) => {
			component.handleInput("\x1b[93;5u");
			component.handleInput("\x1b[93;5:2u");
			component.handleInput("\x1b[93;5:3u");
			expect(component.render(120)).toHaveLength(1);
			component.handleInput("\x1b[93;5u");
			expect(component.render(120).length).toBeGreaterThan(1);
		});
	});

	it("preserves the inline draft and does not accept hidden edits while shrunk", async () => {
		const result = await drive((component) => {
			component.handleInput("\x1b[A"); // wrap to custom answer
			component.handleInput("\x1b[200~draft\nsecond line\x1b[201~");
			component.handleInput("\x1d");
			component.handleInput("unseen edit");
			component.handleInput("\x1b[93;5:2u");
			component.handleInput("\x1d");
			component.handleInput("\r");
		});
		expect(result.details).toMatchObject({ answers: [{ answer: "draft\nsecond line" }], cancelled: false });
	});

	it("honours a configured collapseKey in the component and its hint", async () => {
		await drive((component) => {
			expect(component.render(160).join("\n")).toContain("Alt+O to collapse");
			component.handleInput("\x1d");
			expect(component.render(160).length).toBeGreaterThan(1);
			component.handleInput("\x1bo");
			expect(component.render(160)[0]).toContain("Alt+O to expand");
		}, "alt+o");
	});

	it("off disables collapse without any raw listener", async () => {
		await drive((component) => {
			const before = component.render(160);
			component.handleInput("\x1d");
			expect(component.render(160)).toEqual(before);
			expect(before.join("\n")).not.toContain("to collapse");
		}, "off");
	});
});
