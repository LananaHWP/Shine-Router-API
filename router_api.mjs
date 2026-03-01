import fs from "node:fs";
import path from "node:path";
import express from "express";
import OpenAI from "openai";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import dotenv from "dotenv";
dotenv.config({ path: ".env_router" });

/**
 * Load env vars from .env if present (no dependency)
 */
function loadDotEnvIfPresent() {
  const envPath = path.resolve(process.cwd(), ".env_router");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf-8").split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2] ?? "";
    // strip quotes
    val = val.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    if (!process.env[key]) process.env[key] = val;
  }
}
loadDotEnvIfPresent();



// --------------------
// CONFIG
// --------------------
const LM_BASE_URL = process.env.LM_BASE_URL ?? "http://127.0.0.1:1234/v1";
const LMSTUDIO_API_KEY = process.env.LMSTUDIO_API_KEY ?? "";
const MODEL_A = process.env.ROUTER_MODEL ?? "";
const MODEL_B = process.env.SHINE_MODEL ?? "";
const PORT = Number(process.env.PORT ?? "8787");

const MCP_JSON_PATH = process.env.MCP_JSON_PATH ?? path.resolve(process.cwd(), "mcp.json");
const MCP_SERVER_NAME = process.env.MCP_SERVER_NAME ?? "persistent-ai-memory";

const SHINE_PROMPT_PATH =
  process.env.SHINE_PROMPT_PATH ?? path.resolve(process.cwd(), "prompts/shine_persona.json");
  
  console.log("Using MCP_JSON_PATH =", MCP_JSON_PATH);

if (!LMSTUDIO_API_KEY) throw new Error("Missing LMSTUDIO_API_KEY (set in .env or env vars)");
if (!MODEL_A) throw new Error("Missing ROUTER_MODEL (Model A id) (set in .env or env vars)");
if (!MODEL_B) throw new Error("Missing SHINE_MODEL (Model B id) (set in .env or env vars)");
if (!fs.existsSync(MCP_JSON_PATH)) throw new Error(`MCP_JSON_PATH not found: ${MCP_JSON_PATH}`);
if (!fs.existsSync(SHINE_PROMPT_PATH)) throw new Error(`SHINE_PROMPT_PATH not found: ${SHINE_PROMPT_PATH}`);

