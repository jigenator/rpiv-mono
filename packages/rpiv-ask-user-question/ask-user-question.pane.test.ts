import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionContext,
	type ExtensionUIContext,
	SessionManager,
	SettingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings, type TUI } from "@earendil-works/pi-tui";
import { makeTheme } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it, vi } from "vitest";
import { registerAskUserQuestionTool } from "./ask-user-question.js";

const params = {
	questions: [
		{
			question: "Which library should we use for date formatting?",
			header: "Library",
			options: [
				{ label: "date-fns", description: "Functional, tree-shakeable." },
				{ label: "Day.js", description: "Lightweight moment.js alternative." },
				{ label: "Temporal (polyfill)", description: "The upcoming TC39 standard." },
			],
		},
	],
};

describe("ask_user_question — SDK/native natural-height pane", () => {
	it.each(["tui", "print", undefined, "legacy"] as const)(
		"renders natural content for a %s host through SDK registration",
		async (mode) => {
			const cwd = mkdtempSync(join(tmpdir(), "rpiv-question-sdk-"));
			const settingsManager = SettingsManager.inMemory();
			const resourceLoader = new DefaultResourceLoader({
				cwd,
				agentDir: cwd,
				settingsManager,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				extensionFactories: [registerAskUserQuestionTool],
			});
			await resourceLoader.reload();
			const { session } = await createAgentSession({
				cwd,
				agentDir: cwd,
				resourceLoader,
				settingsManager,
				sessionManager: SessionManager.inMemory(cwd),
				authStorage: AuthStorage.inMemory(),
			});
			const terminal = { columns: 80, rows: 19 };
			let lines: string[] = [];
			let resized: string[] = [];
			const custom = vi.fn(async (factory) => {
				let result: unknown;
				const component = await factory(
					{ terminal, requestRender: vi.fn() } as unknown as TUI,
					makeTheme() as unknown as Theme,
					getKeybindings(),
					(value: unknown) => {
						result = value;
					},
				);
				lines = component.render(80);
				terminal.rows = 1;
				resized = component.render(80);
				component.handleInput("\r");
				return result;
			});
			try {
				await session.bindExtensions({
					uiContext: { ...session.extensionRunner.getUIContext(), custom } as ExtensionUIContext,
					...(mode && mode !== "legacy" ? { mode } : {}),
				});
				const context = session.extensionRunner.createContext();
				expect(context.hasUI).toBe(true);
				expect(context.mode).toBe(mode === "tui" ? "tui" : "print");
				const toolContext =
					mode === "legacy" ? ({ ...context, mode: undefined } as unknown as ExtensionContext) : context;
				const tool = session.extensionRunner.getToolDefinition("ask_user_question")!;
				const result = await tool.execute("test", params, undefined, undefined, toolContext);
				expect(custom).toHaveBeenCalledWith(expect.any(Function), { overlay: false });
				expect(result.details).toMatchObject({ cancelled: false, answers: [{ answer: "date-fns" }] });
				expect(lines.length).toBeGreaterThan(9);
				expect(resized).toEqual(lines);
				for (const label of ["date-fns", "Temporal (polyfill)", "Type something."])
					expect(lines.join("\n")).toContain(label);
			} finally {
				session.dispose();
				rmSync(cwd, { recursive: true, force: true });
			}
		},
	);
});
