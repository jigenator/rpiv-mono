import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadCompat } from "./compat.js";
import { loadSiblings, SIBLING_NAMES } from "./siblings.js";
import { VERSION } from "./version.js";

const readJson = (relative: string) => JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8"));

describe("site manifest data", () => {
	it("reports the workspace version and tested Pi pin", () => {
		const root = readJson("../../../../package.json");
		const rpiv = readJson("../../../rpiv-pi/package.json");
		expect(loadCompat()).toEqual({
			rpivPiVersion: rpiv.version,
			piCodingAgentFloor: root.devDependencies["@earendil-works/pi-coding-agent"],
		});
		expect(VERSION).toBe(rpiv.version);
	});

	it("keeps all six sibling cards in sync with their manifests", () => {
		const siblings = loadSiblings();
		expect(siblings.map(({ name }) => name)).toEqual(SIBLING_NAMES);
		for (const sibling of siblings) {
			const pkg = readJson(`../../../${sibling.name}/package.json`);
			expect(sibling).toMatchObject({
				pkg: pkg.name,
				version: pkg.version,
				description: pkg.description,
				homepage: pkg.homepage,
				npmUrl: `https://www.npmjs.com/package/${pkg.name}`,
				installCmd: `pi install npm:${pkg.name}`,
			});
			expect(sibling.peers).toEqual(
				Object.keys(pkg.peerDependencies ?? {})
					.map((peer) => peer.replace(/^@earendil-works\//, "").replace(/^@juicesharp\//, ""))
					.filter((peer) => !peer.startsWith("rpiv-")),
			);
		}
	});
});
