// ─────────────────────────────────────────────
//  MAGI Backend — ~/magi-app/server.js
//  Express + MariaDB + Agentic Orchestration
// ─────────────────────────────────────────────

const express = require('express');
const mysql   = require('mysql2/promise');
const { exec, execFile } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const execFilePromise = util.promisify(execFile);
const fs = require('fs');
const path = require('path');
const app  = express();
const PORT = 3131;
const OLLAMA_URL = 'http://127.0.0.1:11434';
const SEARXNG_URL = 'http://127.0.0.1:8888';

app.use(express.json({ limit: '50mb' }));

// ══════════════════════════════════════════════
//  PYWAL THEME SYNC
// ══════════════════════════════════════════════

const WAL_COLORS_PATH = path.join(require('os').homedir(), '.cache', 'wal', 'colors.json');
const WAL_DIR = path.dirname(WAL_COLORS_PATH);

app.get('/theme', (req, res) => {
  try {
    const raw = fs.readFileSync(WAL_COLORS_PATH, 'utf-8');
    res.json(JSON.parse(raw));
  } catch (e) {
    res.status(404).json({ error: 'pywal colors not found — run wal at least once.' });
  }
});

// ══════════════════════════════════════════════
//  SYSTEM STATUS (VRAM / loaded models)
// ══════════════════════════════════════════════

app.get('/system/status', async (req, res) => {
  try {
    const psRes = await fetch(`${OLLAMA_URL}/api/ps`).then(r => r.json());
    const models = (psRes.models || []).map(m => ({
      name: m.name,
      sizeVram: m.size_vram || 0,
      size: m.size || 0,
      expiresAt: m.expires_at,
    }));
    const totalVram = models.reduce((sum, m) => sum + m.sizeVram, 0);
    res.json({ models, totalVramBytes: totalVram });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/theme/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  let debounce = null;
  const watcher = fs.watch(WAL_DIR, (eventType, filename) => {
    if (filename !== 'colors.json') return;
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      if (!res.writableEnded) res.write(`data: {"type":"theme_changed"}\n\n`);
    }, 300); // wal rewrites several files in quick succession — debounce the burst
  });

  req.on('close', () => { clearTimeout(debounce); watcher.close(); });
});

app.use((req, res, next) => {
  // Wildcard CORS meant ANY webpage open in the user's regular browser could
  // fetch() this server (loopback-bound, but same-machine requests aren't
  // blocked by that bind) and, thanks to the wildcard, actually read the
  // response — chat history, RAG memory, everything. The Electron renderer
  // (file:// origin) sends Origin: null or no Origin header at all; a real
  // website sends its http(s) origin. Only ever reflect the former.
  const origin = req.headers.origin;
  if (!origin || origin === 'null') {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

if (!process.env.MAGI_DB_PASS) {
  console.error('MAGI_DB_PASS is not set. Copy .env.example to .env, set a password, and source it before starting the server.');
  process.exit(1);
}

const db = mysql.createPool({
  host:     process.env.MAGI_DB_HOST || 'localhost',
  user:     'root',
  password: process.env.MAGI_DB_PASS,
  database: 'magidb',
  waitForConnections: true,
  connectionLimit:    10,
});

// ══════════════════════════════════════════════
//  PROMPT LOADER
// ══════════════════════════════════════════════

const PROMPTS_DIR = path.join(__dirname, 'prompts');
const promptCache = {};

function loadPrompt(personaId) {
  const filePath = path.join(PROMPTS_DIR, `${personaId}.md`);
  try {
    const mtime = fs.statSync(filePath).mtimeMs;
    const cached = promptCache[personaId];
    if (cached && cached.mtime === mtime) return cached.content;

    const content = fs.readFileSync(filePath, 'utf-8');
    promptCache[personaId] = { content, mtime };
    console.log(`[PROMPT] Loaded ${personaId}.md${cached ? ' (changed on disk, reloaded)' : ''}`);
    return content;
  } catch (e) {
    console.warn(`[PROMPT] Could not load ${personaId}.md: ${e.message}`);
    return '';
  }
}

// ══════════════════════════════════════════════
//  THINK STRIPPER (streaming state machine)
// ══════════════════════════════════════════════

class ThinkStripper {
  constructor({ onThinkStart, onThinkToken, onThinkEnd, onToken }) {
    this.inThink   = false;
    this.buffer    = '';
    this.started   = false;
    this.onThinkStart = onThinkStart || (() => {});
    this.onThinkToken = onThinkToken || (() => {});
    this.onThinkEnd   = onThinkEnd   || (() => {});
    this.onToken      = onToken      || (() => {});
  }

  push(chunk) {
    this.buffer += chunk;
    this._process();
  }

  flush() {
    if (!this.inThink && this.buffer) {
      this.onToken(this.buffer);
      this.buffer = '';
    }
  }

  _partialSuffix(str, tag) {
    for (let i = 1; i < tag.length; i++) {
      if (str.endsWith(tag.slice(0, i))) return str.length - i;
    }
    return -1;
  }

  _process() {
    while (true) {
      if (this.inThink) {
        const end = this.buffer.indexOf('</think>');
        if (end !== -1) {
          if (end > 0) this.onThinkToken(this.buffer.slice(0, end));
          this.onThinkEnd();
          this.inThink = false;
          this.buffer  = this.buffer.slice(end + 8).replace(/^\s+/, '');
        } else {
          const safe = Math.max(0, this.buffer.length - 9);
          if (safe > 0) {
            this.onThinkToken(this.buffer.slice(0, safe));
            this.buffer = this.buffer.slice(safe);
          }
          break;
        }
      } else {
        const start = this.buffer.indexOf('<think>');
        if (start !== -1) {
          if (start > 0) this.onToken(this.buffer.slice(0, start));
          if (!this.started) { this.onThinkStart(); this.started = true; }
          this.inThink = true;
          this.buffer  = this.buffer.slice(start + 7);
        } else {
          const p = this._partialSuffix(this.buffer, '<think>');
          if (p !== -1) {
            if (p > 0) this.onToken(this.buffer.slice(0, p));
            this.buffer = this.buffer.slice(p);
            break;
          } else {
            if (this.buffer) this.onToken(this.buffer);
            this.buffer = '';
            break;
          }
        }
      }
    }
  }
}

// ══════════════════════════════════════════════
//  TOOL-CALL FALLBACK PARSER
//  Some models/templates (e.g. qwen2.5-coder's default
//  Ollama template) don't populate message.tool_calls —
//  they just print the call as raw JSON in content instead.
// ══════════════════════════════════════════════

function tryParseToolJSON(text) {
  if (!text.startsWith('{') && !text.startsWith('[')) return null;
  try {
    const parsed = JSON.parse(text);
    const candidates = Array.isArray(parsed) ? parsed : [parsed];
    const calls = candidates.filter(c => c && typeof c.name === 'string' && c.arguments && typeof c.arguments === 'object');
    if (calls.length === 0) return null;
    return calls.map((c, i) => ({ id: `fallback_${i}`, function: { name: c.name, arguments: c.arguments } }));
  } catch {
    return null;
  }
}

// Scans text for top-level {...} objects using brace-depth counting (string-
// aware, so braces inside quoted values don't throw off the count) instead of
// requiring the whole string to be one JSON value. Lets the fallback parser
// recover a tool call even when the model mixed prose in with the JSON.
function findBalancedJSONObjects(text) {
  const results = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === '{') {
      let depth = 0, inStr = false, esc = false, j = i;
      for (; j < text.length; j++) {
        const ch = text[j];
        if (inStr) {
          if (esc) esc = false;
          else if (ch === '\\') esc = true;
          else if (ch === '"') inStr = false;
        } else if (ch === '"') inStr = true;
        else if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) { results.push(text.slice(i, j + 1)); break; }
        }
      }
      i = j + 1;
    } else {
      i++;
    }
  }
  return results;
}

