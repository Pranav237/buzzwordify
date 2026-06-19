# PRD: Buzzwordify - Chrome/Edge Extension

## 1. Overview

Buzzwordify is a browser extension that transforms highlighted text into pompous, over-technical corporate/scientific bombast. The user highlights text on any page, presses a keyboard shortcut, and the selection is either **replaced in place** (if editable) or shown in an **overlay** (if read-only).

The humor comes from the *mismatch* between mundane input and inflated language, grounded in real properties of the thing - not random buzzword salad. Example: "bread" → "a thermally-catalyzed restructuring of glutenin networks into a load-bearing colloidal architecture."

**Target browsers:** Chrome and Edge (both Chromium, Manifest V3 - single codebase). Safari is explicitly out of scope.

**Non-goals:** No templating engine (the LLM does all transformation). No system-wide/OS-level selection. No user accounts. No persistence beyond local settings.

---

## 2. Architecture

Three components:

1. **Content script** - injected into pages. Detects selection, detects editable-vs-readonly context, performs replace or renders overlay.
2. **Background service worker** - registers the keyboard command, receives the selected text from the content script, calls the backend, returns the result.
3. **Backend proxy** - a tiny server (one route) that holds the Anthropic API key and makes the LLM call. The extension never holds the key.

### Data flow
```
highlight text
  → press shortcut (commands API fires in background worker)
  → worker asks content script for current selection + editability
  → worker POSTs selection to backend /buzzwordify
  → backend prompts the model, returns transformed string
  → worker sends string back to content script
  → content script replaces (editable) or overlays (read-only)
```

### Why a backend at all
A shipped extension cannot safely hold an API key. The backend exists ONLY as a thin proxy: receive text, call the model, return text. No database, no auth, no business logic beyond the prompt.

---

## 3. Build order (de-risk first)

**Build and validate the backend + prompt BEFORE the extension.** The prompt is the product; if the humor doesn't land, the extension is scaffolding around a dud. Phase 1 must be testable from the command line with sample inputs.

### Phase 1 - Backend + prompt (validate humor here)
- Node + Express (or Fastify) server, single route `POST /buzzwordify`.
- Request body: `{ "text": "string" }`. Response: `{ "result": "string" }`.
- Loads `ANTHROPIC_API_KEY` from environment (use `dotenv`, never commit the key).
- Calls Anthropic Messages API (see §4).
- Include a CLI test script (`npm run test:prompt`) that pipes ~10 hardcoded sample strings through the route and prints results, so the humor can be eyeballed before any extension work.
- CORS configured to allow the extension origin.

### Phase 2 - Extension shell
- MV3 `manifest.json` with: `commands` (the shortcut), `content_scripts`, `background` service worker, `activeTab` + `scripting` permissions, host permission for the backend URL.
- Background worker: register command listener, message-passing with content script, fetch to backend.
- Content script: selection detection, editability detection, replace logic, overlay rendering.

### Phase 3 - Polish
- Loading state (overlay shows a spinner while the LLM call is in flight; replace mode shows nothing until result returns, then swaps).
- Error states (see §6).
- Options page for backend URL + shortcut reminder.

---

## 4. Backend: Anthropic API specifics

**VERIFIED CURRENT (June 2026) - use exactly:**

- Endpoint: `POST https://api.anthropic.com/v1/messages`
- Required headers:
  - `x-api-key: <key from env>`
  - `anthropic-version: 2023-06-01`
  - `content-type: application/json`
