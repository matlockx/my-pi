---
name: typescript
description: Write and review TypeScript code following strict type safety, typescript-eslint, and SonarCloud best practices covering security, reliability, and maintainability
---

## What I do

Guide writing and reviewing TypeScript code that is compliant with typescript-eslint's strict type-checked rules, SonarCloud's default JavaScript/TypeScript analysis rules, and modern TypeScript best practices. This covers security vulnerabilities, type safety, reliability bugs, and maintainability code smells.

## When to use me

Use this skill when:
- Writing new TypeScript files (`.ts`, `.tsx`, `.mts`, `.cts`)
- Reviewing or refactoring existing TypeScript code
- Fixing SonarCloud or typescript-eslint issues
- Setting up TypeScript project tooling (ESLint, tsconfig)
- Preparing TypeScript code for CI/CD pipelines with static analysis

## Project setup

### tsconfig.json — strict mode required

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noPropertyAccessFromIndexSignature": true,
    "noFallthroughCasesInSwitch": true,
    "forceConsistentCasingInFileNames": true,
    "exactOptionalPropertyTypes": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "module": "ESNext",
    "target": "ES2022"
  }
}
```

Key flags explained:
- `strict: true` enables `strictNullChecks`, `strictFunctionTypes`, `strictBindCallApply`, `strictPropertyInitialization`, `noImplicitAny`, `noImplicitThis`, `alwaysStrict`, and `useUnknownInCatchVariables`.
- `noUncheckedIndexedAccess` adds `| undefined` to index signatures, preventing runtime errors.
- `exactOptionalPropertyTypes` distinguishes between `undefined` and missing properties.

### ESLint flat config — strictTypeChecked + stylisticTypeChecked

```javascript
// eslint.config.mjs
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },
    rules: {
      // Additional recommended rules
      "@typescript-eslint/no-unnecessary-condition": "error",
      "@typescript-eslint/prefer-nullish-coalescing": "error",
      "@typescript-eslint/prefer-optional-chain": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports" },
      ],
    },
  },
);
```

---

## SonarCloud TypeScript/JavaScript rules — Security

### S2068 — Do not hardcode credentials (BLOCKER)

Never embed passwords, tokens, API keys, or secrets in source code. Use environment variables or secret managers.

```typescript
// BAD
const apiKey = "sk-abc123secret";
const password = "admin123";
const dsn = "postgres://user:pass@host/db";

// GOOD
const apiKey = process.env.API_KEY;
const password = process.env.DB_PASSWORD;
```

### S1523 — No eval() or dynamic code execution (BLOCKER)

Never use `eval()`, `Function()`, `new Function()`, or `setTimeout`/`setInterval` with string arguments.

```typescript
// BAD
eval(userInput);
const fn = new Function("x", userInput);
setTimeout("doSomething()", 1000);

// GOOD
const fn = (x: number): number => x * 2;
setTimeout(() => doSomething(), 1000);
```

typescript-eslint: `no-implied-eval`

### S5131 — Sanitize user input to prevent injection (BLOCKER)

Never pass unsanitized user input to SQL queries, OS commands, file paths, or template engines.

```typescript
// BAD — SQL injection
const query = `SELECT * FROM users WHERE id = ${userId}`;
db.query(`SELECT * FROM users WHERE name = '${name}'`);

// GOOD — parameterized queries
const query = "SELECT * FROM users WHERE id = $1";
db.query(query, [userId]);

// BAD — command injection
import { exec } from "child_process";
exec(`ls ${userInput}`);

// GOOD — use execFile with argument array
import { execFile } from "child_process";
execFile("ls", [userInput], (error, stdout) => {
  // handle result
});
```

### S2245 — Do not use Math.random() for security (CRITICAL)

`Math.random()` is not cryptographically secure. Use `crypto.randomUUID()`, `crypto.getRandomValues()`, or `crypto.randomBytes()` for tokens, keys, and session IDs.

```typescript
// BAD — predictable
const token = Math.random().toString(36).slice(2);
const sessionId = Math.floor(Math.random() * 1000000).toString();

// GOOD — cryptographically secure
const token = crypto.randomUUID();
const bytes = crypto.getRandomValues(new Uint8Array(32));