function normalizeForDedupe(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[#.,:;!?"()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isNearDuplicate(newContent, existingBullets) {
  const n = normalizeForDedupe(newContent);
  if (!n) return true;

  // exact-ish match
  for (const b of existingBullets) {
    const eb = normalizeForDedupe(b);
    if (!eb) continue;

    if (n === eb) return true;

    // containment either way catches paraphrase/expansion like your pink example
    if (n.includes(eb) || eb.includes(n)) return true;
  }

  // special-case: "confirmed/expanded" meta memories are always junk
  if (/\b(confirmed|expanded|previous mentions|from previous|recall|remembered)\b/i.test(newContent)) {
    return true;
  }

  return false;
}

// --------------------
// Emoji strip
// --------------------
const EMOJI_RE =
  /[\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;
const stripEmojis = (s) => String(s ?? "").replace(EMOJI_RE, "").trim();

function buildDefaultMemoryQuery(userText, conversation) {
  const lastUserTurns = [...conversation]
    .filter(m => m.role === "user")
    .slice(-3)
    .map(m => m.content)
    .join(" | ");

  // Keep it short: current message + a little recent context
  return `${userText}${lastUserTurns ? " | recent: " + lastUserTurns : ""}`.slice(0, 800);
}

function safeJsonParse(s) {
  try {
    if (typeof s !== "string") return null;
    let t = s.trim();

    // Strip ```json ... ``` or ``` ... ``` fences
    if (t.startsWith("```")) {
      t = t.replace(/^```[a-zA-Z]*\s*/, "").replace(/```$/, "").trim();
    }

    // Sometimes models add extra text before/after.
    // Try to extract the outermost JSON object OR array.
    const objStart = t.indexOf("{");
    const objEnd = t.lastIndexOf("}");
    const arrStart = t.indexOf("[");
    const arrEnd = t.lastIndexOf("]");

    const hasObj = objStart !== -1 && objEnd !== -1 && objEnd > objStart;
    const hasArr = arrStart !== -1 && arrEnd !== -1 && arrEnd > arrStart;

    if (hasArr && (!hasObj || arrStart < objStart)) {
      t = t.slice(arrStart, arrEnd + 1);
    } else if (hasObj) {
      t = t.slice(objStart, objEnd + 1);
    }

    return JSON.parse(t);
  } catch {
    return null;
  }
}

// --------------------
// Prompt config
// --------------------
const promptCfg = JSON.parse(fs.readFileSync(SHINE_PROMPT_PATH, "utf-8"));

function buildShineSystemPrompt(mode = "default") {
  const persona = (promptCfg.persona ?? []).join("\n");
  const guardrails = (promptCfg.guardrails ?? []).join("\n");
  const modeLines = (promptCfg.modes?.[mode] ?? promptCfg.modes?.default ?? []).join("\n");
  return [persona, "", guardrails, "", "MODE:", modeLines].join("\n").trim();
}

// --------------------
// LM Studio OpenAI-compatible client
// --------------------
const openai = new OpenAI({ baseURL: LM_BASE_URL, apiKey: LMSTUDIO_API_KEY });

// --------------------
// MCP stdio client
// --------------------
function loadMcpServerFromJson() {
  const raw = fs.readFileSync(MCP_JSON_PATH, "utf-8");
  const cfg = JSON.parse(raw);
  const server = cfg?.mcpServers?.[MCP_SERVER_NAME];
  if (!server) throw new Error(`Server '${MCP_SERVER_NAME}' not found in ${MCP_JSON_PATH}`);
  if (!server.command) throw new Error(`mcpServers.${MCP_SERVER_NAME}.command missing`);
  return { command: server.command, args: server.args ?? [] };
}

const { command, args } = loadMcpServerFromJson();

console.log("MCP command =", command);
console.log("MCP args    =", args);

const mcp = new Client({ name: "shine-router-api", version: "0.1.0" });

// Pass the full environment to MCP so it can see tokens/caches/etc.
const mcpEnv = {
  ...process.env,

  // Make sure LM Studio auth token is available to the MCP process
  LM_API_TOKEN: process.env.LM_API_TOKEN || process.env.LMSTUDIO_API_KEY || "",
};

const transport = new StdioClientTransport({ command, args, env: mcpEnv });
await mcp.connect(transport);

const toolsList = await mcp.listTools();
const toolNames = new Set((toolsList?.tools ?? []).map((t) => t.name));
console.log("MCP tools:", [...toolNames].sort().join(", "));

// Extract memory bullets from MCP tool response (common pattern: JSON with results[].data.content)
function extractMemoryBullets(toolResponse) {
  const outerText = toolResponse?.content?.find((c) => c.type === "text")?.text;
  if (!outerText) return [];

  let parsed = safeJsonParse(outerText);

  // Unwrap one nesting level if needed: {content:[{type:"text", text:"{...}"}]}
  if (parsed && !Array.isArray(parsed?.results) && Array.isArray(parsed?.content)) {
    const innerText = parsed.content?.find((c) => c.type === "text")?.text;
    const innerParsed = innerText ? safeJsonParse(innerText) : null;
    if (innerParsed) parsed = innerParsed;
  }

  // Some servers may use {text:"{...}"} wrapper
  if (parsed && !Array.isArray(parsed?.results) && typeof parsed?.text === "string") {
    const innerParsed = safeJsonParse(parsed.text);
    if (innerParsed) parsed = innerParsed;
  }

  const results = Array.isArray(parsed?.results) ? parsed.results : [];
  const bullets = [];

  for (const r of results) {
    const c = r?.data?.content;
    if (typeof c === "string" && c.trim()) bullets.push(c.trim());
  }

  if (!bullets.length) {
    const keys = parsed && typeof parsed === "object" ? Object.keys(parsed).slice(0, 10) : [];
    console.log("[Router] extractMemoryBullets: no bullets; parsed keys:", keys);
  }

  // Fallback: plain text
  if (!bullets.length && typeof outerText === "string") {
    const _lines = outerText.split(String.fromCharCode(10));
 
    for (const line of _lines) {
      const t = line.split(String.fromCharCode(13)).join("").trim();
      if (t) bullets.push(t);
    }
  }

  return bullets;
}

async function search_memories(query, limit = 5) {
  if (!toolNames.has("search_memories")) throw new Error("MCP tool 'search_memories' not available.");
  console.log("[MCP] callTool search_memories:", { query, limit });
  const r = await mcp.callTool({
    name: "search_memories",
    arguments: { query, limit, database_filter: "ai_memories" },
  });
  const _rawText = r?.content?.find((c) => c.type === "text")?.text;
  if (_rawText) console.log("[MCP] search_memories raw response text:", _rawText.slice(0, 800));
  return extractMemoryBullets(r);
}

async function create_memory(mem) {
  if (!toolNames.has("create_memory")) throw new Error("MCP tool 'create_memory' not available.");
  console.log("[MCP] callTool create_memory:", mem);
  return mcp.callTool({ name: "create_memory", arguments: mem });
}

function sanitizeMemoryQuery(q) {
  return String(q ?? "")
    .replace(/^SEARCH:\s*/i, "")
    .trim()
    .replace(/^SEARCH:\s*/i, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\bpast interactions\b/gi, "")
    .replace(/\bprofile data\b/gi, "")
    .replace(/\bmetadata\b/gi, "")
    .replace(/\bprevious interactions\b/gi, "")
    .replace(/\bor\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// --------------------
// Model A: decide search (pre)
// --------------------
async function modelA_decideSearch(userText) {
  const sys = {
    role: "system",
    content: [
      "You are Model A, the routing brain for Shine.",
      "Decide whether to search long-term memory BEFORE Shine answers.",
      "",
      "Search if any are true:",
      "- The user asks about preferences/favorites/likes/dislikes",
      "- The user references past interactions or says 'remember'",
      "- The user provides profile info and retrieval could help",
      "- Continuity would noticeably improve the reply",
      "",
      "Output EXACTLY one line:",
      "SEARCH: <short query>",
      "or",
      "NO_SEARCH",
    ].join("\n"),
  };

  const r = await openai.chat.completions.create({
    model: MODEL_A,
    messages: [sys, { role: "user", content: userText }],
    temperature: 0.2,
  });

  const line = (r.choices?.[0]?.message?.content ?? "").split("\n").find(Boolean)?.trim() ?? "";
  if (/^SEARCH:/i.test(line)) {
    const q = line.split(String.fromCharCode(13)).join("").trim();
    return { shouldSearch: true, query: q || userText };
  }
  return { shouldSearch: false, query: "" };
}

// --------------------
// Model A: filter memory bullets for relevance (pre)
// --------------------
async function modelA_filterMemory(userText, memoryBullets) {
  if (!memoryBullets.length) return [];

  const sys = {
    role: "system",
    content: [
      "You decide which memory bullets are truly relevant to the user's message.",
      "Return a JSON array containing ONLY the exact bullets that should be kept.",
      "If none are relevant, return [].",
      "Do not modify the bullet text.",
      "Do NOT wrap the JSON in markdown or code fences."
    ].join("\n"),
  };

  const mem = {
    role: "user",
    content:
      `USER MESSAGE:\n${userText}\n\n` +
      `MEMORY BULLETS:\n${memoryBullets.map(b => "- " + b).join("\n")}`,
  };

  const r = await openai.chat.completions.create({
    model: MODEL_A,
    messages: [sys, mem],
    temperature: 0.0,
  });

  const parsed = safeJsonParse(r.choices?.[0]?.message?.content ?? "");
  if (!Array.isArray(parsed)) return memoryBullets; // fallback
  return parsed.filter(b => memoryBullets.includes(b));
}

// --------------------
// Model B: Shine answer (no tools)
// --------------------
async function modelB_answer(userText, memoryBullets, conversation, mode) {
  const memoryContext = memoryBullets.length
    ? memoryBullets.slice(0, 8).map((b) => `- ${b}`).join("\n")
    : "";

  const sys1 = { role: "system", content: buildShineSystemPrompt(mode) };
  const sys2 = {
    role: "system",
    content: memoryContext ? `MEMORY CONTEXT (internal):\n${memoryContext}` : "MEMORY CONTEXT (internal):",
  };

  const r = await openai.chat.completions.create({
    model: MODEL_B,
    messages: [sys1, sys2, ...conversation, { role: "user", content: userText }],
    temperature: 0.7,
  });

  return stripEmojis(r.choices?.[0]?.message?.content ?? "");
}

// --------------------
// Model A: decide write (post) after seeing Shine reply
// --------------------
async function modelA_decideWrite(userText, shineReply, memoryBullets) {
  const sys = {
    role: "system",
    content: [
      "You are Model A, the memory curator for Shine.",
      "Decide whether to store a NEW long-term memory AFTER seeing the user message and Shine's reply.",
      "",
      "Store stable user facts (name/pronouns/preferences/projects/boundaries).",
      "Store stable relationship preferences if clearly stated.",
      "Avoid one-off events unless user explicitly asked to remember/save.",
      "Avoid duplicates based on existing memories.",
      "",
      "Output MUST be either:",
      "NO_WRITE",
      "or a single JSON object:",
      '{ "content": "...", "memory_type":"preference|profile|project|boundary|relationship|note", "importance_level":1-5, "tags":["..."] }',
      "Avoid duplicates based on existing memories.",
"IMPORTANT: If the new memory is only a paraphrase, confirmation, expansion, or rewording of an existing memory, output NO_WRITE.",
"Only write if it adds genuinely new stable information (new preference, new boundary, new project detail).",
"Do NOT write meta-memories like 'confirmed/expanded from previous mentions'. Store the stable fact itself, not commentary.",
      "Keep content short and unambiguous.",
    ].join("\n"),
  };

  const mem = {
    role: "system",
    content: ["EXISTING RELEVANT MEMORIES:", ...memoryBullets.map((b) => `- ${b}`)].join("\n"),
  };

  const ctx = {
    role: "user",
    content: `USER SAID:\n${userText}\n\nSHINE REPLIED:\n${shineReply}`,
  };

  const r = await openai.chat.completions.create({
    model: MODEL_A,
    messages: [sys, mem, ctx],
    temperature: 0.2,
  });

  const txt = (r.choices?.[0]?.message?.content ?? "").trim();
  console.log("[ModelA] decideWrite raw:", txt);
  if (!txt || /^NO_WRITE$/i.test(txt)) return null;

  const parsed = safeJsonParse(txt);
  if (!parsed?.content) return null;

  return {
    content: String(parsed.content).trim(),
    memory_type: typeof parsed.memory_type === "string" ? parsed.memory_type : "note",
    importance_level: typeof parsed.importance_level === "number" ? parsed.importance_level : 3,
    tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
  };
}

// --------------------
// Conversation store (in-memory)
// --------------------
const conversations = new Map(); // conversationId -> [{role, content}]
function getConversation(id) {
  if (!conversations.has(id)) conversations.set(id, []);
  return conversations.get(id);
}

// --------------------
// HTTP API
// --------------------
const app = express();
app.use(express.json({ limit: "2mb" }));

app.post("/generate", async (req, res) => {
  try {
    const conversationId = String(req.body.conversationId ?? "main");
    const mode = String(req.body.mode ?? "default");
    const userText = stripEmojis(String(req.body.text ?? ""));

    if (!userText.trim()) return res.status(400).json({ ok: false, error: "Missing text" });

    const conversation = getConversation(conversationId);

// Phase 1: ALWAYS search memory before answering
let memoryBullets = [];

// 1) Always do a baseline memory search first
try {
  const defaultQ = buildDefaultMemoryQuery(userText, conversation);
  memoryBullets = await search_memories(defaultQ, 8);
} catch (e) {
  console.warn("[Router] baseline memory search failed:", String(e?.message ?? e));
}

// 2) Optional refinement pass (best-effort; never cancels baseline results)
try {
  const s = await modelA_decideSearch(userText);
  if (s.shouldSearch && s.query) {
    const refined = await search_memories(sanitizeMemoryQuery(s.query) || userText, 12);
    const seen = new Set(memoryBullets);
    for (const b of refined) if (!seen.has(b)) memoryBullets.push(b);
  }
} catch (e) {
  console.warn("[Router] refined memory search failed:", String(e?.message ?? e));
}

// 3) Pattern B: filter for relevance (best-effort; keep unfiltered on failure)
try {
  const filtered = await modelA_filterMemory(userText, memoryBullets);
  // Don’t let an over-strict filter erase useful retrieved memories
  if (Array.isArray(filtered) && filtered.length) memoryBullets = filtered;
  console.log("[Router] filtered memory bullets:", memoryBullets);
} catch (e) {
  console.warn("[Router] memory filter failed (using unfiltered):", String(e?.message ?? e));
}

// Phase 2: Shine answers
    const shineReply = await modelB_answer(userText, memoryBullets, conversation, mode);

    // Phase 3: decide write -> MCP create_memory
const mem = await modelA_decideWrite(userText, shineReply, memoryBullets);

if (mem) {
  // Skip if it’s basically already in memory context
  if (isNearDuplicate(mem.content, memoryBullets)) {
    console.log("[Router] Skipping duplicate memory:", mem.content);
  } else {
    await create_memory(mem);
  }
}

    // Update convo after processing is complete
    conversation.push({ role: "user", content: userText });
    conversation.push({ role: "assistant", content: shineReply });

    return res.json({ ok: true, text: shineReply, mode, memories_used: memoryBullets.length });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.stack ?? e) });
  }
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Shine Router API running: http://127.0.0.1:${PORT}/generate`);
  console.log(`LM Studio: ${LM_BASE_URL}`);
  console.log(`Model A (router): ${MODEL_A}`);
  console.log(`Model B (shine): ${MODEL_B}`);
  console.log(`MCP stdio: ${command} ${args.join(" ")}`);
});