- Model: `claude-haiku-4-5` - cheap, fast, sufficient for a gag tool. Latency matters more than reasoning depth here. (Do NOT use Opus; it's overkill and slow for this.)
- `max_tokens`: 300 (output is short by design).
- Do NOT use LangChain or any orchestration framework. This is one stateless call - a single `fetch`. The prompt is the one knob worth keeping direct access to.

### Request shape
```js
const res = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "x-api-key": process.env.ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  },
  body: JSON.stringify({
    model: "claude-haiku-4-5",
    max_tokens: 300,
    system: SYSTEM_PROMPT,          // see §5
    messages: [{ role: "user", content: userText }],
  }),
});
const data = await res.json();
const result = data.content[0].text;   // text lives in content[0].text
```

---

## 5. The prompt (the actual product)

The voice is a specific character: someone who genuinely cannot describe anything simply, who inflates every mundane thing into a technical or corporate epic - and *commits*, never winking at the bit.

**Three required properties of the output:**
1. **Grounded** - built on real properties of the input (bread really is a Maillard reaction; a meeting really is information exchange). The nonsense must be anchored in something true, so it reads like a real over-explainer, not a random word generator.
2. **Escalating** - start plausible, end unhinged. The arc from "thermally-catalyzed restructuring of glutenin networks" (true-ish) to "load-bearing achievement in colloidal architecture" (insane) is the joke.
3. **Committed** - deadpan. No "haha just kidding," no acknowledging absurdity. Total sincerity.

Draft system prompt (tune this - it IS the product):

```
You are a corporate/scientific bombast generator. Given any text, rewrite it
using maximally inflated technical, scientific, and corporate-strategic
language. Rules:

- Ground the inflation in REAL properties of the subject. Do not invent random
  buzzwords; escalate from something actually true about the thing.
- Build an arc: begin plausibly technical, end completely unhinged - but keep
  every step deadpan and sincere.
- Never acknowledge the absurdity. Never break character. No jokes, no winking.
- Match the length roughly to the input. A short phrase gets 1-2 sentences; a
  sentence gets 2-3.
- Output ONLY the rewritten text. No preamble, no quotes, no explanation.
```

Phase 1 must test this against varied inputs (a single noun, a full sentence, a Slack-style message, a recipe step) and the output tuned until it reliably lands.

---

## 6. Edge cases & error handling

- **Empty selection:** shortcut fires with nothing selected → no-op, optionally a brief toast "Highlight some text first."
- **Editability detection:** walk up from the selection's anchor node. Editable if inside `<input>`, `<textarea>`, or an element where `isContentEditable` is true. Otherwise read-only → overlay.
- **Replace in editable fields:** for `<input>`/`<textarea>`, splice using `selectionStart`/`selectionEnd` on the element value. For `contenteditable`, use the Selection/Range API to delete contents and insert the new text node. Preserve surrounding text - do not nuke the whole field.
- **Overlay positioning:** anchor near the selection's bounding rect (`range.getBoundingClientRect()`); keep it on-screen; dismiss on click-away or Esc.
- **Backend down / network error:** overlay or toast shows "Couldn't reach the buzzword engine." Never silently fail; never mangle the original text on error (only replace AFTER a successful response).
- **Slow response:** show a loading indicator. In replace mode, do not remove the original text until the result arrives.
- **Site shortcut conflicts:** using the MV3 `commands` API (not a raw keydown listener) avoids most conflicts. Pick a default chord unlikely to collide (e.g. Ctrl+Shift+B / Cmd+Shift+B) and let users rebind via `chrome://extensions/shortcuts`.

---

## 7. File structure (suggested)
```
/backend
  server.js          # Express app, /buzzwordify route
  prompt.js          # SYSTEM_PROMPT export
  test-prompt.js     # CLI humor test (npm run test:prompt)
  .env.example       # ANTHROPIC_API_KEY=
/extension
  manifest.json
  background.js      # command listener + backend fetch + messaging
  content.js         # selection, editability, replace, overlay
  overlay.css
  options.html
  options.js
```

---

## 8. Acceptance criteria

- [ ] Phase 1 CLI test produces reliably funny, grounded, escalating, deadpan output across varied inputs.
- [ ] Backend never exposes the API key to the client.
- [ ] Highlighting in an editable field + shortcut replaces the text in place, preserving surrounding content.
- [ ] Highlighting on a read-only page + shortcut shows an overlay near the selection.
- [ ] Errors and slow responses never destroy the user's original text.
- [ ] Runs unmodified on both Chrome and Edge.
- [ ] No LangChain; backend LLM call is a single fetch.
