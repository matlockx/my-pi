---
name: typescript
description: Write and review TypeScript with strict tsc and typescript-eslint strictTypeChecked; covers project setup and the security and design rules the linters do not enforce
---

## What I do

Set up and write TypeScript so that `tsc` and typescript-eslint carry the mechanical rules, and
point out the rules no configured linter checks. SonarCloud rule IDs appear as references; do not
run Sonar scans or coverage gates unless the user explicitly asks.

## Project setup

### tsconfig.json

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noPropertyAccessFromIndexSignature": true,
    "noFallthroughCasesInSwitch": true,
    "exactOptionalPropertyTypes": true,
    "forceConsistentCasingInFileNames": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "target": "ES2022"
  }
}
```

Never weaken `strict` or its member flags. Frameworks that ship a base config (Expo, Next, Vite)
extend it with `"extends"` and add the flags above that it lacks; `module`/`moduleResolution`
follow the framework (`NodeNext` for plain Node packages).

### eslint.config.mjs

```javascript
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: { parserOptions: { projectService: true } },
    rules: {
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "no-restricted-syntax": [
        "error",
        { selector: "TSEnumDeclaration", message: "Use a union type or an `as const` object." },
      ],
    },
  },
);
```

Install and run with the project's package manager (lockfile decides: `npm`, `pnpm`, `bun`):

```bash
npm install -D typescript eslint @eslint/js typescript-eslint
npx tsc --noEmit
npx eslint .
```

Formatting follows whatever the repository already uses (Prettier, dprint, Biome); do not add a
second formatter.

## What the linters already cover

`strictTypeChecked` and `stylisticTypeChecked` flag: `any` in all its forms (`no-explicit-any`,
`no-unsafe-*`), floating and misused promises, unnecessary conditions and assertions, non-null
assertions, `@ts-ignore` without `@ts-expect-error` and a description, implied `eval`,
`||` where `??` is meant, missing optional chains, throwing non-`Error` values, and unsafe enum
comparisons. The config above adds exhaustive `switch` on unions, `import type`, and a ban on
`enum`. `strict` makes `catch` variables `unknown`. Fix these where the tool points; do not
restate them in reviews.

## Rules the linters do not enforce

Check these by hand when writing and reviewing:

- **Input from outside the process is parsed once at the boundary** with a schema (Zod, Valibot)
  and passed on as a typed value. `JSON.parse` results, `fetch` bodies, env vars, `postMessage`
  data and storage reads are `unknown` until parsed. `as T` on such a value is a bug.
  ```typescript
  const CreateUser = z.object({ name: z.string().min(1), email: z.email() });
  type CreateUser = z.infer<typeof CreateUser>;
  const input = CreateUser.parse(body);
  ```
- **No injection.** SQL with placeholders (`db.query("… WHERE id = $1", [id])`); child processes
  with `execFile`/`spawn` and an argument array, never `exec` with interpolation; no `eval`,
  `new Function` or string timers (S1523, S5131).
- **No DOM injection.** `textContent` for text; `innerHTML`, `outerHTML`, `document.write` and
  `dangerouslySetInnerHTML` only with sanitised HTML (DOMPurify).
- **No prototype pollution.** Merging or indexing with keys from input skips `__proto__`,
  `constructor` and `prototype`, uses `Object.hasOwn`, or uses a `Map` / `Object.create(null)`.
- **Crypto and transport** (S2245, S4790, S5527, S5542, S5332): tokens from
  `crypto.randomUUID()`/`getRandomValues()`/`randomBytes()`, never `Math.random()`; SHA-256 or
  stronger for security hashes; AES-256-GCM or ChaCha20-Poly1305; certificate checks never off
  (`rejectUnauthorized: false`, `NODE_TLS_REJECT_UNAUTHORIZED=0`); `https://` outside localhost.
- **Secrets** come from the environment or a secret manager and never reach logs, error messages
  or the client bundle (`VITE_`/`NEXT_PUBLIC_`/`EXPO_PUBLIC_` variables are public).
- **`readonly`** for parameters and properties the function does not mutate
  (`readonly string[]`, `readonly host: string`); return new arrays instead of mutating input.
- **Errors.** Domain errors extend `Error` and set `name`; expected failures may use a result
  union instead of throwing; `catch` blocks narrow with `instanceof` before reading fields and
  never swallow silently.
  ```typescript
  class NotFoundError extends Error {
    constructor(readonly resource: string, readonly id: string) {
      super(`${resource} not found: ${id}`);
      this.name = "NotFoundError";
    }
  }
  type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };
  ```
- **Unknown values are narrowed, not cast**: `typeof`, `in`, `instanceof` or a type guard; an
  unavoidable `as unknown as T` names its reason on the line.
- **Small functions**: under about 50 lines and cognitive complexity under 15 (S138, S3776).
- **Interfaces for object shapes, `type` for unions and mapped types**; `const` by default.

## Checklist for new or changed TypeScript files

- [ ] `tsc --noEmit` and `eslint .` pass with the config above
- [ ] Every rule in "Rules the linters do not enforce" holds
- [ ] Suppressions (`eslint-disable-next-line`, `@ts-expect-error`) name the rule and a reason
- [ ] Tests for each new behaviour in the repository's runner (Vitest, Jest, `node:test`, Bun)

## Checklist for review

- [ ] Boundary input parsed with a schema; no `as T` on external data
- [ ] Injection: SQL placeholders, `execFile` with arrays, no `eval`, no unsanitised HTML
- [ ] Prototype pollution: no merging of input keys into plain objects
- [ ] Crypto, TLS and secrets as above; nothing secret in a public env prefix
- [ ] Errors narrowed in `catch`, none swallowed, domain errors typed