function extractFallbackToolCalls(content) {
  if (!content) return null;
  const text = content.trim();

  // Strategy 1: the entire response is the JSON call, nothing else.
  const direct = tryParseToolJSON(text);
  if (direct) return direct;

  // Strategy 2: a fenced ```json ... ``` block anywhere in the text — models that
  // add explanatory prose before/after the call (e.g. after a tool error) still
  // get recovered this way.
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/g;
  let m;
  while ((m = fenceRegex.exec(text)) !== null) {
    const parsed = tryParseToolJSON(m[1].trim());
    if (parsed) return parsed;
    // The fence itself might mix in stray prose alongside the JSON — scan for
    // a balanced object inside it rather than giving up on the whole block.
    for (const candidate of findBalancedJSONObjects(m[1])) {
      const nested = tryParseToolJSON(candidate);
      if (nested) return nested;
    }
  }

  // Strategy 3: last resort — scan the raw unfenced text too, in case the
  // model dropped the fence but still emitted valid call JSON inline.
  for (const candidate of findBalancedJSONObjects(text)) {
    const loose = tryParseToolJSON(candidate);
    if (loose) return loose;
  }

  return null;
}

function withToolCallFallback(llmResponse) {
  if (!llmResponse.message.tool_calls || llmResponse.message.tool_calls.length === 0) {
    const fallback = extractFallbackToolCalls(llmResponse.message.content);
    if (fallback) {
      console.log(`[LLM] Recovered ${fallback.length} tool call(s) from raw content (model lacks native tool_calls support)`);
      llmResponse.message.tool_calls = fallback;
      // Keep original content intact (don't blank it) — for fallback models we
      // replay it back as plain assistant text in history, since their template
      // was never trained to render a structured tool_calls-shaped message.
      llmResponse.message._usedFallback = true;
    }
  }
  return llmResponse;
}

// ══════════════════════════════════════════════
//  APPROVAL GATE (pending terminal approvals)
// ══════════════════════════════════════════════

const pendingApprovals = new Map();

