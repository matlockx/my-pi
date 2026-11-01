---
name: react
description: Write and review React components following hooks rules, accessibility, performance, and security best practices
---

## What I do

Guide writing and reviewing React components that follow the Rules of Hooks, prevent XSS and injection vulnerabilities, implement proper accessibility, and avoid common performance pitfalls. This skill covers component patterns, state management, effect cleanup, error handling, and testing practices.

## When to use me

Use this skill when:
- Writing new React components (`.tsx`, `.jsx`)
- Reviewing or refactoring existing React components
- Fixing accessibility or performance issues in React apps
- Setting up React project tooling (ESLint plugins, testing)
- Debugging hooks, re-renders, or effect issues

**Note:** For `.tsx` files, also load the `typescript` skill for type safety rules.

---

## Security

### No dangerouslySetInnerHTML without sanitization (BLOCKER)

`dangerouslySetInnerHTML` bypasses React's XSS protection. Never use it with unsanitized user content.

```tsx
// BAD — XSS vulnerability
function Comment({ body }: { body: string }) {
  return <div dangerouslySetInnerHTML={{ __html: body }} />;
}

// GOOD — sanitize with DOMPurify
import DOMPurify from "dompurify";

function Comment({ body }: { body: string }) {
  const clean = DOMPurify.sanitize(body);
  return <div dangerouslySetInnerHTML={{ __html: clean }} />;
}

// BEST — use plain text when possible
function Comment({ body }: { body: string }) {
  return <div>{body}</div>; // React escapes by default
}
```

### Sanitize URLs in href and src (CRITICAL)

Prevent `javascript:` protocol injection in links and media sources.

```tsx
// BAD — user-controlled URL without validation
function Link({ url, label }: { url: string; label: string }) {
  return <a href={url}>{label}</a>;
}

// GOOD — validate URL protocol
function Link({ url, label }: { url: string; label: string }) {
  const safeUrl = isValidUrl(url) ? url : "#";
  return <a href={safeUrl}>{label}</a>;
}

function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}
```

### Never render unsanitized user content (BLOCKER)

React escapes string content by default, but be careful with content that bypasses this.

```tsx
// BAD — creating elements from user-controlled type
const element = React.createElement(userProvidedTag, props);

// BAD — spreading user-controlled props
<div {...userProvidedProps} />

// GOOD — whitelist allowed element types
const ALLOWED_TAGS = new Set(["div", "span", "p", "h1", "h2", "h3"]);

function SafeElement({
  tag,
  children,
}: {
  tag: string;
  children: React.ReactNode;
}) {
  const Tag = ALLOWED_TAGS.has(tag) ? tag : "div";
  return <Tag>{children}</Tag>;
}
```

### CSP-compatible patterns (MAJOR)

Avoid patterns that require `unsafe-inline` or `unsafe-eval` in Content Security Policy.

```tsx
// BAD — inline styles from user input
<div style={{ background: userInput }} />

// BAD — inline event handlers as strings
<button onClick="doSomething()">Click</button>

// GOOD — use CSS classes or CSS-in-JS with nonce support
<div className={styles.container} />
```

---

## Reliability — Hooks rules

### Rules of Hooks — no conditional hooks (BLOCKER)

Hooks must be called at the top level of a component or custom hook. Never inside conditions, loops, or nested functions.

```tsx
// BAD — conditional hook
function Profile({ userId }: { userId: string | null }) {
  if (userId) {
    const user = useUser(userId); // hook called conditionally
    return <div>{user.name}</div>;
  }
  return <div>No user</div>;
}

// BAD — hook after early return
function Profile({ userId }: { userId: string | null }) {
  if (!userId) {
    return <div>No user</div>;
  }
  const user = useUser(userId); // hook after conditional return
  return <div>{user.name}</div>;
}

// BAD — hook inside loop
function UserList({ ids }: { ids: string[] }) {
  const users = ids.map((id) => useUser(id)); // hook in loop
  return <ul>{users.map((u) => <li key={u.id}>{u.name}</li>)}</ul>;
}

// GOOD — always call hooks at top level
function Profile({ userId }: { userId: string | null }) {
  const user = useUser(userId); // always called
  if (!userId || !user) {
    return <div>No user</div>;
  }
  return <div>{user.name}</div>;
}
```

