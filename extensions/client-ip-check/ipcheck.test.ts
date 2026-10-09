/**
 * Tests for the client IP scan core and the extension wiring (guard, gate, round budget).
 * Run: `node --experimental-strip-types --test ipcheck.test.ts`
 *
 * The scan tests drive the real jscpd and JPlag named in ~/.omp/client-ip/config.json
 * and are skipped when it does not name existing binaries.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, afterEach } from "node:test";

import extension from "./index.ts";

import {
	agentView,
	auditBucket,
	type Config,
	findRepo,
	guardHit,
	loadConfig,
	mergeFindings,
	type Pair,
	parseJplag,
	parseJscpd,
	type Repo,
	scan,
	writeAudit,
} from "./ipcheck.ts";

const TREE = "/tmp/client-ip-x";

test("parseJscpd keeps work-to-reference pairs only and maps tree paths back", () => {
	const at = (name: string, start = 1, end = 10) => ({ name: `${TREE}/${name}`, start, end });
	const pairs = parseJscpd(
		{
			duplicates: [
				{ firstFile: at("0-ref/r1/svc/a.go"), secondFile: at("1-work/w-internal/x/b.go", 3, 12), kind: "renamed", tokens: 80 },
				{ firstFile: at("0-own/o0/README.md:markdown"), secondFile: at("1-work/w-/README.md:markdown"), kind: "exact", tokens: 60 },
				{ firstFile: at("1-work/w-a/x.go"), secondFile: at("1-work/w-b/y.go"), kind: "exact", tokens: 60 },
				{ firstFile: at("0-ref/r0/x.go"), secondFile: at("0-ref/r1/y.go"), kind: "exact", tokens: 60 },
				{ firstFile: { name: "/elsewhere/x.go", start: 1, end: 9 }, secondFile: at("1-work/w-a/x.go"), kind: "exact", tokens: 60 },
			],
		},
		TREE,
	);
	assert.deepEqual(pairs, [
		{
			work: { file: "internal/x/b.go", start: 3, end: 12 },
			ref: { corpus: "restricted", index: 1, file: "svc/a.go", start: 1, end: 10 },
			kind: "renamed",
			tokens: 80,
			scanner: "jscpd",
		},
		{
			work: { file: "README.md", start: 1, end: 10 },
			ref: { corpus: "own", index: 0, file: "README.md", start: 1, end: 10 },
			kind: "exact",
			tokens: 60,
			scanner: "jscpd",
		},
	]);
});

test("parseJplag splits submission ids at the first underscore, either side first", () => {
	const point = (line: number) => ({ line });
	const pairs = parseJplag([
		{
			matches: [
				{
					firstFileName: "1-work_w-my_dir/pkg/a.go",
					secondFileName: "0-ref_r0/lib/b.go",
					startInFirst: point(5),
					endInFirst: point(20),
					startInSecond: point(7),
					endInSecond: point(22),
					lengthOfFirst: 40,
				},
			],
		},
	]);
	assert.deepEqual(pairs, [
		{
			work: { file: "my_dir/pkg/a.go", start: 5, end: 20 },
			ref: { corpus: "restricted", index: 0, file: "lib/b.go", start: 7, end: 22 },
			kind: "jplag",
			tokens: 40,
			scanner: "jplag",
		},
	]);
});

const pair = (
	file: string,
	start: number,
	end: number,
	scanner: Pair["scanner"],
	corpus: "restricted" | "own" = "restricted",
	refStart = start,
): Pair => ({
	work: { file, start, end },
	ref: { corpus, index: 0, file: `ref/${file}`, start: refStart, end: refStart + end - start },
	kind: scanner === "jplag" ? "jplag" : "renamed",
	tokens: end - start,
	scanner,
});

test("mergeFindings: overlap across scanners is one HIGH finding, a lone range stays MED", () => {
	const findings = mergeFindings([
		pair("a.go", 10, 30, "jscpd"),
		pair("a.go", 25, 40, "jplag"),
		pair("a.go", 60, 70, "jscpd"),
		pair("a.go", 12, 18, "jscpd", "own"),
	]);
	assert.deepEqual(
		findings.map((f) => [f.file, f.start, f.end, f.severity, f.alsoInOwn]),
		[
			["a.go", 10, 40, "HIGH", true],
			["a.go", 60, 70, "MED", false],
		],
	);
	assert.deepEqual(findings[0].scanners, ["jplag", "jscpd"]);
});

test("mergeFindings: own-platform matches alone are no finding", () => {
	assert.deepEqual(mergeFindings([pair("a.go", 1, 30, "jscpd", "own")]), []);
});

test("mergeFindings: the finding id does not depend on the order the scanners reported in", () => {
	const a = pair("a.go", 10, 30, "jscpd");
	const b = pair("a.go", 10, 30, "jplag", "restricted", 50);
	assert.equal(mergeFindings([a, b])[0].id, mergeFindings([b, a])[0].id);
	assert.match(mergeFindings([a])[0].id, /^IP-[0-9a-f]{8}$/);
});

test("agentView exposes no reference location and no scanner output", () => {
	const view = agentView({
		status: "INCOMPLETE",
		score: 21,
		findings: mergeFindings([pair("a.go", 10, 30, "jscpd")]),
		errors: [{ scanner: "jplag", message: "parse error in /secret/client-a/x.go" }],
		versions: {},
	});
	const text = JSON.stringify(view);
	assert.doesNotMatch(text, /ref\/a\.go|client-a|refs/);
	assert.deepEqual(view.findings[0].lines, "10-30");
	assert.deepEqual(view.errors, ["jplag failed; details in the audit record"]);
});

test("guardHit blocks paths into or above a restricted root, nothing else", () => {
	const roots = ["/w/client-a", `${homedir()}/.omp/client-ip`];
	const cwd = "/w/client-b";
	const hit = (input: Record<string, unknown>) => guardHit(input, cwd, roots);

	assert.equal(hit({ path: "/w/client-a/svc/x.go" }), "/w/client-a/svc/x.go");
	assert.equal(hit({ command: "cat ../client-a/README.md | head" }), "../client-a/README.md");
	assert.equal(hit({ command: "rg Transfer .." }), "..", "a parent search reads the root");
	assert.equal(hit({ paths: ["src", "/w"] }), "/w");
	assert.equal(hit({ command: "cat ~/.omp/client-ip/config.json" }), "~/.omp/client-ip/config.json");
	assert.equal(hit({ command: "ls", cwd: "/w/client-a" }), "/w/client-a");

	assert.equal(hit({ command: "cd ../client-a2 && go test ./..." }), undefined, "prefix sibling");
	assert.equal(hit({ path: "internal/wallet.go" }), undefined);
	assert.equal(hit({ command: "ls ~" }), undefined, "home is not treated as a parent");
	assert.equal(
		hit({ path: "notes.md", content: "see /w/client-a/README.md" }),
		undefined,
		"file content is not a path argument",
	);
});

test("findRepo matches the listed directory and below it, not a sibling sharing its prefix", () => {
	const config = {
		repos: [{ path: "/w/client-b", restricted: ["/w/client-a"], own: ["/w/own"] }],
	} as Config;
	assert.deepEqual(findRepo(config, "/w/client-b/api"), {
		root: "/w/client-b/api",
		restricted: ["/w/client-a"],
		own: ["/w/own"],
	});
	assert.equal(findRepo(config, "/w/client-b2"), undefined);
});

test("loadConfig: absent file is undefined; ignore extends the defaults", async () => {
	const home = tempDir("client-ip-cfg-");
	assert.equal(await loadConfig(home), undefined);
	writeFileSync(join(home, "config.json"), JSON.stringify({ ignore: ["^fixtures/"], repos: { "~/b": {} } }));
	const config = await loadConfig(home);
	assert.ok(config);
	assert.ok(config.ignore.some((re) => re.test("fixtures/a.go")));
	assert.ok(config.ignore.some((re) => re.test("svc/go.sum")), "default ignore kept");
	assert.ok(config.ignore.some((re) => re.test("svc/._main.go")), "AppleDouble metadata ignored");
	assert.ok(!config.ignore.some((re) => re.test("svc/a._b.go")), "a '._' inside a name is source");
	assert.deepEqual(config.repos, [{ path: join(homedir(), "b"), restricted: [], own: [] }]);
});

// --- scans with the real binaries ---------------------------------------------------

const REF_GO = `package wallet

import "errors"

type Ledger struct{ balances map[string]int64 }

func (l *Ledger) Transfer(from, to string, amount int64) error {
	if amount <= 0 {
		return errors.New("amount must be positive")
	}
	fb, ok := l.balances[from]
	if !ok {
		return errors.New("unknown source account")
	}
	if fb < amount {
		return errors.New("insufficient funds")
	}
	if _, ok := l.balances[to]; !ok {
		return errors.New("unknown target account")
	}
	l.balances[from] = fb - amount
	l.balances[to] += amount
	return nil
}
`;

const REF_DOC = `# Settlement runbook

The settlement job runs every night at two o'clock and collects all wagers that were closed during the previous business day.
It groups them per operator, computes the gross gaming revenue and writes one ledger entry per operator into the finance schema.
When the job fails, the on-call engineer re-runs it with the business date as the only argument; the job is idempotent per date.
Partial runs are detected through the settlement_runs table, which records the start and end timestamps of every attempt.
Operators that were onboarded after the business date are skipped, and their revenue is booked on the following day instead.
`;

/** Creates a git repository at dir holding files. */
function gitRepo(dir: string, files: Record<string, string>) {
	for (const [file, text] of Object.entries(files)) {
		mkdirSync(join(dir, file, ".."), { recursive: true });
		writeFileSync(join(dir, file), text);
	}
	const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
	git("init", "-q");
	git("add", "-A");
	git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
}

