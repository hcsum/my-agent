# web-access-multi-browsers

An agent skill for real browser-based web access, built around `SKILL.md`, a local CDP proxy, and a multi-runtime browser layer.

This repository is designed for agents that need more than plain search and fetch. It gives them a repeatable way to:

- choose the right web access path
- connect to a real logged-in browser session
- operate a dedicated automation browser
- fall back to a remote cloud browser runtime
- reuse site-specific operational knowledge

## Acknowledgement

This repository is based on the original `web-access` project by Eze:

https://github.com/eze-is/web-access

The original repository established the core idea that a web skill should include both browsing capability and durable operating guidance for agents. This repository keeps that direction, while changing the browser architecture and the setup flow for a multi-browser, multi-runtime environment.

## What Is Different From `eze-is/web-access`

This repository is not a drop-in mirror. It is a focused variant with different browser assumptions and a different runtime design.

### 1. Provider and mode are modeled separately

This repository does not treat `primary`, `dedicated`, and `remote` as three sibling choices.

Instead, it uses a two-level model:

- choose a `provider` first
- choose a `mode` only if the provider is local

The resulting structure is:

- `local` provider
  - `primary` mode
  - `dedicated` mode
- `browserbase` provider
  - remote browser runtime

This keeps the mental model aligned with the implementation.

### 2. Primary and dedicated browsers are first-class local modes

The upstream project is centered on connecting to the user's everyday browser session. This repository explicitly models two local modes:

- `primary`: connect to the user's normal browser session and reuse its login state
- `dedicated`: connect to an isolated browser profile created only for automation

When both are discoverable, this repository first attempts `primary` and uses it if the agent can connect immediately. If `primary` still needs remote-debugging confirmation or cannot be used right away, it falls back to `dedicated`.

### 3. Multi-browser local discovery instead of a single preferred browser path

This repository can discover and use multiple Chromium-family browsers through stable `browser-id` values:

- `chrome`
- `chrome-canary`
- `chromium`
- `brave`
- `edge`
- `arc`

Dedicated browser profiles are normalized to:

```text
$HOME/.web-access/<browser-id>-dedicated-profile
```

That makes setup and troubleshooting more predictable across machines.

### 4. Availability is decided from live state, not remembered preference

This version intentionally does not persist a browser preference file. It checks live availability at runtime by inspecting `DevToolsActivePort` and current connectivity, then returns a structured result.

This is a deliberate design choice:

- fewer hidden state bugs
- fewer stale preference issues
- easier reasoning for the agent
- easier debugging for humans

### 5. A provider abstraction is built into the runtime layer

This repository separates browser access into providers:

- local CDP browser access
- Browserbase cloud browser access

The agent-facing API stays the same across providers, so the skill can keep one operational model while swapping runtimes underneath.

### 6. Preflight is machine-readable first

`check-deps.mjs` returns structured JSON, not only human-oriented text. The skill instructions are written to consume fields such as:

- `ok`
- `provider`
- `selectedMode`
- `availableModes`
- `selectedBecause`
- `browserId`
- `proxyReady`

That makes the preflight step suitable for autonomous agent decisions instead of forcing the agent to parse ad hoc logs.

### 7. The repository is slimmer and more runtime-oriented

Compared with the upstream repository, this version is organized more directly around the runtime implementation:

- browser detection
- runtime selection
- proxy lifecycle
- site-pattern references

It is less focused on packaging layers and more focused on the browser execution path itself.

## Repository Structure

```text
.
├── SKILL.md
├── scripts
│   ├── check-deps.mjs
│   ├── cdp-proxy.mjs
│   ├── find-url.mjs
│   ├── match-site.mjs
│   └── browser-runtime
│       ├── index.mjs
│       ├── cdp-runtime.mjs
│       ├── playwright-runtime.mjs
│       ├── provider-resolver.mjs
│       └── providers
│           ├── local.mjs
│           └── browserbase.mjs
└── references
    ├── cdp-api.md
    └── site-patterns
        ├── ahrefs.com.md
        ├── ftchinese.com.md
        └── xiaohongshu.com.md
```

## Browser Access Model

The browser structure in this repository is:

- `provider`
  - `local`
  - `browserbase`
