---
name: client-ip-check
description: Cross-client IP contamination check. Use when working in a repository built for one client whose functionality overlaps code owned by another client (same platform built twice), when the user asks for an IP, copyright or copy-paste check against another client's code, or when the client-ip-check extension reports findings.
---

# Client IP check

## Purpose

The consultancy builds functionally similar systems for several clients, and some clients own the copyright in the code written for them. A work repository (client B) must not contain the expression of code owned by another client (client A): its source text, its structure, its tests or its documentation. The functionality itself may be the same.

The `client-ip-check` extension enforces this for every work repository listed in `~/.omp/client-ip/config.json`:

- jscpd (exact, renamed and near-miss clones) and JPlag (token structure, obfuscation-resilient) compare the whole work repository (code, tests, docs) against the restricted corpus of the other client and against the own platform.
- At the end of every agent loop that changed a listed repository, findings come back as a follow-up message; up to 3 rewrite rounds per user request.
- Every scan is recorded under `~/.omp/client-ip/audit/<repo>/`; each new finding is appended to `review.jsonl` with status `open` for later human review.
- Tool calls that reach into a restricted corpus or `~/.omp/client-ip` are blocked.

A clean scan is a risk signal, not a legal clearance. It does not check contract terms (exclusivity, non-solicitation, confidentiality) or trade secrets: using a trade secret in breach of a confidentiality agreement or a contractual duty to limit its use is unlawful however the code is written (`eu-trade-secrets-directive-2016-943` §4(3)(b)(c)).

## Rules while working in a listed repository

1. Never open, search, copy or paraphrase code, tests or docs of a restricted corpus. Build from the requirement, the observable behaviour, public specifications and the own platform.
2. Code taken from the own platform is allowed, but it is scanned like everything else; a match labelled `alsoInOwn` means the own platform carries the same text as the other client's code, and the overlap is logged for a provenance check.
3. Never lower a score by renaming, reordering, reformatting, splitting or merging matched text. An altered version of a program is still the rightholder's to authorise: "the translation, adaptation, arrangement and any other alteration of a computer program" is a restricted act (`eu-software-directive-2009-24` §4(1)(b); `de-urhg` §69c Nr. 2; UK: "an arrangement or altered version of the program", `uk-copyright-designs-patents-act-1988` §21(3)(ab)).
4. Functionality, interfaces as behaviour, data formats and the programming language are not protected expression: "the functionality of a computer program does not count as a form of expression" (`uk-sas-wpl-2013-ewca-civ-1482` §74; `cjeu-sony-datel-c-159-23` §36). Studying what a program does and writing an own program with the same functionality is not an infringement of the copyright in its source code (`cjeu-sas-institute-c-406-10` §26). Same behaviour is fine; the same text is not.

## Finding format

```json
{ "repo": "/path/to/work", "status": "FINDINGS", "score": 42,
  "findings": [{ "id": "IP-1a2b3c4d", "file": "internal/wallet/transfer.go", "lines": "12-58",
                 "severity": "HIGH", "kinds": ["jplag", "renamed"], "scanners": ["jplag", "jscpd"],
                 "alsoInOwn": false }] }
```

- `severity`: HIGH when both scanners report the range, MED when one does.
- `kinds`: `exact`/`renamed` (same token sequence, identifiers may differ), `gap` (near-miss with small insertions), `jplag` (structural match).
- `score`: work lines covered by findings; the goal is `CLEAN` with score 0.
- `INCOMPLETE`: a scanner failed, a reference root is missing or empty, or JPlag could not parse a directory; say so in the report, the result is not a clean bill.

## Rewrite protocol

For every finding, in this order:

1. **Scope the unit.** Widen the reported lines to the whole function, type, test case or doc section they belong to. That unit is rewritten as a whole.
2. **Check coverage first.** Run the repository's coverage tool for the package (`go test -coverprofile`, `pytest --cov`, `vitest --coverage`) and list the behaviours of the unit: inputs, outputs, errors, side effects, edge cases. Missing or weak coverage: write the tests now, from the behaviour, against the current code, and run them green before touching the unit. Tests are scanned too; write them fresh, never adapt a matched test.
3. **Rewrite from behaviour.** Delete the unit. Write it again from the behaviour list and the tests, in the idiom of this repository: own decomposition, own names, own error messages and comments, own order of checks where the order is not behaviour. Do not keep the old text open while writing; do not edit it into shape.
4. **Docs findings.** Rewrite the section from the facts of this system (its endpoints, commands, configuration); do not reword the old sentences.
5. **Verify.** Run the full test suite of the package; behaviour must not change. Call `client_ip_check`; repeat for findings that remain.
6. **Report.** One line per finding id: what was rewritten, which tests cover it, coverage before and after. The finding stays `open` in `review.jsonl` until a human closes it.

No rewrite, report instead, when the match carries no authored expression: generated code, dependency manifests, licence texts, configuration dictated by a tool or protocol (a fixed schema, a standard Dockerfile line). Say in one line why, and suggest an `ignore` pattern for the config; the human decides.

When in doubt about whether something is protected, reusable or a contract question, consult the `software-and-intellectual-property-law` knowledge base (`kb_search`, `kb_topic` with `ideas_functionality`, `copying_infringement`, `reuse_reimplementation`, `trade_secrets`, `contracts`), cite `source_id` and `section_ref`, and draw no legal conclusion the source does not state. No answer in the knowledge base: say so.

## Configuration

`~/.omp/client-ip/config.json` (outside every repository; it names the clients):

```json
{
  "jscpd": "~/.omp/client-ip/bin/jscpd",
  "java": "~/.sdkman/candidates/java/25.0.4-tem/bin/java",
  "jplagJar": "~/.omp/client-ip/bin/jplag-6.3.0.jar",
  "minTokens": 50, "minLines": 5, "jplagMinTokens": 20,
  "ignore": ["(^|/)testdata/fixtures/"],
  "repos": {
    "~/github/client-b": {
      "restricted": ["~/github/client-a/wallet-service", "~/github/client-a/docs"],
      "own": ["~/github/our-platform"]
    }
  }
}
```

- A `repos` key matches a git root equal to it or below it, so one key can cover all repositories of a client.
- `ignore` holds regular expressions over repository-relative paths and extends the defaults (dependency trees, build output, lockfiles, `go.mod`/`go.sum`, `*.pb.go`).
- Commands: `/ip-check run` scans now, `/ip-check off`/`on` pauses for the session, `/ip-check status`.