// GOOD — Node.js
import { randomBytes } from "node:crypto";
const token = randomBytes(32).toString("hex");
```

### S5527 — Always verify TLS certificates (CRITICAL)

Never disable SSL/TLS certificate verification.

```typescript
// BAD
const agent = new https.Agent({ rejectUnauthorized: false });
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

// GOOD — default verification is enabled
const response = await fetch("https://api.example.com");
```

### S5332 — Do not use clear-text protocols (CRITICAL)

Avoid HTTP, FTP, Telnet. Always prefer HTTPS, SFTP, SSH.

```typescript
// BAD
const url = "http://api.example.com/data";

// GOOD
const url = "https://api.example.com/data";
```

### innerHTML / DOM injection prevention (CRITICAL)

Never assign unsanitized user content to `innerHTML`, `outerHTML`, or use `document.write()`.

```typescript
// BAD — XSS vulnerability
element.innerHTML = userInput;
document.write(userContent);

// GOOD — use textContent for plain text
element.textContent = userInput;

// GOOD — use DOMPurify for HTML content
import DOMPurify from "dompurify";
element.innerHTML = DOMPurify.sanitize(userHtml);
```

### Prototype pollution prevention (MAJOR)

Never merge user-controlled objects into application objects without validation.

```typescript
// BAD — prototype pollution
function merge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key in source) {
    target[key] = source[key]; // can set __proto__, constructor
  }
}

// GOOD — validate keys
function safeMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): void {
  for (const key of Object.keys(source)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }
    if (Object.hasOwn(source, key)) {
      target[key] = source[key];
    }
  }
}

// GOOD — use Object.create(null) for dictionaries
const dict: Record<string, string> = Object.create(null) as Record<string, string>;
```

### S4790 — Avoid weak hashing algorithms (CRITICAL)

Do not use MD5 or SHA1 for security purposes. Use SHA-256 or stronger.

```typescript
// BAD
import { createHash } from "node:crypto";
const hash = createHash("md5").update(data).digest("hex");
const hash2 = createHash("sha1").update(data).digest("hex");

// GOOD
const hash = createHash("sha256").update(data).digest("hex");
```

### S5542 — Do not use weak encryption (CRITICAL)

Avoid DES, 3DES, RC4. Use AES-256-GCM or ChaCha20-Poly1305.

```typescript
// BAD
import { createCipheriv } from "node:crypto";
const cipher = createCipheriv("des-ede3", key, iv);

// GOOD
const cipher = createCipheriv("aes-256-gcm", key, iv);
```

---

## Reliability — Type safety

### strict: true is mandatory (CRITICAL)

Never weaken strict mode. The following must never appear in `tsconfig.json`:

```json
// BAD — weakening strict mode
{
  "compilerOptions": {
    "strict": false,
    "strictNullChecks": false,
    "noImplicitAny": false
  }
}
```

### No any — use unknown and narrow (CRITICAL)

`any` disables type checking entirely. Use `unknown` and narrow with type guards.

```typescript
// BAD
function process(data: any): any {
  return data.value;
}

// BAD — type assertion to bypass checks
const result = someValue as SomeType;

// GOOD — unknown with type guard
function process(data: unknown): string {
  if (typeof data === "object" && data !== null && "value" in data) {
    return String(data.value);
  }
  throw new Error("Invalid data");
}

// GOOD — type predicate
function isUser(value: unknown): value is User {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof (value as User).name === "string"
  );
}
```

typescript-eslint: `no-explicit-any`, `no-unsafe-assignment`, `no-unsafe-argument`, `no-unsafe-call`, `no-unsafe-member-access`, `no-unsafe-return`

### No @ts-ignore without justification (MAJOR)

```typescript
// BAD — silently suppresses errors
// @ts-ignore
doSomething(wrongType);

// ACCEPTABLE — with justification and using @ts-expect-error
// @ts-expect-error — third-party type definitions are incorrect for v3.x
doSomething(wrongType);
```

typescript-eslint: `ban-ts-comment` (with `allowWithDescription` option)

### No floating promises (CRITICAL)

Every Promise must be awaited, returned, or explicitly voided.

```typescript
// BAD — promise result ignored, errors silently lost
async function save(data: Data): Promise<void> {
  db.insert(data);  // floating promise
}

fetchData();  // floating promise at top level

// GOOD
async function save(data: Data): Promise<void> {
  await db.insert(data);
}

await fetchData();