app.post('/tool/approve', (req, res) => {
  const { requestId, approved } = req.body;
  const pending = pendingApprovals.get(requestId);
  if (!pending) return res.status(404).json({ error: 'No pending approval found.' });
  pendingApprovals.delete(requestId);
  pending.resolve(!!approved);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════
//  AGENT TOOLS
// ══════════════════════════════════════════════

// Free, keyless, non-scraping fallback for factual/entity queries (DuckDuckGo's
// documented Instant Answer API — not the HTML search page SearXNG's ddg
// engine scrapes, and not currently getting CAPTCHA'd). Only covers topics
// with a direct Wikipedia-style entity match, same limitation as the
// infobox engine, but it's a second independent source for free.
async function fetchDuckDuckGoInstantAnswer(query) {
  try {
    const res = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const data = await res.json();
    const text = data.AbstractText || data.Answer || data.Definition;
    if (!text) return null;
    const source = data.AbstractSource || data.DefinitionSource || 'DuckDuckGo';
    const url    = data.AbstractURL || data.DefinitionURL || '';
    return `[${source}]\n${text}${url ? `\nURL: ${url}` : ''}`;
  } catch {
    return null;
  }
}

async function searchWeb(query) {
  console.log(`[TOOL] Web Search: ${query}`);
  const parts = [];
  try {
    const res = await fetch(`${SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json`);
    const data = await res.json();
    // General engines (Google/Brave/DDG/Startpage) get CAPTCHA'd or suspended
    // often enough on this host that `results` alone regularly comes back
    // empty — infoboxes (Wikipedia summaries) are a separate array in
    // SearXNG's response and were being silently dropped even when they did
    // come back, so a working Wikipedia hit still looked like "no results".
    for (const ib of (data.infoboxes || [])) {
      if (ib.content) parts.push(`[Infobox: ${ib.infobox}]\n${ib.content}`);
    }
    for (const r of (data.results || []).slice(0, 5)) {
      parts.push(`Title: ${r.title}\nURL: ${r.url}\nContent: ${r.content}`);
    }
  } catch (e) {
    parts.push(`SearXNG search failed: ${e.message}`);
  }

  if (parts.length === 0) {
    const ddg = await fetchDuckDuckGoInstantAnswer(query);
    if (ddg) parts.push(ddg);
  }

  return parts.join('\n\n') || 'No results found.';
}

async function runTerminal(cmd, { sendEvent = null, chatId = null, personaName = 'MAGI', reason = '' } = {}) {
  console.log(`[TOOL] Terminal Exec: ${cmd}`);

  const forbidden = [
    /\brm\s/, /\bmv\s/, /\bcp\s+-.*r/i, /\bmkfs\b/, /\bdd\b/, /\bchmod\b/, /\bchown\b/,
    /\bln\s/, /\btouch\s/, /\bmkdir\s/, /\btruncate\b/, /\binstall\s+-[a-zA-Z]*m\b/,
    /\s>\s*\//, /\s>>\s*\//, /\s>\s*[~.]/, /\s>>\s*[~.]/,
    /\bsudo\s+(rm|mv|dd|mkfs|tee|chmod|chown|passwd|install|ln|mkdir|touch|truncate)\b/,
    /\bsu\s+-\b/, /\bpkexec\b/, /\bdoas\b/,
    /\bpacman\s+-S[yu]/, /\byay\s+-S[yu]/, /\bparu\s+-S[yu]/,
    /\bpip\s+install\b/, /\bpip3\s+install\b/, /\bnpm\s+install\b/,
    /\byarn\s+add\b/, /\bpnpm\s+add\b/, /\bcargo\s+install\b/, /\bgo\s+install\b/,
    /\bsystemctl\s+(start|stop|restart|enable|disable|mask|unmask|daemon-reload)\b/,
    /\bservice\s+\S+\s+(start|stop|restart)\b/,
    /\bkill\b/, /\bkillall\b/, /\bpkill\b/,
    /\breboot\b/, /\bshutdown\b/, /\bhalt\b/, /\bpoweroff\b/,
    /\bpython[23]?\s+-c\b/, /\bnode\s+-e\b/, /\bperl\s+-e\b/, /\bruby\s+-e\b/,
    /\bbash\s+-c\b/, /\bsh\s+-c\b/, /\beval\b/, /\bexec\b/,
    /\bcurl\b.*\|\s*(bash|sh|python|node)\b/, /\bwget\b.*\|\s*(bash|sh|python|node)\b/,
    /\bfetch\b.*\|\s*(bash|sh)\b/, /\btee\s+[^|]/,
    /\bgit\s+(checkout|reset|clean|push|commit|merge|rebase|tag|branch\s+-[dD]|stash\s+drop)\b/,
    /\bfdisk\b/, /\bparted\b/, /\bgdisk\b/, /\bmkswap\b/, /\bswapon\b/, /\bswapoff\b/,
    /\biptables\s+-[ADIFRXYZPNEF]\b/,
    /\bip\s+(addr|route|link)\s+(add|del|change|replace|flush)\b/,
    /\bnmcli\s+(con|connection|dev|device)\s+(up|down|add|del|modify)\b/,
    /\bcrontab\s+-[eri]\b/, /\bat\b/,
  ];

  if (forbidden.some(pattern => pattern.test(cmd))) {
    console.warn(`[TOOL] BLOCKED command attempt: ${cmd}`);
    return "Error: Command blocked for system safety. Only read-only commands are permitted.";
  }

  if (/\$\(/.test(cmd) || /`[^`]+`/.test(cmd)) {
    console.warn(`[TOOL] BLOCKED subshell in command: ${cmd}`);
    return "Error: Subshell expansion is not permitted.";
  }

  // Request user approval via SSE
  if (sendEvent) {
    const requestId = `tr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    sendEvent('tool_request', { requestId, tool: 'run_terminal', cmd, reason, persona: personaName });
    const approved = await waitForApproval(requestId, chatId);
    sendEvent('tool_response', { requestId, approved });
    if (!approved) return "Command denied by user.";
  }

  try {
    const { stdout, stderr } = await execPromise(cmd, {
      timeout: 15000,
      env: { ...process.env, PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' }
    });
    const output = stdout || stderr || "Command executed successfully with no output.";
    return output.slice(0, 8000);
  } catch (e) {
    return `Execution Error: ${e.message}`;
  }
}

// ══════════════════════════════════════════════
//  SEMANTIC SEARCH (RAG over past messages)
// ══════════════════════════════════════════════

const EMBED_MODEL = 'nomic-embed-text';

async function embed(text) {
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: text })
  }).then(r => r.json());
  if (res.error) throw new Error(`Embedding failed: ${res.error}`);
  return res.embeddings[0];
}

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function embedNewMessages() {
  try {
    const [rows] = await db.query(
      `SELECT m.id, m.content FROM messages m
       LEFT JOIN message_embeddings e ON e.message_id = m.id
       WHERE e.message_id IS NULL
       ORDER BY m.id ASC LIMIT 20`
    );
    for (const row of rows) {
      const embedding = await embed(row.content.slice(0, 4000));
      await db.query(
        'INSERT INTO message_embeddings (message_id, embedding) VALUES (?, ?) ON DUPLICATE KEY UPDATE embedding = VALUES(embedding)',
        [row.id, JSON.stringify(embedding)]
      );
    }
  } catch (e) {
    console.warn(`[RAG] Background embedding pass failed: ${e.message}`);
  }
}

async function searchPastChats(query) {
  console.log(`[TOOL] Semantic Search: ${query}`);
  try {
    const queryVector = await embed(query);
    const [rows] = await db.query(
      `SELECT c.title, m.role, m.content, m.created_at, e.embedding
       FROM message_embeddings e
       JOIN messages m ON m.id = e.message_id
       JOIN chats c ON c.id = m.chat_id
       ORDER BY m.id DESC LIMIT 500`
    );
    if (rows.length === 0) return "No past conversations have been indexed yet.";

    const scored = rows.map(r => ({
      ...r,
      score: cosineSimilarity(queryVector, JSON.parse(r.embedding))
    })).sort((a, b) => b.score - a.score).slice(0, 8);

    return scored.map(r => `[Chat: ${r.title} | Date: ${r.created_at}] ${r.role}: ${r.content}`).join('\n\n');
  } catch (e) {
    return `Semantic search failed: ${e.message}`;
  }
}

async function fetchUrl(url) {
  console.log(`[TOOL] Fetch URL: ${url}`);

  const privatePatterns = [
    /^https?:\/\/localhost/i, /^https?:\/\/127\./, /^https?:\/\/0\.0\.0\.0/,
    /^https?:\/\/10\.\d+\.\d+\.\d+/, /^https?:\/\/192\.168\./,
    /^https?:\/\/172\.(1[6-9]|2\d|3[01])\./, /^https?:\/\/::1/,
  ];
  if (privatePatterns.some(p => p.test(url))) {
    return "Error: Fetching local or private network URLs is not permitted.";
  }

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MAGI/1.0)' },
      signal: AbortSignal.timeout(10000)
    });
    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim()
      .slice(0, 6000);
    return text || 'Page fetched but no readable content found.';
  } catch (e) {
    return `fetch_url failed: ${e.message}`;
  }
}

// ══════════════════════════════════════════════
//  CODE PERSONA FILE TOOLS (sandboxed)
// ══════════════════════════════════════════════

const ALLOWED_ROOTS = [
  '/home/ely/.local/src',
];

const HOME_DIR = require('os').homedir();

// Directories under $HOME that a chat's working dir may never point at, even
// though they're technically "under home" — credentials, keys, app configs.
const FORBIDDEN_WORKDIR_SUBPATHS = [
  '.ssh', '.gnupg', '.config', '.mozilla', '.local/share/keyrings', '.aws', '.docker',
];

