# Portable Morpheus

A framework-agnostic, standalone version of **Morpheus** — the AI build mentor from the Matrix-themed NebulaCode platform.

Morpheus chats with an operator in character, reasons about what they want to build, then runs a **two-phase build pipeline** (planner → coder → reviewer) to produce real, complete, deployable code files — and commits them to a project. No Base44, no database, no vendor lock-in. Bring your own OpenAI-compatible LLM.

## What it does

- **Chat** — talk to Morpheus in his calm, concise, Matrix-mentor voice.
- **Plan** — the planner agent reasons about intent: is this a build request or a conversation? Does it need clarification?
- **Code** — the coder agent implements a precise file-by-file plan as complete, production-ready code (no placeholders, no TODOs).
- **Review** — the reviewer agent checks the output for correctness, security, and performance before commit, and gives the coder one retry pass on critical issues.
- **Commit** — file operations (create / update / delete) are applied to the project's file store.
- **Export** — download the whole project as a ZIP.

## Structure

```
portable-morpheus/
  server/
    index.js        Express API server
    morpheus.js     Core orchestrator (chat → plan → code → review → commit)
    llm.js          OpenAI-compatible LLM client
    store.js        File-based JSON store (no database)
    reviewer.js     Review-and-retry loop
  client/
    api.js          Fetch client for the server
    Morpheus.jsx    Drop-in React page
    MorpheusPanel.jsx  Self-contained chat + file panel (no UI deps)
```

## Run the server

```bash
cd portable-morpheus
npm install
npm start
```

Needs Node >= 20, `express`, `jszip`.

### Environment

| Var | Default | Purpose |
|-----|---------|---------|
| `MORPHEUS_PORT` | `4500` | Server port |
| `MORPHEUS_DATA_DIR` | `./.morpheus-data` | Where projects are stored |
| `MORPHEUS_CORS_ORIGIN` | `*` | CORS origin |
| `LLM_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible endpoint |
| `LLM_API_KEY` | — | Bearer token (falls back to `OPENAI_API_KEY`) |
| `LLM_MODEL` | `gpt-4o-mini` | Default model |
| `LLM_PLANNER_MODEL` | — | Override for the planning agent (high think power) |
| `LLM_CODER_MODEL` | — | Override for the coding agent (fast) |
| `LLM_REVIEWER_MODEL` | — | Override for the review agent |

Works with OpenAI, OpenRouter, Together, Groq, or any local server (Ollama / LM Studio in OpenAI-compat mode).

## API

```
GET    /morpheus/projects                  list projects
POST   /morpheus/projects                   { name, description, compileTarget } → project
GET    /morpheus/projects/:id               project + files + messages
DELETE /morpheus/projects/:id               delete project
GET    /morpheus/projects/:id/files         files
GET    /morpheus/projects/:id/messages      chat history
POST   /morpheus/projects/:id/chat          { message, fileUrls } → { reply, fileOperations, needsClarification }
GET    /morpheus/projects/:id/zip           download project as ZIP
```

## Use the client in any React app

```jsx
import Morpheus from 'portable-morpheus/client/Morpheus.jsx';

// point at your deployed server before mounting
window.MORPHEUS_API_BASE = 'https://api.yourapp.com/morpheus';

<Route path="/morpheus" element={<Morpheus />} />
```

Or mount the panel directly:

```jsx
import MorpheusPanel from 'portable-morpheus/client/MorpheusPanel.jsx';
<MorpheusPanel projectId="..." />
```

The panel is self-contained — inline CSS, no external UI dependencies, Matrix-themed.

## Compile targets

Morpheus understands the same compile targets as the full platform: `source`, `windows-exe`, `mac-app`, `linux-binary`, `android-apk`, `ios-app`, `python-package`, `web-app`, `rpi-distro`, `arduino-firmware`. When set to anything other than `source`, the coder includes the appropriate build configuration (pkg, PyInstaller, Gradle, Swift, pi-gen, PlatformIO, etc.) so the operator can build the artifact on their own machine.