// GOOD — explicit void for fire-and-forget
void analytics.track("event");
```

typescript-eslint: `no-floating-promises`

### No misused promises (CRITICAL)

Do not use Promises in boolean positions or as conditions.

```typescript
// BAD — condition is always truthy (it's a Promise object)
async function getData(): Promise<Data | null> {
  const data = fetchData();  // missing await
  if (data) {  // always truthy — it's a Promise, not the resolved value
    return data;
  }
  return null;
}

// BAD — passing async function where sync callback expected
const results = items.filter(async (item) => {
  const valid = await validate(item);
  return valid;  // filter gets Promise, which is truthy
});

// GOOD
const data = await fetchData();
if (data) {
  return data;
}

// GOOD
const validationResults = await Promise.all(items.map(validate));
const results = items.filter((_, i) => validationResults[i]);
```

typescript-eslint: `no-misused-promises`

### Exhaustive switch handling (MAJOR)

Switch statements on union types should handle all variants.

```typescript
type Status = "active" | "inactive" | "pending";

// BAD — missing "pending" case
function getLabel(status: Status): string {
  switch (status) {
    case "active":
      return "Active";
    case "inactive":
      return "Inactive";
    // "pending" is silently ignored
  }
}

// GOOD — exhaustive with default
function getLabel(status: Status): string {
  switch (status) {
    case "active":
      return "Active";
    case "inactive":
      return "Inactive";
    case "pending":
      return "Pending";
    default: {
      const _exhaustive: never = status;
      throw new Error(`Unhandled status: ${String(_exhaustive)}`);
    }
  }
}
```

typescript-eslint: `switch-exhaustiveness-check`

### No non-null assertions without justification (MAJOR)

The `!` operator bypasses null checks. Use optional chaining and nullish coalescing instead.

```typescript
// BAD — crashes if property is undefined
const value = obj.property!.nested!.value;

// GOOD — safe access
const value = obj.property?.nested?.value ?? defaultValue;
```

typescript-eslint: `no-non-null-assertion`

### Proper error handling (MAJOR)

Never use empty catch blocks. Always handle or rethrow errors.

```typescript
// BAD — silently swallows error
try {
  await riskyOperation();
} catch {
  // empty
}

// BAD — catch with any
try {
  await riskyOperation();
} catch (error: any) {
  console.log(error.message);
}

// GOOD — handle with unknown
try {
  await riskyOperation();
} catch (error: unknown) {
  if (error instanceof AppError) {
    logger.warn("Expected error", { code: error.code });
  } else {
    logger.error("Unexpected error", { error });
    throw error;
  }
}
```

### No unnecessary conditions (MAJOR)

Do not check conditions that are always truthy or always falsy based on their type.

```typescript
// BAD — items is T[], never nullish
function head<T>(items: T[]): T | undefined {
  if (items) {  // always truthy — arrays are objects
    return items[0];
  }
  return undefined;
}

// BAD — arg is never nullish
function foo(arg: string): void {
  if (arg) {  // unnecessary — string can be empty but not nullish
  }
}

// GOOD
function head<T>(items: T[]): T | undefined {
  return items[0];
}
```

typescript-eslint: `no-unnecessary-condition`

---

## Maintainability

### const over let, never var (MINOR)

```typescript
// BAD
var count = 0;
let name = "fixed"; // never reassigned

// GOOD
const name = "fixed";
let count = 0; // reassigned later
count += 1;
```

### Prefer nullish coalescing ?? over || (MAJOR)

`||` falls through on `""`, `0`, `false`, and `NaN`. Use `??` when you only want to coalesce on `null`/`undefined`.

```typescript
// BAD — treats "" and 0 as missing
const name = input.name || "default";
const port = config.port || 3000;

// GOOD — only coalesces null/undefined
const name = input.name ?? "default";
const port = config.port ?? 3000;
```

typescript-eslint: `prefer-nullish-coalescing`

### Prefer optional chaining ?. (MAJOR)

```typescript
// BAD
const street = user && user.address && user.address.street;

// GOOD
const street = user?.address?.street;
```

typescript-eslint: `prefer-optional-chain`

### Consistent naming conventions (MINOR)

```typescript
// Types and interfaces: PascalCase
interface UserProfile {
  id: string;
  displayName: string;
}

type RequestHandler = (req: Request) => Response;