// Node's path.resolve() has no concept of "~" — it treats it as a literal
// directory name. Left unexpanded, "~/foo" resolved against the server's own
// cwd produces a bogus-but-technically-under-$HOME path like
// ".../magi_AI/~/foo", which then passes the isValidWorkingDir check below
// (it really is a subpath of $HOME, just a nonsensical one) and gets stored
// as the working dir. Expand it ourselves, once, before any resolve() call.
function expandHome(p) {
  if (p === '~') return HOME_DIR;
  if (p.startsWith('~/')) return path.join(HOME_DIR, p.slice(2));
  return p;
}

// A per-chat "project directory" the user opts into (see /chats working_dir) —
// this is what lets magi-code work in an arbitrary project without every
// message having to say "work in /home/ely/whatever". Read tools accept it as
// an extra allowed root; write tools require it and are scoped to ONLY it.
// Requires an absolute (or ~-prefixed) path — a bare relative path has no
// sane base to resolve against here, so it's rejected rather than silently
// resolved against the server's own working directory.
function isValidWorkingDir(dir) {
  if (!dir) return false;
  const expanded = expandHome(dir);
  if (!path.isAbsolute(expanded)) return false;
  const resolved = path.resolve(expanded);
  if (resolved !== HOME_DIR && !resolved.startsWith(HOME_DIR + path.sep)) return false;
  if (resolved === HOME_DIR) return false; // too broad — never allow the whole home dir as a write root
  const rel = path.relative(HOME_DIR, resolved);
  if (FORBIDDEN_WORKDIR_SUBPATHS.some(f => rel === f || rel.startsWith(f + path.sep))) return false;
  return true;
}

// The canonical, expanded, absolute form of a working dir — call this once a
// workingDir has already passed isValidWorkingDir, to get the path that
// should actually be stored/used (never the raw "~/..." the user typed).
function normalizeWorkingDir(dir) {
  return path.resolve(expandHome(dir));
}

// Resolves a path against the sandbox. Absolute (or ~-prefixed) paths must
// fall under one of ALLOWED_ROOTS or the chat's workingDir (if set/valid); a
// relative path is resolved against workingDir when available, else against
// $HOME, so the model can say "src/index.js" once a working dir is
// configured instead of spelling out the full path on every call.
function resolveInSandbox(userPath, workingDir = null) {
  const validWorkingDir = workingDir && isValidWorkingDir(workingDir) ? normalizeWorkingDir(workingDir) : null;
  const p = expandHome(userPath);
  const base = path.isAbsolute(p) ? '/' : (validWorkingDir || HOME_DIR);
  const resolved = path.resolve(base, p);
  const roots = validWorkingDir ? [...ALLOWED_ROOTS, validWorkingDir] : ALLOWED_ROOTS;
  const allowed = roots.some(root => resolved === root || resolved.startsWith(root + path.sep));
  if (!allowed) return null;
  return resolved;
}

// Write tools are intentionally stricter than reads: only inside the chat's
// own working dir, never the general ALLOWED_ROOTS list, and only once the
// user has explicitly set one for that chat.
function resolveInWritableSandbox(userPath, workingDir) {
  if (!workingDir || !isValidWorkingDir(workingDir)) return null;
  const validWorkingDir = normalizeWorkingDir(workingDir);
  const p = expandHome(userPath);
  const resolved = path.isAbsolute(p) ? path.resolve(p) : path.resolve(validWorkingDir, p);
  if (resolved !== validWorkingDir && !resolved.startsWith(validWorkingDir + path.sep)) return null;
  return resolved;
}

// Directory-name autocomplete for the working-dir picker — a "mini shell" tab
// completion, not a general file browser. Only ever lists directories, and
// only ever under $HOME, so it can't be used to probe the rest of the
// filesystem even though it needs no approval gate (read-only directory
// names, same info `ls ~` gives you).
app.get('/fs/browse', async (req, res) => {
  const input = (req.query.path || '~').toString();
  try {
    // Check for a trailing slash on the RAW input before expanding — path.join()
    // inside expandHome() normalizes it away (join(home, '') === home, no
    // trailing slash), so checking after expansion silently loses the "list
    // this directory's contents" signal and looks one level too high instead.
    const endsWithSep = input.endsWith('/') || input.endsWith(path.sep);
    const expanded = expandHome(input);
    const dir    = path.resolve(endsWithSep ? expanded : (path.dirname(expanded) || '/'));
    const prefix = endsWithSep ? '' : path.basename(expanded);

    if (dir !== HOME_DIR && !dir.startsWith(HOME_DIR + path.sep)) {
      return res.json({ dir, entries: [] });
    }

    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const matches = entries
      .filter(e => e.isDirectory())
      .filter(e => prefix.startsWith('.') || !e.name.startsWith('.'))
      .filter(e => e.name.toLowerCase().startsWith(prefix.toLowerCase()))
      .map(e => path.join(dir, e.name))
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 30);

    res.json({ dir, entries: matches });
  } catch (e) {
    res.json({ dir: null, entries: [] });
  }
});

async function readFileTool(userPath, workingDir) {
  console.log(`[TOOL] Read File: ${userPath}`);
  const resolved = resolveInSandbox(userPath, workingDir);
  if (!resolved) return `Error: path is outside the allowed roots (${ALLOWED_ROOTS.join(', ')}${workingDir ? `, ${workingDir}` : ''}).`;
  const MAX_CHARS = 60000;
  try {
    const content = await fs.promises.readFile(resolved, 'utf-8');
    if (content.length <= MAX_CHARS) return content;
    return content.slice(0, MAX_CHARS)
      + `\n\n[TRUNCATED — file is ${content.length} chars, showing first ${MAX_CHARS}. `
      + `Re-reading the same file returns identical truncated content — use grep to jump to the relevant section instead.]`;
  } catch (e) {
    return `read_file failed: ${e.message}`;
  }
}

async function listDirTool(userPath, workingDir) {
  console.log(`[TOOL] List Dir: ${userPath}`);
  const resolved = resolveInSandbox(userPath, workingDir);
  if (!resolved) return `Error: path is outside the allowed roots (${ALLOWED_ROOTS.join(', ')}${workingDir ? `, ${workingDir}` : ''}).`;
  try {
    const entries = await fs.promises.readdir(resolved, { withFileTypes: true });
    return entries.map(e => `${e.isDirectory() ? 'd' : 'f'}  ${e.name}`).join('\n') || '(empty directory)';
  } catch (e) {
    return `list_dir failed: ${e.message}`;
  }
}