- `mode`
  - `primary` for local browser reuse
  - `dedicated` for local isolated automation

`browserbase` is a remote provider, not a third local mode.

This distinction matters because the selection logic, runtime creation, and switching behavior all follow it.

## Selection Rules

The runtime is selected in this order:

1. Choose the provider.
2. If the provider is `local`, choose the mode.
3. Start or reuse the proxy for that exact runtime choice.

In practical terms:

- if Browserbase credentials are configured, the provider is `browserbase`
- otherwise the provider is `local`
- within `local`, explicit mode requests win
- if no local mode is explicitly requested, the runtime checks live availability
- auto mode first tries `primary`; if it is not immediately usable, it falls back to `dedicated`

This is why the repository talks about `provider` and `mode` separately instead of flattening everything into one list of browser types.

## Switching Behavior

Runtime switching is explicit.

- switching between `primary` and `dedicated` is a local-mode switch
- switching between `local` and `browserbase` is a provider switch
- any switch recreates the active runtime behind the proxy
- after a switch, old target IDs should be treated as invalid

The proxy is therefore stable as an interface, but not as a promise that browser state identifiers survive a runtime change.

## How The Pieces Fit Together

### `SKILL.md`

The operational manual for the agent.

It does not just list commands. It tells the agent:

- when to run preflight
- when to ask the user for browser intervention
- when to use `primary` versus `dedicated`
- how to reason about page interaction
- how to use site-pattern references

### `scripts/check-deps.mjs`

The entry point for environment detection.

Its job is to:

- validate runtime requirements
- resolve the browser provider
- detect available local browser modes
- start or reuse the proxy
- return a machine-readable status object

This is the script an agent should run first.

### `scripts/cdp-proxy.mjs`

The stable HTTP bridge exposed to the agent.

Instead of forcing the agent to manage raw WebSocket CDP traffic, the proxy exposes a smaller HTTP API for:

- listing targets
- opening tabs
- navigation
- evaluation
- clicking
- scrolling
- screenshots
- file uploads

The proxy keeps the browser-specific complexity behind one consistent interface.

### `scripts/browser-runtime/*`

The runtime abstraction layer.

This folder exists so the rest of the skill can think in terms of browser actions instead of provider-specific wiring.

- `index.mjs`: resolves runtime availability and constructs the active runtime
- `provider-resolver.mjs`: parses environment configuration into a runtime choice
- `providers/local.mjs`: finds local browser instances from `DevToolsActivePort`
- `providers/browserbase.mjs`: creates and releases Browserbase sessions
- `cdp-runtime.mjs`: local runtime backed by raw CDP over WebSocket
- `playwright-runtime.mjs`: cloud runtime backed by Playwright over Browserbase CDP

### `scripts/find-url.mjs`

Local bookmark and history lookup.

This is useful when the target is not easily discoverable from public search, for example:

- internal systems
- admin dashboards
- previously visited pages
- a site the user remembers by topic but not by URL

### `scripts/match-site.mjs`

A lightweight matcher that loads domain-specific notes from `references/site-patterns/`.

It lets the skill inject known platform facts without hardcoding site behavior into the main instructions or the runtime code.

### `references/site-patterns/*`

Durable knowledge files for specific sites.

These files are intentionally data-like rather than code-like. They hold:

- URL patterns
- success signals
- common traps
- domain-specific workflow notes

That keeps site knowledge editable without changing runtime logic.

## Design Decisions

### Machine-readable preflight over informal logs

The first decision point in browser automation is not "what page should I open?" but "what browser path is actually available right now?"

That is why preflight returns structured JSON. The agent can make reliable branching decisions without guessing from free-form output.

### Immediate primary, otherwise dedicated

The repository distinguishes between a browser being merely discoverable and being immediately usable by the agent.

- `primary` is preferred when it is already authorized and can be used right away
- `dedicated` is the fallback when `primary` still needs a permission confirmation or cannot be connected to immediately
- `dedicated` remains useful for long-running isolated automation once the task explicitly prefers that path

This keeps auto mode aligned with real session availability instead of only weak detection signals.

### Explicit user intervention only when needed

If preflight succeeds, the agent should continue without asking the user to choose a mode again. If preflight fails, the instructions require the agent to explain the actual tradeoff before asking for help.