### useEffect dependency arrays — no missing dependencies (CRITICAL)

Every value from the component scope used inside useEffect must be in the dependency array. Missing dependencies cause stale closures and subtle bugs.

```tsx
// BAD — missing dependency
function Search({ query }: { query: string }) {
  const [results, setResults] = useState<Result[]>([]);

  useEffect(() => {
    fetchResults(query).then(setResults);
  }, []); // query is missing from dependencies

  return <ResultList results={results} />;
}

// GOOD — all dependencies listed
function Search({ query }: { query: string }) {
  const [results, setResults] = useState<Result[]>([]);

  useEffect(() => {
    fetchResults(query).then(setResults);
  }, [query]);

  return <ResultList results={results} />;
}
```

### useEffect cleanup — AbortController, timers, subscriptions (CRITICAL)

Effects that create subscriptions, timers, or fetch requests must return a cleanup function.

```tsx
// BAD — no cleanup, memory leak
useEffect(() => {
  const interval = setInterval(() => tick(), 1000);
  // missing cleanup
}, []);

// BAD — no abort on unmount, can set state on unmounted component
useEffect(() => {
  fetch(`/api/users/${id}`)
    .then((r) => r.json())
    .then(setUser);
}, [id]);

// GOOD — cleanup timer
useEffect(() => {
  const interval = setInterval(() => tick(), 1000);
  return () => clearInterval(interval);
}, []);

// GOOD — AbortController for fetch
useEffect(() => {
  const controller = new AbortController();

  async function loadUser(): Promise<void> {
    try {
      const response = await fetch(`/api/users/${id}`, {
        signal: controller.signal,
      });
      const data: User = await response.json();
      setUser(data);
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return; // expected on cleanup
      }
      setError(error);
    }
  }

  void loadUser();
  return () => controller.abort();
}, [id]);

// GOOD — cleanup subscription
useEffect(() => {
  const subscription = eventBus.subscribe("update", handleUpdate);
  return () => subscription.unsubscribe();
}, [handleUpdate]);
```

### Key prop — no array index for dynamic lists (MAJOR)

Using array indices as keys causes bugs when items are reordered, inserted, or removed.

```tsx
// BAD — index as key for dynamic list
{items.map((item, index) => (
  <ListItem key={index} item={item} />
))}

// GOOD — stable unique identifier
{items.map((item) => (
  <ListItem key={item.id} item={item} />
))}

// ACCEPTABLE — index for static, never-reordered lists
{staticLabels.map((label, index) => (
  <span key={index}>{label}</span>
))}
```

### Error boundaries for graceful failure (MAJOR)

Wrap component trees with error boundaries to prevent full-app crashes.

```tsx
// Class-based error boundary (or use react-error-boundary package)
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  fallback: ReactNode;
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    logger.error("Component error", { error, componentStack: info.componentStack });
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

// Usage
function App() {
  return (
    <ErrorBoundary fallback={<p>Something went wrong.</p>}>
      <Dashboard />
    </ErrorBoundary>
  );
}
```

```tsx
// Using react-error-boundary (recommended)
import { ErrorBoundary } from "react-error-boundary";

function App() {
  return (
    <ErrorBoundary
      fallback={<p>Something went wrong.</p>}
      onError={(error, info) => {
        logger.error("Component error", { error, componentStack: info.componentStack });
      }}
    >
      <Dashboard />
    </ErrorBoundary>
  );
}
```

### Avoid state updates after unmount (MAJOR)

Use AbortController or cancelled flags to prevent state updates on unmounted components.

```tsx
// GOOD — cancelled flag pattern
useEffect(() => {
  let cancelled = false;

  async function load(): Promise<void> {
    const data = await fetchData(id);
    if (!cancelled) {
      setData(data);
    }
  }

  void load();
  return () => {
    cancelled = true;
  };
}, [id]);
```

---

## Performance

### Memoization — useMemo and useCallback (MAJOR)

Only memoize when there is a measured performance benefit. Do not memoize everything by default.

