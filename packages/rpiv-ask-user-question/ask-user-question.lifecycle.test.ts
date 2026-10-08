import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAskUserQuestionTool } from "./ask-user-question.js";
import type { QuestionnaireResult } from "./tool/types.js";

const params = {
	questions: [{ question: "Private question", header: "Pick", options: [{ label: "A" }, { label: "B" }] }],
};
const cancelled = { answers: [], cancelled: true };

afterEach(() => {
	vi.restoreAllMocks();
});

function setup(custom: ExtensionUIContext["custom"], mode = "tui") {
	const mock = createMockPi();
	registerAskUserQuestionTool(mock.pi);
	const tool = mock.captured.tools.get("ask_user_question")!;
	const ctx = createMockCtx({ hasUI: true, mode, ui: { custom } });
	const run = (signal?: AbortSignal) => tool.execute("tc", params, signal, undefined, ctx);
	const lifecycle = async (name: string) => {
		for (const handler of mock.captured.events.get(name) ?? []) await handler({}, ctx);
	};
	const edges = (channel = "rpiv:ask-user:blocked") => mock.captured.eventsEmitted.get(channel) ?? [];
	return { ...mock, ctx, tool, run, lifecycle, edges };
}

/** Exercises the real questionnaire component through the host's done contract. */
function customHost() {
	let component: { handleInput?: (data: string) => void } | undefined;
	const done = vi.fn();
	const custom: ExtensionUIContext["custom"] = (factory) =>
		new Promise((resolve, reject) => {
			const finish = (value: unknown) => {
				done(value);
				resolve(value as never);
			};
			Promise.resolve(
				factory(
					{ requestRender: vi.fn(), terminal: { columns: 120, rows: 24 } } as never,
					{ fg: (_: string, s: string) => s, bg: (_: string, s: string) => s, bold: (s: string) => s } as never,
					getKeybindings() as never,
					finish,
				),
			).then((c) => {
				component = c;
			}, reject);
		});
	return { custom, done, ready: () => !!component, key: (key: string) => component?.handleInput?.(key) };
}

function deferredCustom() {
	let resolve!: (result: QuestionnaireResult) => void;
	const custom = vi.fn(
		() =>
			new Promise<QuestionnaireResult>((r) => {
				resolve = r;
			}),
	) as unknown as ExtensionUIContext["custom"];
	return { custom, finish: (result = cancelled) => resolve(result), resolver: () => resolve };
}

describe("questionnaire wait lifecycle", () => {
	it.each(["answer", "escape", "abort"])("real component %s closes exactly one wait", async (action) => {
		const host = customHost();
		const test = setup(host.custom);
		const controller = new AbortController();
		const remove = vi.spyOn(controller.signal, "removeEventListener");
		const result = test.run(controller.signal);
		await vi.waitFor(() => expect(host.ready()).toBe(true));
		expect(test.edges()).toEqual([{ active: true }]);
		if (action === "abort") controller.abort();
		else host.key(action === "answer" ? "\r" : "\x1b");
		const response = await result;
		expect(response.details).toMatchObject({ cancelled: action !== "answer" });
		expect(host.done).toHaveBeenCalledOnce();
		expect(test.edges()).toEqual([{ active: true }, { active: false }]);
		expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
		await test.lifecycle("session_shutdown");
		expect(test.pi.exec).not.toHaveBeenCalled();
		expect([...test.captured.eventsEmitted.keys()].sort()).toEqual(["rpiv:ask-user:blocked", "rpiv:ask-user:prompt"]);
	});

	it("UI rejection releases the public blocked signal", async () => {
		const test = setup(
			vi.fn(async () => {
				throw new Error("UI failed");
			}),
		);
		await expect(test.run()).rejects.toThrow("UI failed");
		expect(test.edges()).toEqual([{ active: true }, { active: false }]);
		await test.lifecycle("session_shutdown");
	});

	it("pre-abort, no UI and invalid params never open a wait or UI", async () => {
		const custom = vi.fn();
		const test = setup(custom);
		const controller = new AbortController();
		controller.abort();
		await test.run(controller.signal);
		await test.tool.execute("tc", params, undefined, undefined, createMockCtx({ hasUI: false, mode: "tui" }));
		await test.tool.execute("tc", { questions: [] }, undefined, undefined, test.ctx);
		expect(custom).not.toHaveBeenCalled();
		expect(test.edges()).toEqual([]);
		expect(test.pi.exec).not.toHaveBeenCalled();
	});

	it.each(["session_shutdown", "session_start"])(
		"%s cancels owned waits; late completion cannot touch a new wait",
		async (event) => {
			const host = deferredCustom();
			const test = setup(host.custom);
			const first = test.run();
			await vi.waitFor(() => expect(host.custom).toHaveBeenCalledOnce());
			const finishOld = host.resolver();
			// Keep the old resolver before the second invocation replaces it.
			const oldPromise = vi.mocked(host.custom).mock.results[0].value;
			await test.lifecycle(event);
			expect((await first).details).toMatchObject({ cancelled: true });
			const second = test.run();
			await vi.waitFor(() => expect(host.custom).toHaveBeenCalledTimes(2));
			finishOld(cancelled);
			await oldPromise;
			expect(test.edges()).toEqual([{ active: true }, { active: false }, { active: true }]);
			await test.lifecycle("session_shutdown");
			await second;
			expect(test.edges()).toEqual([{ active: true }, { active: false }, { active: true }, { active: false }]);
		},
	);

	it("shutdown uses the real custom UI done callback, not just an event reset", async () => {
		const host = customHost();
		const test = setup(host.custom);
		const pending = test.run();
		await vi.waitFor(() => expect(host.ready()).toBe(true));
		await test.lifecycle("session_shutdown");
		await pending;
		expect(host.done).toHaveBeenCalledOnce();
		host.key("\r"); // late component callback is inert
		expect(host.done).toHaveBeenCalledOnce();
	});

	it("a delayed SDK factory after abort closes without constructing or reviving a questionnaire", async () => {
		let factory!: Parameters<ExtensionUIContext["custom"]>[0];
		const custom = vi.fn((value) => {
			factory = value;
			return new Promise(() => {});
		});
		const test = setup(custom as ExtensionUIContext["custom"]);
		const controller = new AbortController();
		const result = test.run(controller.signal);
		await vi.waitFor(() => expect(custom).toHaveBeenCalledOnce());
		controller.abort();
		await result;
		const done = vi.fn();
		const component = await factory(undefined as never, undefined as never, undefined as never, done);
		expect(component.render(80)).toEqual([]);
		expect(done).toHaveBeenCalledExactlyOnceWith(cancelled);
		expect(test.edges()).toEqual([{ active: true }, { active: false }]);
		await test.lifecycle("session_shutdown");
	});

	it("legacy deferred RPC fallback keeps the public bracket until the last dialog resolves", async () => {
		const test = setup(vi.fn(async () => undefined) as never, "legacy");
		let finish!: (answer: string) => void;
		const select = vi.fn(
			() =>
				new Promise<string>((resolve) => {
					finish = resolve;
				}),
		);
		test.ctx.ui.select = select;
		const pending = test.run();
		await vi.waitFor(() => expect(select).toHaveBeenCalledOnce());
		expect(test.edges("rpiv:ask-user:blocked")).toEqual([{ active: true }]);
		finish("1. A");
		await pending;
		expect(test.edges()).toEqual([{ active: true }, { active: false }]);
	});
});
