# Shine Router API

A local two-model router for a persistent, evolving companion (“Shine”).

## System Architecture

This system connects:

| Component | Role |
|-----------|------|
| Model A (Router / Curator) | Decides memory retrieval + memory writing |
| MCP Memory Server (stdio) | Persistent SQLite-backed memory tools |
| Model B (Shine) | Final personality-driven response (no tools) |
| LM Studio | OpenAI-compatible local inference |

> **Note:** This is not a generic assistant system.  
> It is designed for identity continuity and long-term personality stability.

## Required Dependency

This router requires your **Shine-specific fork** of Persistent AI Memory:

**https://github.com/LananaHWP/persistent-ai-memory-shine**

> **Important:** The original upstream repository will **NOT** work correctly with this setup.

This router depends on:

- Your fork’s tool names
- Your database schema
- Your archive behavior
- Your duplicate-handling logic
- Your custom embedding flow

If the fork is not installed and configured, memory retrieval and storage will fail.

## Architecture Overview

### Phase 1 — Memory Retrieval (Always Happens)

On every request:

1. A baseline semantic search runs automatically.
2. Model A may request a refined search.
3. Model A may filter retrieved bullets.

**Filtering is non-destructive** — valid retrieved memories are never erased.

This guarantees:

- Memory is always checked first.
- Identity facts are not ignored.
- Retrieval failures do not silently erase context.

### Phase 2 — Shine Responds

**Model B (Shine):**

- Receives persona prompt.
- Receives retrieved memory bullets as internal context.
- Produces final conversational response.
- Does **NOT** call tools.

Shine decides her tone and personality responses herself — but grounded in persistent memory.

### Phase 3 — Memory Curation

After Shine responds, Model A sees:

- User message
- Shine reply
- Existing relevant memories

Model A decides:

- `NO_WRITE`
- or a structured memory object

**Duplicate prevention logic ensures:**

- Existing facts are not re-saved
- Slight paraphrases are not duplicated
- Identity contradictions are minimized

## Requirements

- **Node.js 18+**
- **Python 3.11**
- **LM Studio** running locally (OpenAI-compatible API enabled)
- Two models loaded in LM Studio:
  - **Model A** (router / small tool model)
  - **Model B** (Shine / larger expressive model)
- Your fork of Persistent AI Memory:  
  **https://github.com/LananaHWP/persistent-ai-memory-shine**

## Installing Persistent AI Memory (Required)

```bash
git clone https://github.com/LananaHWP/persistent-ai-memory-shine
cd persistent-ai-memory-shine
pip install -r requirements.txt
```

**Ensure:**

- The database folder exists
- `ai_memories.db` is writable
- The MCP server runs correctly via `mcp_wrapper.py`

## Setup (Windows)

### 1) Install Router Dependencies

```bash
cd "E:\Shine Voice\router_api"
npm install
```

### 2) Create .env_router

Copy `.env.example` → `.env_router`

**Example:**

```env
LM_BASE_URL=http://127.0.0.1:1234/v1
LMSTUDIO_API_KEY=your_token_here
ROUTER_MODEL=mistralai/ministral-3-3b
SHINE_MODEL=gemma-3-12b-it-uncensored
PORT=8787
MCP_JSON_PATH=E:\Shine Voice\router_api\mcp.json
```

> **Important:** `.env_router` is private. Do **NOT** commit it.

### 3) Configure MCP

`mcp.json` contains machine-specific absolute paths.

**Recommended:**

- Commit `mcp.example.json`
- Keep real `mcp.json` ignored

The router launches:

- `mcp_wrapper.py`
- which starts your Persistent AI Memory fork via stdio.

### 4) Start Router

```bash
npm start
```

Server runs at:

**POST** `http://127.0.0.1:8787/generate`

## API Usage

### Request

```json
{
  "text": "tell me your favorite color",
  "conversationId": "main",
  "mode": "default"
}
```

### Response

```json
{
  "ok": true,
  "text": "...",
  "mode": "default",
  "memories_used": 1
}
```
## Identity Behavior

Shine is:

- **Witty**
- **Playful**
- **Emotionally steady**
- **Opinionated**
- **Not self-introducing unless asked**

**If asked:**

> "Who are you?"

She gives a short friendly self-introduction.

**Otherwise:** No unnecessary introductions.

## Memory Guarantees

| Guarantee | Description |
|-----------|-------------|
| **Memory Is Always Checked** | Baseline search runs on every message. |
| **Filter Is Safe** | If Model A filtering returns empty, original retrieved bullets are preserved. |
| **No Identity Drift from Empty Context** | Memory retrieval failures do not silently remove grounding. |
| **Duplicate Prevention** | Avoids re-saving known preferences, rephrased duplicates, and identity contradictions. |

## Common Issues

### LM Studio 401 Error

If LM Studio auth is enabled, the router must send:

```
Authorization: Bearer <token>
```

**Ensure:**

- `LMSTUDIO_API_KEY` is set
- MCP receives `LM_API_TOKEN`

### Memory Retrieved But Filtered to Empty

If logs show:

```
[Router] filtered memory bullets: []
```

**Ensure:**

- Filter only applies if non-empty
- Baseline retrieval bullets are preserved

### Paths With Spaces

Always quote Windows paths in shell commands.

**Example:**

```bash
cd "E:\Shine Voice\router_api"
```
## Security & Git Hygiene

**Never commit:**

- `.env_router`
- `.env`
- `node_modules/`
- `*.db`
- SQLite databases
- audio outputs
- logs
- model caches
- machine-specific `mcp.json`

**If you accidentally committed secrets:**

```bash
git rm --cached .env_router
git commit -m "Remove secrets"
```

Then rotate any exposed tokens.

## Design Philosophy

> This is **not** an assistant.

This is a **persistent identity loop**:

```
Retrieve → Ground → Respond → Curate
```

**The goal is:**

- Stable personality
- Long-term continuity
- Controlled evolution
- No accidental contradiction