**When to use useMemo:**
- Expensive computations (filtering/sorting large arrays)
- Objects/arrays passed as dependencies to child components wrapped in `React.memo`

**When to use useCallback:**
- Functions passed to memoized child components
- Functions used in dependency arrays of other hooks

```tsx
// BAD — unnecessary memoization
const value = useMemo(() => a + b, [a, b]); // addition is cheap

// GOOD — expensive computation
const sortedItems = useMemo(
  () => items.filter(predicate).sort(comparator),
  [items, predicate, comparator],
);

// GOOD — stable reference for memoized child
const handleClick = useCallback(
  (id: string) => {
    setSelected(id);
  },
  [setSelected],
);

return <MemoizedList items={sortedItems} onItemClick={handleClick} />;
```

### Stable references — avoid object/array creation in render (MAJOR)

Creating new objects or arrays in render causes child components to re-render unnecessarily.

```tsx
// BAD — new object every render
function Parent() {
  return <Child style={{ color: "red" }} />;
}

// BAD — new array every render
function Parent() {
  return <Child items={[1, 2, 3]} />;
}

// GOOD — stable reference
const redStyle = { color: "red" } as const;
const defaultItems = [1, 2, 3] as const;

function Parent() {
  return <Child style={redStyle} items={defaultItems} />;
}

// GOOD — useMemo for dynamic values
function Parent({ color }: { color: string }) {
  const style = useMemo(() => ({ color }), [color]);
  return <Child style={style} />;
}
```

### React.lazy and Suspense for code splitting (MINOR)

Lazy-load components that are not needed on initial render.

```tsx
import { lazy, Suspense } from "react";

const AdminDashboard = lazy(() => import("./AdminDashboard"));

function App() {
  return (
    <Suspense fallback={<LoadingSpinner />}>
      {isAdmin && <AdminDashboard />}
    </Suspense>
  );
}
```

### Virtualize long lists (MINOR)

For lists with hundreds or thousands of items, use virtualization to only render visible items.

```tsx
// Use libraries like @tanstack/react-virtual, react-window, or react-virtualized
import { useVirtualizer } from "@tanstack/react-virtual";

function VirtualList({ items }: { items: Item[] }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 50,
  });

  return (
    <div ref={parentRef} style={{ overflow: "auto", height: 400 }}>
      <div style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtualRow) => (
          <div
            key={virtualRow.key}
            style={{
              position: "absolute",
              top: virtualRow.start,
              height: virtualRow.size,
            }}
          >
            <ItemRow item={items[virtualRow.index]!} />
          </div>
        ))}
      </div>
    </div>
  );
}
```

### Prefer composition over prop drilling (MAJOR)

Pass components as children or render props instead of drilling data through many layers.

```tsx
// BAD — prop drilling through 3+ levels
function App() {
  const [user, setUser] = useState<User | null>(null);
  return <Layout user={user} />;
}
function Layout({ user }: { user: User | null }) {
  return <Sidebar user={user} />;
}
function Sidebar({ user }: { user: User | null }) {
  return <UserProfile user={user} />;
}

// GOOD — composition with children
function App() {
  const [user, setUser] = useState<User | null>(null);
  return (
    <Layout sidebar={<UserProfile user={user} />}>
      <MainContent />
    </Layout>
  );
}

// GOOD — context for truly global state
const UserContext = createContext<User | null>(null);

function App() {
  const [user, setUser] = useState<User | null>(null);
  return (
    <UserContext.Provider value={user}>
      <Layout />
    </UserContext.Provider>
  );
}

function UserProfile() {
  const user = useContext(UserContext);
  if (!user) return null;
  return <div>{user.name}</div>;
}
```

---

## Maintainability

### PascalCase components, use-prefixed hooks (MINOR)

```tsx
// BAD
function userProfile() { ... }  // lowercase — React treats as HTML element
function getUserData() { ... }  // not use-prefixed for a hook

// GOOD
function UserProfile() { ... }  // PascalCase component
function useUserData() { ... }  // use-prefixed custom hook
```

### Function components only (MINOR)

Use function components for all new code. Class components are only needed for error boundaries (or use react-error-boundary).