This keeps the system autonomous when it can be, and explicit when it must be.

### Local browsers use direct CDP; cloud browsers use Playwright

For local browsers, raw CDP keeps the stack thinner and preserves direct access to the user's actual browser session.

For Browserbase, Playwright is a practical adapter because session lifecycle and page management are cleaner in a cloud context.

The result is a shared action surface with different internals where that is appropriate.

### Site knowledge stays outside the runtime

A browser runtime should know how to operate pages. It should not contain per-site business logic.

This repository keeps platform-specific knowledge in `references/site-patterns/` so it can evolve independently from the automation engine.

### One proxy, one active browser binding

The proxy is intentionally global and bound to one runtime at a time. Switching between `primary`, `dedicated`, or `browserbase` is treated as a runtime switch, not as an incidental flag flip.

This makes the model easier to reason about:

- one proxy process
- one active browser target space
- explicit mode switching
- predictable invalidation of old target IDs after a switch

## Requirements

- Node.js 22+ recommended
- a Chromium-based browser for local mode, or Browserbase credentials for cloud mode
- permission to enable remote debugging when using local `primary` mode

## Local Provider Setup

### Primary mode

Open the browser's remote debugging page and enable remote debugging for that browser instance.

Examples:

- Chrome: `chrome://inspect/#remote-debugging`
- Edge: `edge://inspect/#remote-debugging`

### Dedicated mode

Start a separate Chromium-family browser instance with a stable profile directory:

```bash
open -na "Brave Browser" --args \
  --remote-debugging-port=9333 \
  --user-data-dir="$HOME/.web-access/brave-dedicated-profile"
```

Then run:

```bash
node ./scripts/check-deps.mjs --browser dedicated --browser-id brave
```

## Remote Provider Support

Yes. This repository supports a remote browser runtime through Browserbase.

That means the skill is not limited to a browser running on the same machine. If Browserbase credentials are present, the runtime layer can create a cloud browser session and expose it through the same proxy API used by local browser modes.

### When the remote provider is useful

- the agent is running in a container or remote environment without reliable access to a local browser
- you want browser isolation without managing a dedicated local profile
- you want a fallback when local CDP access is unavailable
- you want the same agent workflow to run on another machine or CI-like environment

### How the remote provider is selected

The remote provider is selected when Browserbase credentials are available in the environment.

Expected environment variables:

```bash
BROWSERBASE_API_KEY=...
BROWSERBASE_PROJECT_ID=...
```

Optional variables supported by the runtime layer include:

```bash
BROWSERBASE_CONTEXT_ID=...
BROWSERBASE_CONTEXT_PERSIST=true
BROWSERBASE_USE_PROXY=true
BROWSERBASE_SOLVE_CAPTCHA=true
BROWSERBASE_VERIFIED=true
BROWSERBASE_REGION=...
BROWSERBASE_SESSION_TIMEOUT_SEC=600
```

Then run the usual preflight:

```bash
node ./scripts/check-deps.mjs
```

If the remote provider is active, the returned JSON will report:

- `provider: "browserbase"`
- `selectedMode: "browserbase"`

### Why the remote provider is implemented this way

Remote browser support is intentionally implemented as a provider, not as a separate skill.

That design keeps these parts stable:

- the preflight entrypoint
- the proxy API
- the agent workflow
- the site-pattern knowledge layer

Only the runtime backend changes.

## Quick Start

Clone the repository into the skill directory used by your agent environment, then run:

```bash
node ./scripts/check-deps.mjs
```

If the returned JSON says `ok: true`, the agent can continue and use the proxy-backed browser workflow.

## Why This Repository Exists

The upstream project is already useful. This repository exists because the browser problem changed:

- agents often need isolated automation profiles, not only the user's daily browser
- teams may use different Chromium-family browsers on different machines
- cloud browser fallback is increasingly practical
- autonomous agents benefit from structured runtime decisions, not prose-only setup output

So this repository narrows its focus to one goal: make browser availability, browser selection, and browser control easier for an agent to reason about.

## Installation

Clone this repository into the skill directory used by your agent environment.

Example:

```bash
git clone https://github.com/hcsum/web-access-multi-browsers ~/.claude/skills/web-access
```

## License

MIT
