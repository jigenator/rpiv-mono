import advisor from "../../../rpiv-advisor/package.json" with { type: "json" };
import args from "../../../rpiv-args/package.json" with { type: "json" };
import askUserQuestion from "../../../rpiv-ask-user-question/package.json" with { type: "json" };
import btw from "../../../rpiv-btw/package.json" with { type: "json" };
import todo from "../../../rpiv-todo/package.json" with { type: "json" };
import webTools from "../../../rpiv-web-tools/package.json" with { type: "json" };

export interface Sibling {
	pkg: string; // e.g. @juicesharp/rpiv-advisor
	name: string; // e.g. rpiv-advisor — package directory + SiblingInfographic switch key
	description: string; // verbatim from package.json
	homepage: string; // GitHub tree URL from package.json
	npmUrl: string; // https://www.npmjs.com/package/...
	version: string; // lockstep semver from package.json
	role: string; // hand-curated short role label (≤ 18 chars)
	peers: string[]; // external runtime peers, scope-stripped (pi-ai / pi-coding-agent / pi-tui); internal rpiv-* peers dropped
	installCmd: string; // `pi install npm:@juicesharp/rpiv-...`
}

export const SIBLING_NAMES = [
	"rpiv-advisor",
	"rpiv-args",
	"rpiv-ask-user-question",
	"rpiv-btw",
	"rpiv-todo",
	"rpiv-web-tools",
] as const;

export type SiblingName = (typeof SIBLING_NAMES)[number];

/** Hand-curated short role labels (≤ 18 chars) summarizing each sibling at a glance. */
const ROLES: Record<SiblingName, string> = {
	"rpiv-advisor": "advisor model",
	"rpiv-args": "prompt args",
	"rpiv-ask-user-question": "question prompt",
	"rpiv-btw": "side question",
	"rpiv-todo": "live overlay",
	"rpiv-web-tools": "web search",
};

interface PkgJson {
	name: string;
	version: string;
	description: string;
	homepage: string;
	peerDependencies?: Record<string, string>;
}

// Static imports survive relocation into Astro's prerender chunks.
const PACKAGES: Record<SiblingName, PkgJson> = {
	"rpiv-advisor": advisor,
	"rpiv-args": args,
	"rpiv-ask-user-question": askUserQuestion,
	"rpiv-btw": btw,
	"rpiv-todo": todo,
	"rpiv-web-tools": webTools,
};

/** Strip scopes from peer-dep names; drop internal sibling co-deps so the
 * catalog peer signature reads as "external runtime weight" only. */
function shortPeers(peers: Record<string, string> | undefined): string[] {
	if (!peers) return [];
	return Object.keys(peers)
		.map((p) => p.replace(/^@earendil-works\//, "").replace(/^@juicesharp\//, ""))
		.filter((p) => !p.startsWith("rpiv-"));
}

export function loadSiblings(): Sibling[] {
	return SIBLING_NAMES.map((name) => {
		const json = PACKAGES[name];
		return {
			pkg: json.name,
			name,
			description: json.description,
			homepage: json.homepage,
			npmUrl: `https://www.npmjs.com/package/${json.name}`,
			version: json.version,
			role: ROLES[name],
			peers: shortPeers(json.peerDependencies),
			installCmd: `pi install npm:${json.name}`,
		};
	});
}