async function grepTool(pattern, userPath, workingDir) {
  console.log(`[TOOL] Grep: ${pattern} in ${userPath}`);
  const resolved = resolveInSandbox(userPath, workingDir);
  if (!resolved) return `Error: path is outside the allowed roots (${ALLOWED_ROOTS.join(', ')}${workingDir ? `, ${workingDir}` : ''}).`;
  try {
    const { stdout } = await execFilePromise(
      'grep',
      ['-rn', '-I', '--exclude-dir=node_modules', '--exclude-dir=.git', '-e', pattern, resolved],
      { timeout: 15000, maxBuffer: 1024 * 1024 }
    );
    return stdout.trim().split('\n').slice(0, 100).join('\n') || 'No matches found.';
  } catch (e) {
    if (e.code === 1) return 'No matches found.';
    if (e.killed || e.signal) return `grep timed out searching ${resolved} — try a narrower path.`;
    return `grep failed: ${e.message}`;
  }
}

// ══════════════════════════════════════════════
//  DIFF (for file-edit approval previews)
// ══════════════════════════════════════════════

function diffLines(oldText, newText) {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const n = a.length, m = b.length;

  if (n * m > 4_000_000) {
    return [{ type: 'meta', line: `Diff too large to render in full (${n} → ${m} lines) — review the file directly after applying.` }];
  }

  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ type: 'context', line: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ type: 'remove', line: a[i] }); i++; }
    else { ops.push({ type: 'add', line: b[j] }); j++; }
  }
  while (i < n) ops.push({ type: 'remove', line: a[i++] });
  while (j < m) ops.push({ type: 'add', line: b[j++] });
  return ops;
}

function buildDiffPreview(oldText, newText) {
  const MAX_DIFF_OPS = 500;
  const ops = diffLines(oldText, newText);
  if (ops.length > MAX_DIFF_OPS) {
    return ops.slice(0, MAX_DIFF_OPS).concat([{ type: 'meta', line: `… diff truncated (${ops.length - MAX_DIFF_OPS} more lines not shown) …` }]);
  }
  return ops;
}

// ══════════════════════════════════════════════
//  CODE PERSONA WRITE TOOLS (approval-gated, sandboxed to workingDir only)
// ══════════════════════════════════════════════

function waitForApproval(requestId, chatId, timeoutMs = 120000) {
  return new Promise(resolve => {
    pendingApprovals.set(requestId, { resolve, chatId });
    setTimeout(() => {
      if (pendingApprovals.has(requestId)) {
        pendingApprovals.delete(requestId);
        resolve(false);
      }
    }, timeoutMs);
  });
}

async function writeFileTool(userPath, content, reason, { sendEvent = null, chatId = null, personaName = 'MAGI', workingDir = null } = {}) {
  console.log(`[TOOL] Write File: ${userPath}`);
  const resolved = resolveInWritableSandbox(userPath, workingDir);
  if (!resolved) {
    return workingDir
      ? `Error: path is outside the working directory (${workingDir}).`
      : `Error: no working directory is set for this chat. Ask the user to set one (project-dir picker in the header) before writing files.`;
  }

  let oldContent = '';
  let isNewFile = true;
  try {
    oldContent = await fs.promises.readFile(resolved, 'utf-8');
    isNewFile = false;
  } catch (e) { /* file doesn't exist yet — this is a create */ }

  const diff = buildDiffPreview(oldContent, content);

  if (sendEvent) {
    const requestId = `wf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    sendEvent('tool_request', { requestId, tool: 'write_file', path: resolved, isNewFile, reason, diff, persona: personaName });
    const approved = await waitForApproval(requestId, chatId);
    sendEvent('tool_response', { requestId, approved });
    if (!approved) return "File write denied by user.";
  }

  try {
    await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
    await fs.promises.writeFile(resolved, content, 'utf-8');
    return `${isNewFile ? 'Created' : 'Overwrote'} ${resolved} (${content.length} chars).`;
  } catch (e) {
    return `write_file failed: ${e.message}`;
  }
}

async function editFileTool(userPath, oldString, newString, reason, { sendEvent = null, chatId = null, personaName = 'MAGI', workingDir = null } = {}) {
  console.log(`[TOOL] Edit File: ${userPath}`);
  const resolved = resolveInWritableSandbox(userPath, workingDir);
  if (!resolved) {
    return workingDir
      ? `Error: path is outside the working directory (${workingDir}).`
      : `Error: no working directory is set for this chat. Ask the user to set one (project-dir picker in the header) before editing files.`;
  }

  let content;
  try {
    content = await fs.promises.readFile(resolved, 'utf-8');
  } catch (e) {
    return `edit_file failed: cannot read ${resolved} (${e.message}). Use write_file to create a new file.`;
  }

  if (!oldString) return `Error: old_string must not be empty — use write_file to create a new file.`;

  const occurrences = content.split(oldString).length - 1;
  if (occurrences === 0) return `Error: old_string not found in ${resolved}. Re-read the file and match the exact text, including whitespace and indentation.`;
  if (occurrences > 1) return `Error: old_string matches ${occurrences} locations in ${resolved} — include more surrounding context so it matches exactly once.`;

  const newContent = content.replace(oldString, newString);
  const diff = buildDiffPreview(content, newContent);

  if (sendEvent) {
    const requestId = `ef_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    sendEvent('tool_request', { requestId, tool: 'edit_file', path: resolved, isNewFile: false, reason, diff, persona: personaName });
    const approved = await waitForApproval(requestId, chatId);
    sendEvent('tool_response', { requestId, approved });
    if (!approved) return "File edit denied by user.";
  }

  try {
    await fs.promises.writeFile(resolved, newContent, 'utf-8');
    return `Edited ${resolved} (1 replacement applied).`;
  } catch (e) {
    return `edit_file failed: ${e.message}`;
  }
}

// ══════════════════════════════════════════════
//  AGENTIC ORCHESTRATION LOOP  (SSE streaming)
// ══════════════════════════════════════════════

const ALWAYS_MEMORY_PERSONAS = ['magi-core'];
const FILE_TOOL_PERSONAS     = ['magi-code'];
const WRITE_TOOL_PERSONAS    = ['magi-code'];

