import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyShipManifest } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it } from "vitest";

describe("publish manifest", () => {
	it("`package.json` `files` array covers every production .ts module across the tree", () => {
		expect(verifyShipManifest(import.meta.url).missing).toEqual([]);
	});
});

describe("fork root Pi package", () => {
	const root = new URL("../../", import.meta.url);

	it("exposes only the questionnaire, with no other resource types", () => {
		const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
		expect(manifest.pi).toEqual({
			extensions: ["./packages/rpiv-ask-user-question/index.ts"],
			skills: [],
			prompts: [],
			themes: [],
		});
		expect(manifest.scripts.prepare).toBe("node scripts/prepare.mjs");
	});

	it("skips Husky only in production and preserves developer setup failures", () => {
		const cwd = mkdtempSync(join(tmpdir(), "rpiv-prepare-"));
		try {
			copyFileSync(new URL("scripts/prepare.mjs", root), join(cwd, "prepare.mjs"));
			const run = (nodeEnv: string) =>
				spawnSync(process.execPath, ["prepare.mjs"], {
					cwd,
					env: { ...process.env, NODE_ENV: nodeEnv },
					encoding: "utf8",
				});
			expect(run("production").status).toBe(0);
			expect(run("development").status).not.toBe(0);
			const huskyDir = join(cwd, "node_modules/husky");
			mkdirSync(huskyDir, { recursive: true });
			writeFileSync(join(huskyDir, "package.json"), JSON.stringify({ type: "module", exports: "./index.js" }));
			writeFileSync(join(huskyDir, "index.js"), 'export default () => "hooks installed";');
			expect(run("development").stdout).toBe("hooks installed");
			expect(run("").stdout).toBe("hooks installed");
			expect(run("production").stdout).toBe("");
			writeFileSync(join(huskyDir, "index.js"), 'export default () => { throw new Error("setup failed"); };');
			expect(run("development").status).not.toBe(0);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