const created: string[] = [];
after(() => {
	for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

/** Fresh directory under the system temp dir, symlinks resolved, removed after the run. */
function tempDir(prefix: string) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	created.push(dir);
	return dir;
}

/** Client A, the own platform and client B with a renamed copy, a docs copy and own code. */
function fixture() {
	const base = tempDir("client-ip-fx-");
	gitRepo(join(base, "client-a"), { "wallet/ledger.go": REF_GO, "RUNBOOK.md": REF_DOC });
	gitRepo(join(base, "own"), { "wallet/ledger.go": REF_GO });
	gitRepo(join(base, "client-b"), {
		"internal/wallet/book.go": REF_GO.replaceAll("Ledger", "Book")
			.replaceAll("balances", "accts")
			.replaceAll("amount", "cents"),
		"docs/OPS.md": REF_DOC.replace("on-call engineer", "engineer on duty"),
		"main.go": "package main\n\nfunc main() {}\n",
	});
	return base;
}

const realConfig = await loadConfig().catch(() => undefined);
const binaries =
	realConfig &&
	[realConfig.jscpd, realConfig.jplagJar].every((p) => {
		try {
			readFileSync(p);
			return true;
		} catch {
			return false;
		}
	});
const skip = binaries ? false : "scanner binaries not configured in the client-ip home";

test("scan reports the renamed code and the reworded doc, labels the own-platform overlap", { skip, timeout: 120_000 }, async () => {
	const base = fixture();
	const repo: Repo = {
		root: join(base, "client-b"),
		restricted: [join(base, "client-a")],
		own: [join(base, "own")],
	};
	const result = await scan(realConfig as Config, repo);

	assert.equal(result.status, "FINDINGS", JSON.stringify(result.errors));
	const byFile = Object.fromEntries(result.findings.map((f) => [f.file, f]));
	assert.equal(byFile["internal/wallet/book.go"]?.severity, "HIGH");
	assert.equal(byFile["internal/wallet/book.go"]?.alsoInOwn, true);
	assert.ok(byFile["docs/OPS.md"], "prose copy is reported");
	assert.equal(byFile["main.go"], undefined);

	const text = JSON.stringify(agentView(result));
	assert.ok(!text.includes(base), "no reference path reaches the agent");
	assert.ok(!text.includes("insufficient funds"), "no reference source reaches the agent");

	const home = tempDir("client-ip-home-");
	const first = await writeAudit(home, repo, result, { session: "s1", trigger: "test" });
	await writeAudit(home, repo, result, { session: "s1", trigger: "test" });
	const record = JSON.parse(readFileSync(first, "utf8"));
	assert.equal(record.findings[0].refs[0].root, join(base, "client-a"));
	const auditDir = join(first, "..");
	assert.equal(readdirSync(auditDir).filter((f) => f.endsWith(".json")).length, 2);
	const queue = readFileSync(join(auditDir, "review.jsonl"), "utf8").trim().split("\n");
	assert.equal(queue.length, result.findings.length, "review queue lists each finding once");
	assert.equal(JSON.parse(queue[0]).status, "open");
});

test("scan is INCOMPLETE, never CLEAN, when the scanners cannot run", { timeout: 60_000 }, async () => {
	const base = fixture();
	const config = {
		home: base,
		jscpd: join(base, "missing-jscpd"),
		java: join(base, "missing-java"),
		jplagJar: join(base, "missing.jar"),
		minTokens: 50,
		minLines: 5,
		jplagMinTokens: 20,
		ignore: [],
		repos: [],
	} satisfies Config;
	const result = await scan(config, {
		root: join(base, "client-b"),
		restricted: [join(base, "client-a")],
		own: [],
	});
	assert.equal(result.status, "INCOMPLETE");
	assert.deepEqual(result.errors.map((e) => e.scanner).sort(), ["jplag", "jscpd"]);
});

// --- extension wiring ---------------------------------------------------------------

type Handler = (event: unknown, ctx: unknown) => unknown;
type ToolResult = { content: { text: string }[] };

/**
 * Loads the extension against a mock pi whose session runs in cwd. nextNote resolves on
 * the next notification, which is how a detached gate reports that it finished.
 */
function load(cwd: string) {
	const handlers = new Map<string, Handler>();
	const sent: string[] = [];
	const notes: string[] = [];
	let waiting: PromiseWithResolvers<string> | undefined;
	let tool: { execute: (...args: unknown[]) => Promise<ToolResult> } | undefined;
	let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
	const pi = {
		on: (name: string, fn: Handler) => handlers.set(name, fn),
		registerCommand: (_name: string, spec: typeof command) => {
			command = spec;
		},
		registerTool: (spec: typeof tool) => {
			tool = spec;
		},
		sendUserMessage: (text: string) => sent.push(text),
	};
	const ctx = {
		cwd,
		hasUI: true,
		isIdle: () => true,
		ui: {
			notify: (text: string) => {
				notes.push(text);
				waiting?.resolve(text);
			},
			setStatus: () => {},
		},
		sessionManager: { getSessionFile: () => "/sessions/s1.jsonl" },
	};
	extension(pi as never);
	const fire = (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx);
	const nextNote = () => {
		waiting = Promise.withResolvers<string>();
		return waiting.promise;
	};
	const runTool = async () => (await tool?.execute("id", {}, undefined, undefined, ctx))?.content[0].text ?? "";
	const runCommand = (args: string) => command?.handler(args, ctx);
	return { sent, notes, fire, nextNote, runTool, runCommand };
}

/** Fixture repositories and a client-ip home listing client-b; points CLIENT_IP_HOME at it. */
function listedFixture() {
	const base = fixture();
	const home = join(base, "home");
	mkdirSync(home);
	writeFileSync(
		join(home, "config.json"),
		JSON.stringify({
			jscpd: realConfig?.jscpd ?? "jscpd",
			java: realConfig?.java ?? "java",
			jplagJar: realConfig?.jplagJar ?? "jplag.jar",
			repos: {
				[join(base, "client-b")]: {
					restricted: [join(base, "client-a")],
					own: [join(base, "own")],
				},
			},
		}),
	);
	process.env.CLIENT_IP_HOME = home;
	return { base, home, work: join(base, "client-b") };
}

afterEach(() => {
	delete process.env.CLIENT_IP_HOME;
});

test("tool calls into the restricted corpus are blocked, the own platform stays readable", async () => {
	const { base, work } = listedFixture();
	const { fire } = load(work);
	const ref = join(base, "client-a", "wallet", "ledger.go");

	const blocked = (await fire("tool_call", { toolName: "read", input: { path: ref } })) as
		| { block: boolean; reason: string }
		| undefined;
	assert.equal(blocked?.block, true);
	assert.equal(await fire("tool_call", { toolName: "read", input: { path: "docs/OPS.md" } }), undefined);
	assert.equal(
		await fire("tool_call", { toolName: "bash", input: { command: "cat ../own/wallet/ledger.go" } }),
		undefined,
	);
});

test("tool calls are not guarded outside a listed repository", async () => {
	const { base } = listedFixture();
	const { fire } = load(join(base, "client-a"));
	assert.equal(
		await fire("tool_call", { toolName: "read", input: { path: "wallet/ledger.go" } }),
		undefined,
	);
});

test("the gate hands findings to the agent without reference data, three rounds per request", { skip, timeout: 600_000 }, async () => {
	const { base, home, work } = listedFixture();
	const { sent, notes, fire, nextNote } = load(work);

	await fire("agent_start");
	await fire("agent_end");
	assert.equal(sent.length, 0, "a loop that changed nothing is not scanned");

	const file = join(work, "internal/wallet/book.go");
	for (let round = 1; round <= 4; round++) {
		await fire("agent_start");
		writeFileSync(file, `${readFileSync(file, "utf8")}// round ${round}\n`);
		const done = nextNote();
		await fire("agent_end");
		await done;
	}

	assert.equal(sent.length, 3, "the fourth loop only reports");
	assert.match(notes.at(-1) ?? "", /findings remain after 3 rewrite rounds/);
	assert.match(sent[0], /round 1\/3/);
	assert.match(sent[0], /"file": "internal\/wallet\/book\.go"/);
	assert.match(sent[0], /"id": "IP-[0-9a-f]{8}"/);
	assert.ok(!sent[0].includes(join(base, "client-a")), "no reference path in the prompt");
	assert.ok(!sent[0].includes("insufficient funds"), "no reference source in the prompt");

	const [bucket] = readdirSync(join(home, "audit"));
	assert.ok(readFileSync(join(home, "audit", bucket, "review.jsonl"), "utf8").includes(join(base, "client-a")));
});

test("the protocol rides in the system prompt of listed repositories only", async () => {
	const { base, work } = listedFixture();
	const listed = (await load(work).fire("before_agent_start", { systemPrompt: "BASE" })) as
		| { systemPrompt: string }
		| undefined;
	assert.match(listed?.systemPrompt ?? "", /^BASE\n\n# Client IP check/);
	assert.match(listed?.systemPrompt ?? "", /## Rewrite protocol/);
	assert.equal(
		await load(join(base, "client-a")).fire("before_agent_start", { systemPrompt: "BASE" }),
		undefined,
	);
});

test("/ip-check off pauses the gate and the protocol, never the guard", async () => {
	const { base, work } = listedFixture();
	const { sent, fire, runCommand } = load(work);
	await runCommand("off");

	assert.equal(await fire("before_agent_start", { systemPrompt: "BASE" }), undefined);
	await fire("agent_start");
	writeFileSync(join(work, "new.go"), "package main\n");
	await fire("agent_end");
	assert.equal(sent.length, 0);
	const blocked = (await fire("tool_call", {
		toolName: "read",
		input: { path: join(base, "client-a", "RUNBOOK.md") },
	})) as { block: boolean } | undefined;
	assert.equal(blocked?.block, true);
});

test("an unreadable config is reported and guards nothing", async () => {
	const { base, home, work } = listedFixture();
	writeFileSync(join(home, "config.json"), "{");
	const { notes, fire } = load(work);
	assert.equal(
		await fire("tool_call", { toolName: "read", input: { path: join(base, "client-a", "RUNBOOK.md") } }),
		undefined,
	);
	assert.match(notes[0] ?? "", /config\.json unreadable/);
});

test("client_ip_check returns the agent view of every listed repository", { skip, timeout: 120_000 }, async () => {
	const { base, work } = listedFixture();
	const text = await load(work).runTool();
	const [view] = JSON.parse(text);
	assert.equal(view.repo, work);
	assert.equal(view.status, "FINDINGS");
	assert.ok(view.findings.some((f: { file: string }) => f.file === "internal/wallet/book.go"));
	assert.ok(!text.includes(join(base, "client-a")));

	assert.match(await load(join(base, "client-a")).runTool(), /No work repository of this session is listed/);
});

test("/ip-check run scans on demand and hands the findings over", { skip, timeout: 120_000 }, async () => {
	const { work } = listedFixture();
	const { sent, nextNote, runCommand } = load(work);
	const done = nextNote();
	await runCommand("run");
	assert.match(await done, /findings, rewrite round 1\/3/);
	assert.equal(sent.length, 1);
});

test("a rewrite that removes the match closes the cycle as clean", { skip, timeout: 120_000 }, async () => {
	const { work } = listedFixture();
	const { sent, fire, nextNote } = load(work);
	const file = join(work, "internal/wallet/book.go");

	await fire("agent_start");
	writeFileSync(file, `${readFileSync(file, "utf8")}// touched\n`);
	let done = nextNote();
	await fire("agent_end");
	assert.match(await done, /rewrite round 1\/3/);

	await fire("agent_start");
	writeFileSync(file, "package wallet\n\n// Book is rewritten from behaviour.\ntype Book struct{}\n");
	writeFileSync(join(work, "docs/OPS.md"), "# Operations\n\nRun `make settle DATE=<day>` to settle one day again.\n");
	done = nextNote();
	await fire("agent_end");
	assert.match(await done, /clean/);
	assert.equal(sent.length, 1);
});

test("a scanner failure is reported and never handed over as clean", async () => {
	const { home, work } = listedFixture();
	const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
	writeFileSync(join(home, "config.json"), JSON.stringify({ ...config, jscpd: "/missing/jscpd", java: "/missing/java" }));
	const { sent, fire, nextNote } = load(work);

	await fire("agent_start");
	writeFileSync(join(work, "new.go"), "package main\n");
	const done = nextNote();
	await fire("agent_end");
	assert.match(await done, /incomplete/);
	assert.equal(sent.length, 0);
});

test("a listed repository reached through cd is guarded like the session directory", async () => {
	const { base } = listedFixture();
	const { fire } = load(base);
	const read = { toolName: "read", input: { path: join(base, "client-a", "RUNBOOK.md") } };
	assert.equal(await fire("tool_call", read), undefined, "base itself is no listed repository");
	await fire("tool_call", { toolName: "bash", input: { command: "cd client-b && git status" } });
	assert.equal(((await fire("tool_call", read)) as { block: boolean } | undefined)?.block, true);
});

test("/ip-check on resumes after off; run outside a listed repository only warns", async () => {
	const { base, work } = listedFixture();
	const { fire, runCommand } = load(work);
	await runCommand("off");
	await runCommand("on");
	assert.ok(await fire("before_agent_start", { systemPrompt: "BASE" }));

	const outside = load(join(base, "client-a"));
	await outside.runCommand("run");
	assert.match(outside.notes[0] ?? "", /no listed work repository/);
	assert.equal(outside.sent.length, 0);
});

test("a missing or empty reference root makes the scan INCOMPLETE, not CLEAN", { timeout: 60_000 }, async () => {
	const base = fixture();
	const empty = tempDir("client-ip-empty-");
	const result = await scan(realConfig ?? ({ ignore: [], jscpd: "x", java: "x", jplagJar: "x" } as unknown as Config), {
		root: join(base, "client-b"),
		restricted: [join(base, "client-a-typo"), empty],
		own: [],
	});
	assert.equal(result.status, "INCOMPLETE");
	assert.equal(result.errors.filter((e) => e.scanner === "config").length, 2);
});

test("a reference JPlag cannot parse makes the scan INCOMPLETE", { skip, timeout: 120_000 }, async () => {
	const base = fixture();
	const javaClass = "class A {\n  int f(int x) {\n    if (x > 0) { return x * 2; }\n    return x - 1;\n  }\n}\n";
	const broken = join(base, "client-a-broken");
	gitRepo(broken, { "svc/A.java": javaClass, "svc/B.java": "class B {\n  int f( {\n" });
	mkdirSync(join(base, "client-b", "svc"));
	writeFileSync(join(base, "client-b", "svc", "A.java"), javaClass);
	const result = await scan(realConfig as Config, {
		root: join(base, "client-b"),
		restricted: [broken],
		own: [],
	});
	assert.equal(result.status, "INCOMPLETE");
	assert.match(result.errors.find((e) => e.scanner === "jplag")?.message ?? "", /CANNOT_PARSE/);
});

test("a corrupt review.jsonl line keeps neither old ids nor new findings out of the queue", async () => {
	const base = fixture();
	const repo: Repo = { root: join(base, "client-b"), restricted: [join(base, "client-a")], own: [] };
	const [known, fresh] = mergeFindings([pair("a.go", 1, 20, "jscpd"), pair("b.go", 1, 20, "jscpd")]);
	const result = { status: "FINDINGS" as const, score: 40, findings: [known, fresh], errors: [], versions: {} };
	const home = tempDir("client-ip-home-");
	const dir = join(home, "audit", auditBucket(repo.root));
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "review.jsonl"),
		`${JSON.stringify({ id: known.id, status: "closed" })}\n{"id":"IP-trunc\n`,
	);

	await writeAudit(home, repo, result, { session: "s1", trigger: "test" });
	const ids = readFileSync(join(dir, "review.jsonl"), "utf8").match(/IP-[0-9a-f]{8}/g);
	assert.deepEqual(ids, [known.id, fresh.id]);
});