// Variables and functions: camelCase
const maxRetries = 3;
function fetchUserProfile(id: string): Promise<UserProfile> { /* ... */ }

// Constants: UPPER_SNAKE_CASE for true constants
const MAX_RETRY_COUNT = 3;
const API_BASE_URL = "https://api.example.com";

// Enum members (if used): PascalCase
// But prefer as const objects — see below
```

### No enum — use as const objects or union types (MAJOR)

Enums have runtime behavior, numeric enums are not type-safe, and const enums break isolatedModules.

```typescript
// BAD — numeric enum
enum Direction {
  Up,
  Down,
  Left,
  Right,
}
const d: Direction = 42; // no error!

// BAD — const enum (breaks isolatedModules)
const enum Color {
  Red = "RED",
  Blue = "BLUE",
}

// GOOD — union type (simplest)
type Direction = "up" | "down" | "left" | "right";

// GOOD — as const object (when you need runtime values)
const Direction = {
  Up: "up",
  Down: "down",
  Left: "left",
  Right: "right",
} as const;
type Direction = (typeof Direction)[keyof typeof Direction];
```

### Use readonly for immutable data (MINOR)

```typescript
// BAD — mutable parameters
function processItems(items: string[]): void {
  items.push("extra"); // mutates caller's array
}

// GOOD — readonly prevents mutation
function processItems(items: readonly string[]): void {
  // items.push("extra"); // compile error
  const result = [...items, "extra"]; // create new array
}

// GOOD — readonly properties
interface Config {
  readonly host: string;
  readonly port: number;
}
```

### Use type imports (MINOR)

Separate type imports from value imports for clarity and to enable optimizations.

```typescript
// BAD — mixed
import { User, createUser } from "./user";

// GOOD — separated
import type { User } from "./user";
import { createUser } from "./user";

// GOOD — inline type imports
import { type User, createUser } from "./user";
```

typescript-eslint: `consistent-type-imports`

### S3776 — Reduce cognitive complexity (CRITICAL)

Functions with deep nesting and many branches are hard to understand. Keep cognitive complexity below 15.

```typescript
// BAD — deeply nested
function process(data: Item[]): Result[] {
  const results: Result[] = [];
  if (data) {
    for (const item of data) {
      if (item.isValid()) {
        if (item.type === "A") {
          for (const sub of item.children) {
            if (sub.active) {
              results.push(handle(sub));
            }
          }
        }
      }
    }
  }
  return results;
}

// GOOD — flat with early returns and helpers
function process(data: Item[]): Result[] {
  return data.filter((item) => item.isValid()).flatMap(processItem);
}

function processItem(item: Item): Result[] {
  if (item.type !== "A") return [];
  return item.children.filter((sub) => sub.active).map(handle);
}
```

### S138 — Functions should not be too long (MAJOR)

Functions should not exceed ~50 lines. Break large functions into smaller, focused helpers.

### S1192 — Do not duplicate string literals (MINOR)

If the same string appears 3+ times, assign it to a constant.

```typescript
// BAD
logger.info("Processing stage: compilation");
notify("Processing stage: compilation");
record("Processing stage: compilation");

// GOOD
const STAGE_COMPILATION = "Processing stage: compilation";
logger.info(STAGE_COMPILATION);
notify(STAGE_COMPILATION);
record(STAGE_COMPILATION);
```

### S125 — Remove commented-out code (MAJOR)

Commented-out code is dead code. Remove it; version control preserves history.

### S1135 — Track TODO/FIXME comments (INFO)

`TODO` and `FIXME` comments should include a ticket reference.

```typescript
// BAD
// TODO: fix this later

// GOOD
// TODO(PROJ-1234): refactor to use streaming client
```

### Prefer interfaces for object shapes, types for unions (MINOR)

```typescript
// GOOD — interface for object shapes (extendable)
interface UserProps {
  name: string;
  email: string;
}

// GOOD — type for unions, intersections, mapped types
type Status = "active" | "inactive" | "pending";
type Nullable<T> = T | null;
type EventHandler = (event: Event) => void;
```

---

## Error handling best practices

### Define domain-specific error classes

```typescript
class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
  ) {
    super(message);
    this.name = "AppError";
  }
}

class NotFoundError extends AppError {
  constructor(resource: string, id: string) {
    super(`${resource} not found: ${id}`, "NOT_FOUND", 404);
    this.name = "NotFoundError";
  }
}

