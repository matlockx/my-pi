/**
 * Optional gitleaks integration — scans text via `gitleaks stdin` and returns
 * the literal secrets it finds. Graceful: if the binary is absent, errors, or
 * times out, returns [] so callers fall back to the in-process regex rules.
 *
 * Used only at ingestion hooks (discrete events), never on the per-turn egress
 * net, to keep the subprocess off the hot path.
 */

import { spawn } from "node:child_process";
import type { ExternalHit } from "./redact.ts";

let available: boolean | null = null; // cache: null=unknown, false=missing
const TIMEOUT_MS = 5000;

interface GitleaksFinding {
	Secret?: string;
	RuleID?: string;
}

/** Scan text with gitleaks. Returns [] when gitleaks is unavailable or on any error. */
export function scanSecrets(text: string): Promise<ExternalHit[]> {
	if (available === false || text.trim() === "") return Promise.resolve([]);

	return new Promise((resolve) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const done = (hits: ExternalHit[]) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve(hits);
		};

		let proc: ReturnType<typeof spawn>;
		try {
			proc = spawn(
				"gitleaks",
				[
					"stdin",
					"--report-format",
					"json",
					"--report-path",
					"-",
					"--no-banner",
					"--exit-code",
					"0",
					"--log-level",
					"error",
				],
				{ stdio: ["pipe", "pipe", "ignore"] },
			);
		} catch {
			available = false;
			return done([]);
		}

		timer = setTimeout(() => {
			proc.kill("SIGKILL");
			done([]);
		}, TIMEOUT_MS);

		let out = "";
		proc.stdout?.on("data", (d) => {
			out += d;
		});
		// ENOENT (binary missing) and EPIPE land here.
		proc.on("error", () => {
			available = false;
			done([]);
		});
		proc.stdin?.on("error", () => {}); // guard against EPIPE throw
		proc.on("close", () => {
			available = true;
			try {
				const findings = JSON.parse(out || "[]") as GitleaksFinding[];
				const hits = findings
					.filter((f) => typeof f.Secret === "string" && f.Secret.length > 0)
					.map((f) => ({
						secret: f.Secret as string,
						rule: `gitleaks:${f.RuleID || "secret"}`,
					}));
				done(hits);
			} catch {
				done([]);
			}
		});

		proc.stdin?.end(text);
	});
}