app.post('/chat/generate', async (req, res) => {
  const { chatId, model, systemPrompt, userMessage, allowSearch, allowMemory, allowThink, personaId, options, workingDir } = req.body;

  // ── SSE setup ─────────────────────────────────
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendEvent = (type, data = {}) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  const genStartedAt = Date.now();
  let thinkStartedAt = null;

  // Clean up pending approvals if client disconnects
  req.on('close', () => {
    for (const [id, pending] of pendingApprovals.entries()) {
      if (pending.chatId === chatId) {
        pending.resolve(false);
        pendingApprovals.delete(id);
      }
    }
  });

  try {
    await db.query('INSERT INTO messages (chat_id, role, content) VALUES (?, ?, ?)', [chatId, 'user', userMessage]);
    await db.query('UPDATE chats SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [chatId]);

    const [historyRows] = await db.query('SELECT role, content FROM messages WHERE chat_id = ? ORDER BY id ASC', [chatId]);

    let contextBlock = '';
    if (personaId) {
      try {
        const [ctxRows] = await db.query(
          'SELECT label, content FROM persona_context WHERE persona_id = ? ORDER BY id ASC',
          [personaId]
        );
        if (ctxRows.length > 0) {
          contextBlock = ctxRows.map(r => `[${r.label}]\n${r.content}`).join('\n\n');
          console.log(`[CTX] Injected ${ctxRows.length} context block(s) for ${personaId}`);
        }
      } catch (e) {
        console.warn(`[CTX] Could not load persona context: ${e.message}`);
      }
    }

    const validWorkingDir = WRITE_TOOL_PERSONAS.includes(personaId) && isValidWorkingDir(workingDir) ? normalizeWorkingDir(workingDir) : null;
    if (validWorkingDir) {
      contextBlock = (contextBlock ? contextBlock + '\n\n' : '')
        + `[Working Directory]\nThe user has set the project root for this chat to: ${validWorkingDir}\n`
        + `Relative paths passed to read_file/list_dir/grep/write_file/edit_file resolve against it — you don't need to ask which directory or repeat the full path every time.`;
    }

    const loadedPrompt    = loadPrompt(personaId) || systemPrompt;
    const fullSystemPrompt = contextBlock
      ? `${loadedPrompt}\n\n═══ SYSTEM CONTEXT ═══\n${contextBlock}\n══════════════════════`
      : loadedPrompt;

    const historyWithoutLast = historyRows.slice(0, -1);
    let messages = [
      { role: 'system', content: fullSystemPrompt },
      ...historyWithoutLast,
      { role: 'user', content: userMessage }
    ];

    const effectiveMemory = allowMemory || ALWAYS_MEMORY_PERSONAS.includes(personaId);
    const hasFileTools = FILE_TOOL_PERSONAS.includes(personaId);
    const personaName = personaId ? personaId.toUpperCase().replace('-', ' ') : 'MAGI';

    let tools = [];

    if (allowSearch) tools.push({
      type: "function",
      function: {
        name: "search_web",
        description: "Search the internet for current or live information: recent news, software releases, prices, weather, or anything that may have changed. Do NOT use for general knowledge you already know.",
        parameters: { type: "object", properties: { query: { type: "string", description: "A concise search query" } }, required: ["query"] }
      }
    });

    if (allowSearch) tools.push({
      type: "function",
      function: {
        name: "fetch_url",
        description: "Fetch and read the full content of a specific web page or article URL. Use AFTER search_web. Do NOT use for localhost or internal URLs.",
        parameters: { type: "object", properties: { url: { type: "string", description: "The full URL to fetch" } }, required: ["url"] }
      }
    });

    if (allowSearch || allowMemory) tools.push({
      type: "function",
      function: {
        name: "search_past_chats",
        description: "Semantically search the user's past conversation history. Use when the user refers to something discussed previously, or when prior context would improve the current answer.",
        parameters: { type: "object", properties: { query: { type: "string", description: "A natural-language description of what to find in past conversations" } }, required: ["query"] }
      }
    });

    if (effectiveMemory) {
      tools.push({
        type: "function",
        function: {
          name: "run_terminal",
          description: "Execute a read-only bash command on the user's Arch Linux machine. Use for: installed packages, config files, services, logs, hooks. Do NOT use destructive commands. The user sees your 'reason' before deciding whether to approve — always fill it in.",
          parameters: {
            type: "object",
            properties: {
              cmd:    { type: "string", description: "A safe, read-only bash command" },
              reason: { type: "string", description: "One short plain-English sentence: what this command does and why you're running it. Shown to the user in the approval prompt." }
            },
            required: ["cmd", "reason"]
          }
        }
      });
    }

    if (hasFileTools) {
      const rootsDesc = validWorkingDir ? `${ALLOWED_ROOTS.join(', ')}, or a relative path under ${validWorkingDir}` : ALLOWED_ROOTS.join(', ');
      tools.push({
        type: "function",
        function: {
          name: "read_file",
          description: `Read the full contents of a file. Path must be under ${rootsDesc}.`,
          parameters: { type: "object", properties: { path: { type: "string", description: "Absolute path, or relative to the working directory if one is set" } }, required: ["path"] }
        }
      });
      tools.push({
        type: "function",
        function: {
          name: "list_dir",
          description: `List files and subdirectories in a directory. Path must be under ${rootsDesc}.`,
          parameters: { type: "object", properties: { path: { type: "string", description: "Absolute path, or relative to the working directory if one is set" } }, required: ["path"] }
        }
      });
      tools.push({
        type: "function",
        function: {
          name: "grep",
          description: `Search for a pattern across files in a directory (recursive). Path must be under ${rootsDesc}.`,
          parameters: {
            type: "object",
            properties: {
              pattern: { type: "string", description: "Text or regex pattern to search for" },
              path:    { type: "string", description: "Absolute directory path, or relative to the working directory if one is set" }
            },
            required: ["pattern", "path"]
          }
        }
      });
    }

    // Write tools only exist at all once the user has set a working directory for
    // this chat — no working dir means the model never even sees them as options.
    if (WRITE_TOOL_PERSONAS.includes(personaId) && validWorkingDir) {
      tools.push({
        type: "function",
        function: {
          name: "write_file",
          description: `Create a new file, or fully overwrite an existing one, inside the working directory (${validWorkingDir}). The user is shown a diff and must approve before anything is written. Prefer edit_file for changes to existing files — use this mainly for new files.`,
          parameters: {
            type: "object",
            properties: {
              path:    { type: "string", description: "Path to the file, relative to the working directory (or absolute, if still inside it)" },
              content: { type: "string", description: "The full file content to write" },
              reason:  { type: "string", description: "One short plain-English sentence: what this file is for / why you're writing it. Shown to the user in the approval prompt." }
            },
            required: ["path", "content", "reason"]
          }
        }
      });
      tools.push({
        type: "function",
        function: {
          name: "edit_file",
          description: `Make a surgical, targeted edit to an existing file inside the working directory (${validWorkingDir}): replaces one exact occurrence of old_string with new_string. old_string must match the file's current content EXACTLY (whitespace and indentation included) and must be unique in the file — read the file first. The user is shown a diff and must approve before anything is written.`,
          parameters: {
            type: "object",
            properties: {
              path:        { type: "string", description: "Path to the file, relative to the working directory (or absolute, if still inside it)" },
              old_string:  { type: "string", description: "The exact, unique text to replace — copy it verbatim from a prior read_file result, including whitespace" },
              new_string:  { type: "string", description: "The text to replace it with" },
              reason:      { type: "string", description: "One short plain-English sentence: what this edit does and why. Shown to the user in the approval prompt." }
            },
            required: ["path", "old_string", "new_string", "reason"]
          }
        }
      });
    }

    const llmOptions = options || { temperature: 0 };
    const thinkParam = allowThink ? { think: true } : {};
    console.log(`[LLM] Prompting ${model} (persona: ${personaId}, memory: ${effectiveMemory}, fileTools: ${hasFileTools}, writeTools: ${!!validWorkingDir}, think: ${!!allowThink})...`);

    // Some models' Ollama templates don't declare tool support at all and hard-reject
    // the request if `tools` is present (distinct from models that accept tools but
    // fail to format calls correctly — see withToolCallFallback for that case).
    let toolsSupported = tools.length > 0;
    async function postChat(msgs) {
      let resp = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: msgs, tools: toolsSupported ? tools : undefined, stream: false, options: llmOptions, ...thinkParam })
      }).then(r => r.json());
      if (resp.error && toolsSupported && /does not support tools/i.test(resp.error)) {
        console.warn(`[LLM] ${model} does not support tools — retrying without tools for this session.`);
        toolsSupported = false;
        resp = await fetch(`${OLLAMA_URL}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, messages: msgs, stream: false, options: llmOptions, ...thinkParam })
        }).then(r => r.json());
      }
      return resp;
    }

    // ── Tool rounds (non-streaming, fast) ─────────
    let llmResponse = await postChat(messages);

    if (llmResponse.error) throw new Error(`Ollama refused the request: ${llmResponse.error}`);
    if (!llmResponse.message) throw new Error(`Ollama returned an invalid response: ${JSON.stringify(llmResponse)}`);
    llmResponse = withToolCallFallback(llmResponse);

    const MAX_TOOL_ROUNDS = 10;
    let round = 0;

    while (round < MAX_TOOL_ROUNDS) {
      round++;
      if (!llmResponse.message.tool_calls || llmResponse.message.tool_calls.length === 0) break;

      const usedFallback = !!llmResponse.message._usedFallback;
      messages.push(usedFallback
        ? { role: 'assistant', content: llmResponse.message.content }
        : llmResponse.message);

      for (const tool of llmResponse.message.tool_calls) {
        let toolResult = "";
        const fn = tool.function.name;
        const args = tool.function.arguments;

        sendEvent('tool_status', { tool: fn, args });

        if (fn === 'search_web')        toolResult = await searchWeb(args.query);
        if (fn === 'fetch_url')         toolResult = await fetchUrl(args.url);
        if (fn === 'search_past_chats') toolResult = await searchPastChats(args.query);
        if (fn === 'run_terminal')      toolResult = await runTerminal(args.cmd, { sendEvent, chatId, personaName, reason: args.reason });
        if (fn === 'read_file')         toolResult = await readFileTool(args.path, validWorkingDir);
        if (fn === 'list_dir')          toolResult = await listDirTool(args.path, validWorkingDir);
        if (fn === 'grep')              toolResult = await grepTool(args.pattern, args.path, validWorkingDir);
        if (fn === 'write_file')        toolResult = await writeFileTool(args.path, args.content, args.reason, { sendEvent, chatId, personaName, workingDir: validWorkingDir });
        if (fn === 'edit_file')         toolResult = await editFileTool(args.path, args.old_string, args.new_string, args.reason, { sendEvent, chatId, personaName, workingDir: validWorkingDir });

        console.log(`[TOOL RESULT] ${fn}: ${toolResult.slice(0, 200)}...`);
        messages.push(usedFallback
          ? { role: 'user', content: `[TOOL RESULT — ${fn}]\n${toolResult}` }
          : { role: 'tool', content: toolResult, name: fn });
      }

      console.log(`[LLM] Round ${round} tools executed. Calling LLM again...`);
      llmResponse = await postChat(messages);
      if (llmResponse.error) throw new Error(`Ollama error on round ${round}: ${llmResponse.error}`);
      llmResponse = withToolCallFallback(llmResponse);
    }

    // If the round budget ran out while the model still wanted to call tools,
    // force one last no-tools call so it synthesizes an answer from whatever it
    // gathered instead of the turn just failing outright.
    if (llmResponse.message.tool_calls && llmResponse.message.tool_calls.length > 0) {
      console.warn(`[LLM] Hit MAX_TOOL_ROUNDS (${MAX_TOOL_ROUNDS}) — forcing a final answer without tools.`);
      messages.push({ role: 'user', content: 'Stop calling tools now and answer using only what you\'ve already found.' });
      toolsSupported = false;
      llmResponse = await postChat(messages);
      if (llmResponse.error) throw new Error(`Ollama error on forced final answer: ${llmResponse.error}`);
    }

    // ── Final streaming response ───────────────────
    messages.push(llmResponse.message);
    // Replace last message with the role-only version for re-prompting in stream mode
    // Actually we just stream the already-computed final message if tool_calls exhausted,
    // but if we broke out with content, stream fresh.
    const hasFinalContent = llmResponse.message?.content && !llmResponse.message?.tool_calls?.length;

    let finalText = '';
    let usage = null;

    const onThinkStart = () => { thinkStartedAt = Date.now(); sendEvent('thinking_start'); };
    const onThinkEnd   = () => {
      const thinkMs = thinkStartedAt ? Date.now() - thinkStartedAt : null;
      thinkStartedAt = null;
      sendEvent('thinking_end', { thinkMs });
    };

    if (hasFinalContent) {
      // We already have the text from the last non-streaming call; stream it character by character
      // to the client via the ThinkStripper so think blocks get handled
      const rawContent = llmResponse.message.content || '';

      usage = {
        promptTokens:     llmResponse.prompt_eval_count ?? null,
        completionTokens: llmResponse.eval_count ?? null,
        evalDurationNs:   llmResponse.eval_duration ?? null,
      };
      // The real token count is already known here, before any text has been
      // replayed to the client — send it now so the live counter shows the
      // truth instead of a char-count guess.
      sendEvent('gen_meta', usage);

      const stripper = new ThinkStripper({
        onThinkStart,
        onThinkToken: (txt) => sendEvent('thinking_token', { text: txt }),
        onThinkEnd,
        onToken:      (txt) => { finalText += txt; sendEvent('token', { text: txt }); }
      });
      stripper.push(rawContent);
      stripper.flush();

    } else {
      // Stream directly from Ollama (shouldn't normally happen but handle gracefully)
      const streamRes = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, stream: true, options: llmOptions, ...thinkParam })
      });

      const reader  = streamRes.body.getReader();
      const decoder = new TextDecoder();

      const stripper = new ThinkStripper({
        onThinkStart,
        onThinkToken: (txt) => sendEvent('thinking_token', { text: txt }),
        onThinkEnd,
        onToken:      (txt) => { finalText += txt; sendEvent('token', { text: txt }); }
      });

      outer: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split('\n').filter(Boolean)) {
          try {
            const data = JSON.parse(line);
            // Handle native thinking field (Ollama 0.7+)
            if (data.message?.thinking) {
              if (!thinkStartedAt) onThinkStart();
              sendEvent('thinking_token', { text: data.message.thinking });
            }
            if (data.message?.content) {
              stripper.push(data.message.content);
            }
            if (data.done) {
              stripper.flush();
              usage = {
                promptTokens:     data.prompt_eval_count ?? null,
                completionTokens: data.eval_count ?? null,
                evalDurationNs:   data.eval_duration ?? null,
              };
              break outer;
            }
          } catch {}
        }
      }
    }

    if (!finalText) finalText = "Error: agent loop exhausted without a final answer.";

    const [result] = await db.query(
      'INSERT INTO messages (chat_id, role, content) VALUES (?, ?, ?)',
      [chatId, 'assistant', finalText]
    );

    sendEvent('done', {
      messageId: result.insertId,
      content: finalText,
      totalMs: Date.now() - genStartedAt,
      ...usage,
    });
    res.end();

    embedNewMessages(); // fire-and-forget background indexing

  } catch (error) {
    console.error(error);
    sendEvent('error', { message: error.message });
    res.end();
  }
});

// ══════════════════════════════════════════════
//  STANDARD CRUD (Do not delete these!)
// ══════════════════════════════════════════════

app.get('/chats', async (req, res) => {
  try { const [rows] = await db.query('SELECT id, persona, title, pinned, working_dir, created_at, updated_at FROM chats ORDER BY pinned DESC, updated_at DESC'); res.json(rows); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/chats', async (req, res) => {
  const { id, persona = 'magi-core', title = 'New Chat' } = req.body;
  try { await db.query('INSERT INTO chats (id, persona, title) VALUES (?, ?, ?)', [id, persona, title]); res.status(201).json({ id, persona, title }); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/chats/:id', async (req, res) => {
  const { title, persona, pinned, workingDir } = req.body;
  try {
    if (title !== undefined)   await db.query('UPDATE chats SET title = ? WHERE id = ?', [title, req.params.id]);
    if (persona !== undefined) await db.query('UPDATE chats SET persona = ? WHERE id = ?', [persona, req.params.id]);
    if (pinned !== undefined)  await db.query('UPDATE chats SET pinned = ? WHERE id = ?', [pinned ? 1 : 0, req.params.id]);
    let normalizedWorkingDir;
    if (workingDir !== undefined) {
      if (workingDir) {
        if (!isValidWorkingDir(workingDir)) return res.status(400).json({ error: 'Invalid working directory — must be an absolute (or ~-prefixed) path under your home directory, excluding config/credential dirs.' });
        normalizedWorkingDir = normalizeWorkingDir(workingDir);
        try {
          const stat = await fs.promises.stat(normalizedWorkingDir);
          if (!stat.isDirectory()) return res.status(400).json({ error: `${normalizedWorkingDir} exists but isn't a directory.` });
        } catch (e) {
          return res.status(400).json({ error: `${normalizedWorkingDir} doesn't exist — create it first.` });
        }
      } else {
        normalizedWorkingDir = null;
      }
      await db.query('UPDATE chats SET working_dir = ? WHERE id = ?', [normalizedWorkingDir, req.params.id]);
    }
    res.json({ ok: true, workingDir: normalizedWorkingDir });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/chats/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM messages WHERE chat_id = ?', [req.params.id]);
    await db.query('DELETE FROM chats WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/chats/:id/messages', async (req, res) => {
  try { const [rows] = await db.query('SELECT id, role, content, created_at FROM messages WHERE chat_id = ? ORDER BY id ASC', [req.params.id]); res.json(rows); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/chats/:id/messages', async (req, res) => {
  const { role, content } = req.body;
  try {
    const [result] = await db.query('INSERT INTO messages (chat_id, role, content) VALUES (?, ?, ?)', [req.params.id, role, content]);
    await db.query('UPDATE chats SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [req.params.id]);
    res.status(201).json({ id: result.insertId, role, content });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── RAG memory browser ──────────────────────────────────────────────────────
// Lists what's actually embedded/searchable via search_past_chats, and lets
// individual entries be unembedded (stops surfacing in RAG search) without
// touching the underlying chat message.
app.get('/memory', async (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const offset = parseInt(req.query.offset, 10) || 0;
  const q      = (req.query.q || '').trim();
  try {
    const whereClause = q ? 'WHERE m.content LIKE ?' : '';
    const params = q ? [`%${q}%`] : [];
    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) AS total
       FROM message_embeddings e
       JOIN messages m ON m.id = e.message_id
       ${whereClause}`,
      params
    );
    const [rows] = await db.query(
      `SELECT m.id AS message_id, m.chat_id, c.title AS chat_title, c.persona,
              m.role, m.content, m.created_at
       FROM message_embeddings e
       JOIN messages m ON m.id = e.message_id
       JOIN chats c ON c.id = m.chat_id
       ${whereClause}
       ORDER BY m.id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    res.json({ total, rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/memory/:messageId', async (req, res) => {
  try {
    const [result] = await db.query('DELETE FROM message_embeddings WHERE message_id = ?', [req.params.messageId]);
    res.json({ ok: true, deleted: result.affectedRows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, '127.0.0.1', async () => {
  console.log(`MAGI backend running on http://localhost:${PORT} (bound to loopback only)`);
  try {
    await db.query('ALTER TABLE chats ADD COLUMN pinned TINYINT(1) NOT NULL DEFAULT 0');
    console.log('[DB] Migration: added pinned column to chats');
  } catch (e) {
    if (!e.message.includes('Duplicate column')) console.warn('[DB] Migration note:', e.message);
  }

  try {
    await db.query('ALTER TABLE chats ADD COLUMN working_dir VARCHAR(500) NULL');
    console.log('[DB] Migration: added working_dir column to chats');
  } catch (e) {
    if (!e.message.includes('Duplicate column')) console.warn('[DB] Migration note:', e.message);
  }

  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS message_embeddings (
        message_id BIGINT(20) NOT NULL PRIMARY KEY,
        embedding LONGTEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
      )
    `);
    console.log('[DB] Migration: ensured message_embeddings table exists');
  } catch (e) {
    console.warn('[DB] Migration note:', e.message);
  }

  embedNewMessages(); // catch up on any un-embedded backlog at startup
});