```tsx
// BAD — class component
class UserProfile extends React.Component<Props> {
  render() {
    return <div>{this.props.name}</div>;
  }
}

// GOOD — function component
function UserProfile({ name }: Props) {
  return <div>{name}</div>;
}
```

### Extract custom hooks for reusable logic (MAJOR)

When logic is shared between components, extract it into a custom hook.

```tsx
// GOOD — reusable data fetching hook
function useFetch<T>(url: string): {
  data: T | null;
  loading: boolean;
  error: Error | null;
} {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    async function load(): Promise<void> {
      try {
        setLoading(true);
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const result: T = await response.json();
        setData(result);
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        setLoading(false);
      }
    }

    void load();
    return () => controller.abort();
  }, [url]);

  return { data, loading, error };
}
```

### Props typing with interfaces (MAJOR)

Define props as named interfaces, not inline types.

```tsx
// BAD — inline props
function UserCard({ name, email }: { name: string; email: string }) {
  return <div>{name} ({email})</div>;
}

// GOOD — named interface
interface UserCardProps {
  name: string;
  email: string;
  onSelect?: (email: string) => void;
}

function UserCard({ name, email, onSelect }: UserCardProps) {
  return (
    <div onClick={() => onSelect?.(email)}>
      {name} ({email})
    </div>
  );
}
```

### One component per file (MINOR)

Each component should be in its own file. Small helper components used only by the parent are acceptable exceptions.

```
// GOOD — file structure
components/
  UserCard/
    UserCard.tsx
    UserCard.test.tsx
  UserList/
    UserList.tsx
    UserList.test.tsx
```

### Composition over inheritance (MAJOR)

React strongly favors composition. Never extend component classes for code reuse.

```tsx
// BAD — inheritance
class SpecialButton extends Button {
  render() {
    return <button className="special">{this.props.children}</button>;
  }
}

// GOOD — composition
function SpecialButton({ children, ...props }: ButtonProps) {
  return (
    <Button className="special" {...props}>
      {children}
    </Button>
  );
}
```

---

## Accessibility

### Semantic HTML over div/span (MAJOR)

Use appropriate HTML elements for their semantic meaning.

```tsx
// BAD — div soup
<div onClick={handleClick}>Click me</div>
<div className="header">Page Title</div>
<div className="nav">
  <div onClick={() => navigate("/home")}>Home</div>
</div>

// GOOD — semantic elements
<button onClick={handleClick} type="button">Click me</button>
<h1>Page Title</h1>
<nav>
  <a href="/home">Home</a>
</nav>
```

### ARIA attributes when semantic HTML is not enough (MAJOR)

```tsx
// GOOD — aria for custom components
function ToggleSwitch({ checked, onChange, label }: ToggleSwitchProps) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      type="button"
    >
      <span className={checked ? "on" : "off"} />
    </button>
  );
}

// GOOD — aria-live for dynamic content
function StatusMessage({ message }: { message: string }) {
  return (
    <div role="status" aria-live="polite">
      {message}
    </div>
  );
}

// GOOD — aria for loading states
function DataTable({ loading, data }: DataTableProps) {
  return (
    <table aria-busy={loading}>
      <tbody>
        {data.map((row) => (
          <tr key={row.id}>
            <td>{row.name}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

### Keyboard navigation support (MAJOR)

Interactive elements must be keyboard accessible.

```tsx
// BAD — click-only, no keyboard support
<div onClick={handleAction} className="card">
  Card content
</div>

// GOOD — keyboard accessible
<div
  onClick={handleAction}
  onKeyDown={(e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleAction();
    }
  }}
  role="button"
  tabIndex={0}
>
  Card content
</div>

// BEST — just use a button
<button onClick={handleAction} type="button" className="card">
  Card content
</button>
```

### Alt text for images (MAJOR)

```tsx
// BAD — missing alt
<img src={user.avatar} />

// BAD — non-descriptive alt
<img src={user.avatar} alt="image" />

// GOOD — descriptive alt
<img src={user.avatar} alt={`${user.name}'s profile photo`} />

// GOOD — decorative image
<img src="/divider.svg" alt="" role="presentation" />
```

### Form accessibility (MAJOR)

```tsx
// BAD — no label association
<input type="email" placeholder="Email" />