class ValidationError extends AppError {
  constructor(
    message: string,
    public readonly field: string,
  ) {
    super(message, "VALIDATION_ERROR", 400);
    this.name = "ValidationError";
  }
}
```

### Use Result types for expected failures

```typescript
type Result<T, E = Error> =
  | { success: true; data: T }
  | { success: false; error: E };

function parseConfig(input: string): Result<Config, ValidationError> {
  try {
    const parsed: unknown = JSON.parse(input);
    const config = validateConfig(parsed);
    return { success: true, data: config };
  } catch (error: unknown) {
    return {
      success: false,
      error: new ValidationError("Invalid config format", "config"),
    };
  }
}
```

---

## Input validation

### Use schema validation at boundaries

```typescript
// Using Zod (recommended)
import { z } from "zod";

const CreateUserSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
  age: z.number().int().positive().max(150),
});

type CreateUserInput = z.infer<typeof CreateUserSchema>;

function createUser(input: unknown): User {
  const parsed = CreateUserSchema.parse(input); // throws ZodError on invalid
  return db.users.create(parsed);
}
```

---

## Tooling integration

### ESLint (primary linter)

```bash
# Install
npm install -D eslint typescript-eslint @eslint/js typescript

# Run
npx eslint .
npx eslint --fix .
```

### tsc (type checker)

```bash
# Type check without emitting
npx tsc --noEmit

# Watch mode
npx tsc --noEmit --watch
```

### Prettier or dprint (formatter)

```bash
# Prettier
npm install -D prettier
npx prettier --check .
npx prettier --write .

# dprint (faster)
npm install -D dprint
npx dprint check
npx dprint fmt
```

### Pre-commit configuration (recommended)

```yaml
# .pre-commit-config.yaml
repos:
  - repo: local
    hooks:
      - id: eslint
        name: eslint
        entry: npx eslint --fix
        language: system
        types: [ts, tsx]
      - id: tsc
        name: typecheck
        entry: npx tsc --noEmit
        language: system
        pass_filenames: false
```

---

## Checklist for new TypeScript files

When writing a new TypeScript file, verify:

- [ ] `strict: true` in tsconfig.json (never weakened)
- [ ] No `any` types — use `unknown` and narrow
- [ ] No `@ts-ignore` — use `@ts-expect-error` with description if needed
- [ ] All Promises are awaited, returned, or explicitly voided
- [ ] No async functions used where sync callbacks are expected
- [ ] Switch on union types handles all variants (exhaustive)
- [ ] No non-null assertions (`!`) without clear justification
- [ ] Error handling uses `unknown` catch type, never `any`
- [ ] No empty catch blocks
- [ ] No hardcoded credentials or secrets
- [ ] No `eval()`, `Function()`, or `setTimeout` with strings
- [ ] No `Math.random()` for security purposes
- [ ] SQL uses parameterized queries
- [ ] User input validated at boundaries (Zod, etc.)
- [ ] `const` used by default, `let` only when reassigned, never `var`
- [ ] Nullish coalescing `??` used instead of `||` for defaults
- [ ] Optional chaining `?.` used for safe property access
- [ ] Type imports separated with `import type`
- [ ] Interfaces for object shapes, types for unions
- [ ] No enums — use union types or `as const` objects
- [ ] `readonly` used for immutable parameters and properties
- [ ] Functions under 50 lines, cognitive complexity under 15
- [ ] No duplicate string literals (use constants)
- [ ] No commented-out code
- [ ] Domain-specific error classes defined
- [ ] `eslint` passes cleanly
- [ ] `tsc --noEmit` passes cleanly

## Checklist for code review

When reviewing TypeScript code, additionally check:

- [ ] No SQL injection (S5131)
- [ ] No command injection (S5131)
- [ ] No XSS via innerHTML/outerHTML/document.write
- [ ] No hardcoded credentials (S2068)
- [ ] TLS verification not disabled (S5527)
- [ ] Strong hashing algorithms for security (S4790)
- [ ] Cryptographically secure random for tokens (S2245)
- [ ] No weak encryption (S5542)
- [ ] No prototype pollution in object merging
- [ ] No floating promises (all async errors handled)
- [ ] No type assertions bypassing safety
- [ ] Return values of pure functions not discarded
- [ ] All code paths reachable