// GOOD — explicit label
<label htmlFor="email">Email</label>
<input id="email" type="email" aria-required="true" />

// GOOD — error messages linked to input
<label htmlFor="email">Email</label>
<input
  id="email"
  type="email"
  aria-invalid={!!error}
  aria-describedby={error ? "email-error" : undefined}
/>
{error && (
  <span id="email-error" role="alert">
    {error}
  </span>
)}
```

---

## Tooling integration

### eslint-plugin-react-hooks

Enforces the Rules of Hooks and dependency array correctness.

```javascript
// eslint.config.mjs
import reactHooks from "eslint-plugin-react-hooks";

export default [
  {
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
];
```

### eslint-plugin-jsx-a11y

Catches accessibility issues in JSX.

```javascript
// eslint.config.mjs
import jsxA11y from "eslint-plugin-jsx-a11y";

export default [
  jsxA11y.flatConfigs.recommended,
];
```

### React DevTools Profiler

Use the React DevTools Profiler to identify unnecessary re-renders and performance bottlenecks. Do not pre-optimize — measure first.

### Testing with React Testing Library

Prefer testing user interactions over implementation details.

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

test("submits form with valid data", async () => {
  const onSubmit = vi.fn();
  render(<ContactForm onSubmit={onSubmit} />);

  await userEvent.type(screen.getByLabelText("Name"), "Alice");
  await userEvent.type(screen.getByLabelText("Email"), "alice@example.com");
  await userEvent.click(screen.getByRole("button", { name: "Submit" }));

  expect(onSubmit).toHaveBeenCalledWith({
    name: "Alice",
    email: "alice@example.com",
  });
});
```

---

## Checklist for new React components

When writing a new React component, verify:

**Security:**
- [ ] No `dangerouslySetInnerHTML` without DOMPurify sanitization
- [ ] URLs in `href`/`src` validated (no `javascript:` protocol)
- [ ] User content rendered via React's default escaping (not raw HTML)
- [ ] No user-controlled props spread (`{...userProps}`)

**Hooks and reliability:**
- [ ] All hooks called at top level (not inside conditions, loops, or nested functions)
- [ ] `useEffect` dependency arrays include all referenced scope values
- [ ] `useEffect` returns cleanup function for subscriptions, timers, and fetch
- [ ] Fetch uses `AbortController` for cleanup
- [ ] Keys on list items use stable unique IDs (not array index for dynamic lists)
- [ ] Error boundary wraps component subtrees that may throw
- [ ] No state updates on unmounted components

**Performance:**
- [ ] `useMemo`/`useCallback` used only where measured benefit exists
- [ ] No new object/array literals in JSX props (use constants or useMemo)
- [ ] Large lists use virtualization
- [ ] Code-split with `React.lazy` for non-critical routes/components

**Accessibility:**
- [ ] Semantic HTML elements used (button, nav, main, section, etc.)
- [ ] Images have descriptive `alt` text (or `alt=""` for decorative)
- [ ] Form inputs have associated labels
- [ ] Interactive custom elements have `role`, `tabIndex`, and keyboard handlers
- [ ] Dynamic content uses `aria-live` regions
- [ ] Error states linked to inputs via `aria-describedby`

**Maintainability:**
- [ ] Component is PascalCase, hooks are `use`-prefixed
- [ ] Function component (not class)
- [ ] Props defined as named interface
- [ ] Reusable logic extracted to custom hooks
- [ ] One primary component per file
- [ ] Composition used instead of prop drilling (children, context)

## Checklist for component review

When reviewing React components, additionally check:

- [ ] No XSS via `dangerouslySetInnerHTML` or innerHTML
- [ ] No unsanitized URLs in href/src
- [ ] Rules of Hooks followed (no conditional hooks)
- [ ] Effect dependencies are correct (no missing deps)
- [ ] Effects clean up on unmount
- [ ] No unnecessary re-renders (stable references, proper memoization)
- [ ] Accessibility: keyboard navigation, screen reader support
- [ ] Error boundaries present for component subtrees
- [ ] No prop drilling beyond 2-3 levels
