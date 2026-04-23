import "dotenv/config";
import express from "express";
import axios from "axios";
import cors from "cors";
import path from "path";
import fs from "fs";
import os from "os";
import readline from "readline";
import { fileURLToPath } from "url";
import { createServer as createViteServer } from "vite";
import OpenAI from "openai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Clients ──────────────────────────────────────────────────────────────────

function makeAzureClient(deployment: string) {
  return new OpenAI({
    apiKey: process.env.AZURE_API_KEY!,
    baseURL: `${process.env.AZURE_ENDPOINT}/openai/deployments/${deployment}`,
    defaultQuery: { "api-version": process.env.AZURE_API_VERSION ?? "2024-05-01-preview" },
    defaultHeaders: { "api-key": process.env.AZURE_API_KEY! },
  });
}

const nvidiaClient = new OpenAI({
  apiKey: process.env.NVIDIA_API_KEY!,
  baseURL: "https://integrate.api.nvidia.com/v1",
});

// ─── Worker registry ──────────────────────────────────────────────────────────

interface Worker {
  type: "azure" | "nvidia";
  id: string;
  batchSize: number;
}

// Azure: deployed models from alphsbets-0138-resource
// 20K TPM → batchSize 15, 50K TPM → batchSize 35
const AZURE_WORKERS: Worker[] = [
  { type: "azure", id: "DeepSeek-R1",                    batchSize: 15 },
  { type: "azure", id: "DeepSeek-R1-0528",               batchSize: 15 },
  { type: "azure", id: "DeepSeek-V3-0324",               batchSize: 15 },
  { type: "azure", id: "DeepSeek-V3.1",                  batchSize: 15 },
  { type: "azure", id: "Kimi-K2.5",                      batchSize: 15 },
  { type: "azure", id: "Llama-3.3-70B-Instruct",         batchSize: 15 },
  { type: "azure", id: "Mistral-Large-3",                batchSize: 15 },
  { type: "azure", id: "gpt-4o",                         batchSize: 35 },
  { type: "azure", id: "grok-4-1-fast-non-reasoning",    batchSize: 35 },
  { type: "azure", id: "grok-4-20-non-reasoning",        batchSize: 35 },
  // grok-4-20-reasoning reserved as aggregator
];

// NVIDIA: free, strong instruct models only
const NVIDIA_WORKER_IDS = [
  "meta/llama-3.1-405b-instruct",
  "nvidia/llama-3.1-nemotron-ultra-253b-v1",
  "nvidia/nemotron-4-340b-instruct",
  "nvidia/llama-3.3-nemotron-super-49b-v1.5",
  "nvidia/llama-3.1-nemotron-70b-instruct",
  "qwen/qwen3.5-397b-a17b",
  "qwen/qwen3.5-122b-a10b",
  "qwen/qwen3-next-80b-a3b-instruct",
  "mistralai/mistral-large-3-675b-instruct-2512",
  "mistralai/mistral-nemotron",
  "mistralai/mistral-large-2-instruct",
  "mistralai/mixtral-8x22b-instruct-v0.1",
  "moonshotai/kimi-k2-instruct",
  "moonshotai/kimi-k2.5",
  "deepseek-ai/deepseek-v3.1-terminus",
  "deepseek-ai/deepseek-v3.2",
  "writer/palmyra-med-70b-32k",       // medical-focused, 32k ctx
  "openai/gpt-oss-120b",
  "minimaxai/minimax-m2.7",
  "ai21labs/jamba-1.5-large-instruct",
  "google/gemma-4-31b-it",
  "z-ai/glm5",
  "databricks/dbrx-instruct",
  "meta/llama-3.3-70b-instruct",
  "meta/llama-4-maverick-17b-128e-instruct",
];

const NVIDIA_WORKERS: Worker[] = NVIDIA_WORKER_IDS.map(id => ({
  type: "nvidia",
  id,
  batchSize: 20,
}));

const WORKER_POOL = (process.env.WORKER_POOL ?? "all").toLowerCase();
const ALL_WORKERS: Worker[] =
  WORKER_POOL === "azure"
    ? AZURE_WORKERS
    : WORKER_POOL === "nvidia"
      ? NVIDIA_WORKERS
      : [...AZURE_WORKERS, ...NVIDIA_WORKERS];

// Aggregator uses the reasoning model
const AGGREGATOR_DEPLOYMENT = "grok-4-20-reasoning";

// ─── Reddit helpers ───────────────────────────────────────────────────────────

const REDDIT_HEADERS = { "User-Agent": "ADHD-Med-Analyzer/1.0 by silverscopethomson" };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ─── Rate-limit-aware Reddit client ──────────────────────────────────────────
// Reddit allows ~10 req/min unauthenticated. On 429, reads Retry-After header
// and waits exactly that long. On 5xx/network errors, exponential backoff.
// Never silently skips — caller decides whether to skip after MAX_RETRIES.

const REDDIT_MIN_INTERVAL = 700; // ms between requests (~85 req/min budget, safe under 10/min with jitter)
let _lastRedditRequest = 0;

async function redditGet(url: string, maxRetries = 4): Promise<any> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Enforce minimum interval between all Reddit requests
    const now = Date.now();
    const gap = now - _lastRedditRequest;
    if (gap < REDDIT_MIN_INTERVAL) await sleep(REDDIT_MIN_INTERVAL - gap);
    _lastRedditRequest = Date.now();

    try {
      const r = await axios.get(url, {
        headers: REDDIT_HEADERS,
        timeout: 20000,
        validateStatus: s => s < 500, // don't throw on 429, handle it below
      });

      if (r.status === 429) {
        const retryAfter = parseInt(r.headers["retry-after"] || "0", 10);
        const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0;
        const wait = retryAfterMs > 0 ? Math.min(30000, retryAfterMs) : Math.min(30000, 5000 * (attempt + 1));
        if (attempt < maxRetries) { await sleep(wait); continue; }
        throw new Error(`Reddit 429 after ${maxRetries} retries`);
      }

      if (r.status === 403 || r.status === 404) {
        throw new Error(`Reddit ${r.status}`);
      }

      return r.data;
    } catch (err: any) {
      const isNetwork = err.code === "ECONNRESET" || err.code === "ETIMEDOUT" ||
                        err.message?.includes("timeout") || err.message?.includes("network");
      if (isNetwork && attempt < maxRetries) {
        await sleep(3000 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
}

// ─── Med graph extraction (regex-based, zero tokens) ─────────────────────────
// Replaces free-text narratives with compact structured graphs.
// 725 users × ~120 bytes each = ~87KB on disk vs ~900KB for full narratives.
// Worker prompts shrink from ~400 tokens/user to ~60 tokens/user (~85% reduction).

interface MedMention {
  name: string;
  outcome: "positive" | "negative" | "neutral" | "mixed";
  sides: string[];
  benefits: string[];
  switched: boolean; // user explicitly switched away from this med
}

interface UserGraph {
  username: string;
  commentCount: number;
  meds: MedMention[];
  urls: string[];
}

// Canonical med names → all aliases (lowercase)
const MED_VARIANTS: Record<string, string[]> = {
  Ritalin:        ["ritalin", "methylphenidate", "mph", "methyphenidate"],
  Vyvanse:        ["vyvanse", "lisdexamfetamine", "lisdex", "elvanse"],
  Adderall:       ["adderall", "amphetamine salts", "mixed amphetamine"],
  Concerta:       ["concerta", "osmotic release", "oros methylphenidate"],
  Focalin:        ["focalin", "dexmethylphenidate"],
  Dexedrine:      ["dexedrine", "dextroamphetamine", "dexamphetamine"],
  Strattera:      ["strattera", "atomoxetine"],
  Wellbutrin:     ["wellbutrin", "bupropion"],
  Intuniv:        ["intuniv", "guanfacine"],
  Clonidine:      ["clonidine", "catapres"],
  Qelbree:        ["qelbree", "viloxazine"],
  Modafinil:      ["modafinil", "provigil"],
  Armodafinil:    ["armodafinil", "nuvigil"],
  Prozac:         ["prozac", "fluoxetine"],
  Zoloft:         ["zoloft", "sertraline"],
  Lexapro:        ["lexapro", "escitalopram"],
  Effexor:        ["effexor", "venlafaxine"],
  Cymbalta:       ["cymbalta", "duloxetine"],
  Lamictal:       ["lamictal", "lamotrigine"],
  Lithium:        ["lithium"],
  Seroquel:       ["seroquel", "quetiapine"],
  Clonazepam:     ["clonazepam", "klonopin"],
};

const ALL_MED_KW = Object.values(MED_VARIANTS).flat();

const POSITIVE_KW = [
  "helped", "working", "love", "great", "amazing", "better", "improvement",
  "improved", "positive", "effective", "works", "life changing", "lifesaver",
  "finally", "game changer", "much better", "really helped", "definitely helped",
];
const NEGATIVE_KW = [
  "stopped", "quit", "couldn't", "terrible", "awful", "worse", "bad",
  "didn't work", "doesn't work", "failed", "not working", "gave up",
  "side effect", "horrible", "made me", "caused", "ruined", "zombie",
];
const SIDE_EFFECT_KW = [
  "anxiety", "insomnia", "appetite", "headache", "crash", "rebound",
  "nausea", "heart rate", "palpitation", "irritable", "mood", "zombie",
  "emotional", "flat", "tired", "fatigue", "tic", "jittery", "sweating",
  "stomach", "gut", "bowel", "hyperfocus", "obsessive", "tunnel vision",
];
const BENEFIT_KW = [
  "focus", "concentration", "calm", "clarity", "executive function",
  "motivation", "energy", "productive", "organized", "sleep", "mood",
  "hyperfocus", "impulse", "patience",
];
const SWITCH_KW = ["switched to", "switched from", "switched away", "changed to", "moved to", "now on", "started"];

const MED_KW = ALL_MED_KW;

function isMedRelevant(text: string) {
  const low = text.toLowerCase();
  return ALL_MED_KW.some(k => low.includes(k));
}

function extractMedGraph(snippets: string[], urls: string[]): UserGraph["meds"] {
  // Map from canonical name → accumulated signals
  const found = new Map<string, { pos: number; neg: number; sides: Set<string>; benefits: Set<string>; switched: boolean }>();

  for (const snippet of snippets) {
    const low = snippet.toLowerCase();

    for (const [canonical, variants] of Object.entries(MED_VARIANTS)) {
      if (!variants.some(v => low.includes(v))) continue;

      if (!found.has(canonical)) {
        found.set(canonical, { pos: 0, neg: 0, sides: new Set(), benefits: new Set(), switched: false });
      }
      const entry = found.get(canonical)!;

      // Score sentiment in a 150-char window around the med mention
      const idx = variants.reduce((best, v) => {
        const i = low.indexOf(v);
        return i !== -1 && (best === -1 || i < best) ? i : best;
      }, -1);

      const window = low.slice(Math.max(0, idx - 75), idx + 150);
      POSITIVE_KW.forEach(k => { if (window.includes(k)) entry.pos++; });
      NEGATIVE_KW.forEach(k => { if (window.includes(k)) entry.neg++; });
      SIDE_EFFECT_KW.forEach(k => { if (window.includes(k)) entry.sides.add(k); });
      BENEFIT_KW.forEach(k => { if (window.includes(k)) entry.benefits.add(k); });
      if (SWITCH_KW.some(k => window.includes(k))) entry.switched = true;
    }
  }

  return [...found.entries()].map(([name, e]): MedMention => {
    let outcome: MedMention["outcome"] = "neutral";
    if (e.pos > 0 && e.neg > 0) outcome = "mixed";
    else if (e.pos > e.neg) outcome = "positive";
    else if (e.neg > e.pos) outcome = "negative";
    return {
      name,
      outcome,
      sides: [...e.sides].slice(0, 5),
      benefits: [...e.benefits].slice(0, 5),
      switched: e.switched,
    };
  });
}

function flattenComments(children: any[]): any[] {
  const out: any[] = [];
  for (const c of children || []) {
    if (c.kind !== "t1") continue;
    const d = c.data;
    if (d.body && d.body !== "[deleted]" && d.body !== "[removed]" && d.author !== "AutoModerator") {
      out.push(d);
    }
    if (d.replies?.data?.children) out.push(...flattenComments(d.replies.data.children));
  }
  return out;
}


// ─── Massive Reddit scrape (disk-backed, RAM-capped) ─────────────────────────

async function scrapeReddit(
  profile: { currentMed: string; sideEffects: string[]; symptoms: string[]; freeText?: string },
  emit: (msg: string) => void
): Promise<{ narrativesFile: string; count: number }> {
  const queries = [
    `switched from ${profile.currentMed} experience`,
    `${profile.currentMed} side effects ${profile.sideEffects.slice(0, 2).join(" ")}`,
    `${profile.currentMed} not working alternatives`,
    `${profile.currentMed} anxiety hyperfocus wrong tasks`,
    `methylphenidate stopped working what next`,
    `ADHD medication switch journey`,
    `${profile.currentMed} titration dose adjustment`,
    `${profile.symptoms.slice(0, 2).join(" ")} medication experiences`,
  ];

  const SUBREDDITS = [
    "ADHD", "adhdwomen", "ADHDmeds", "TwoXADHD",
    "adhddiagnosed", "ADHD_Programmers", "adhd_anxiety", "mentalhealth",
    "Nootropics", "AuDHDers", "TrueADHD", "ADHDsupport", "Psychiatry",
  ];
  const parsedMaxQueries = Number(process.env.MAX_QUERIES ?? "");
  const queryCap = Number.isFinite(parsedMaxQueries) && parsedMaxQueries > 0
    ? Math.floor(parsedMaxQueries)
    : queries.length;
  const activeQueries = queries.slice(0, Math.min(queries.length, queryCap));

  const parsedMaxSubreddits = Number(process.env.MAX_SUBREDDITS ?? "");
  const subredditCap = Number.isFinite(parsedMaxSubreddits) && parsedMaxSubreddits > 0
    ? Math.floor(parsedMaxSubreddits)
    : SUBREDDITS.length;
  const activeSubreddits = SUBREDDITS.slice(0, Math.min(SUBREDDITS.length, subredditCap));

  const parsedMaxSearchPages = Number(process.env.MAX_SEARCH_PAGES ?? "");
  const searchPageCap = Number.isFinite(parsedMaxSearchPages) && parsedMaxSearchPages > 0
    ? Math.floor(parsedMaxSearchPages)
    : 3;

  const SORTS = ["relevance", "new", "top"];

  emit(`Starting Reddit scrape across ${activeSubreddits.length} subreddits, ${activeQueries.length} queries...`);
  if (activeSubreddits.length < SUBREDDITS.length) {
    emit(`Scope limit: using first ${activeSubreddits.length}/${SUBREDDITS.length} subreddits (MAX_SUBREDDITS=${subredditCap})`);
  }
  if (activeQueries.length < queries.length) {
    emit(`Scope limit: using first ${activeQueries.length}/${queries.length} queries (MAX_QUERIES=${queryCap})`);
  }
  if (searchPageCap < 3) {
    emit(`Scope limit: using ${searchPageCap}/3 search pages per query (MAX_SEARCH_PAGES=${searchPageCap})`);
  }

  // Phase 1: collect post IDs only — store just {id, sub} pairs, not full API objects
  const postIds = new Map<string, string>(); // id → subreddit name
  let searchCount = 0;

  for (const sub of activeSubreddits) {
    emit(`Searching r/${sub}...`);
    for (const q of activeQueries) {
      for (const sort of SORTS) {
        try {
          let after = "";
          for (let page = 0; page < searchPageCap; page++) {
            const url = `https://www.reddit.com/r/${sub}/search.json?q=${encodeURIComponent(q)}&limit=25&sort=${sort}&t=all${after ? `&after=${after}` : ""}`;
            const r = await redditGet(url);
            const children: any[] = r.data?.children || [];
            for (const p of children) {
              if (p.data?.id && !postIds.has(p.data.id)) {
                // Store only id + subreddit — discard rest of the API object
                postIds.set(p.data.id, p.data.subreddit || sub);
              }
            }
            after = r.data?.after || "";
            searchCount++;
            if (!after || children.length < 25) break;
            await sleep(150);
          }
        } catch { /* skip failed searches */ }
        await sleep(120);
      }
    }
    emit(`r/${sub} done — ${postIds.size} unique posts so far`);
  }

  emit(`Searched ${searchCount} queries → ${postIds.size} unique posts — reading comments...`);

  // Phase 2: fetch comments, build commenterMap in RAM
  // Cap per-user snippets at 5 to bound memory, and stop collecting new users
  // once we have 3× worker capacity (enough to sort by activity and pick top)
  const USER_COLLECT_CAP = MAX_WORKER_CAPACITY * 3;
  const parsedMaxPosts = Number(process.env.MAX_POSTS_TO_READ ?? "");
  const postReadCap = Number.isFinite(parsedMaxPosts) && parsedMaxPosts > 0
    ? Math.floor(parsedMaxPosts)
    : postIds.size;
  const postEntries = [...postIds.entries()].slice(0, Math.min(postIds.size, postReadCap));
  if (postEntries.length < postIds.size) {
    emit(`Limiting comment read to ${postEntries.length}/${postIds.size} posts (MAX_POSTS_TO_READ=${postReadCap})`);
  }
  const commenterMap = new Map<string, { snippets: string[]; urls: string[] }>();
  let postsFetched = 0;
  const totalPosts = postEntries.length;

  for (const [id, sub] of postEntries) {
    try {
      const r = await redditGet(
        `https://www.reddit.com/r/${sub}/comments/${id}.json?limit=500&depth=10`
      );
      const comments = flattenComments(r[1]?.data?.children || []);
      for (const c of comments) {
        if (!c.author || c.author === "[deleted]") continue;
        if (!isMedRelevant(c.body)) continue;
        if (!commenterMap.has(c.author) && commenterMap.size >= USER_COLLECT_CAP) continue;
        const e = commenterMap.get(c.author) ?? { snippets: [], urls: [] };
        if (e.snippets.length < 5) {
          e.snippets.push(c.body.slice(0, 400));
          e.urls.push(`https://reddit.com${c.permalink}`);
          commenterMap.set(c.author, e);
        }
      }
    } catch (err: any) {
      // Only skip on 403/404 (private/deleted post) — other errors already retried in redditGet
      if (!err.message?.includes("403") && !err.message?.includes("404")) {
        emit(`⚠ post ${id} error: ${err.message?.slice(0, 60)} — skipping`);
      }
    }
    postsFetched++;
    if (postsFetched % 50 === 0 || postsFetched === totalPosts) {
      emit(`Reading comments: ${postsFetched}/${totalPosts} posts — ${commenterMap.size} users found`);
    }
  }

  // Free post IDs — no longer needed
  postIds.clear();

  // Sort by activity, take only what workers can actually use
  const parsedMaxUsersToAnalyze = Number(process.env.MAX_USERS_TO_ANALYZE ?? "");
  const userAnalyzeCap = Number.isFinite(parsedMaxUsersToAnalyze) && parsedMaxUsersToAnalyze > 0
    ? Math.min(MAX_WORKER_CAPACITY, Math.floor(parsedMaxUsersToAnalyze))
    : MAX_WORKER_CAPACITY;
  const sortedUsers = [...commenterMap.entries()]
    .sort((a, b) => b[1].snippets.length - a[1].snippets.length)
    .slice(0, userAnalyzeCap);

  emit(`${commenterMap.size} med-relevant users found — using top ${sortedUsers.length} (worker capacity cap) — fetching histories...`);

  // Free commenterMap entirely now that we have sortedUsers
  commenterMap.clear();

  // Phase 3: fetch full user histories → extract compact med graph → stream to disk
  // No raw narrative text stored — just structured graph nodes (~120 bytes/user vs ~1200).
  // Worker prompts shrink ~85% in tokens.
  const narrativesFile = narrativeTempPath();
  let writtenCount = 0;
  const totalUsers = sortedUsers.length;
  const CONCURRENCY = 10;

  async function fetchUserHistory(username: string, entry: { snippets: string[]; urls: string[] }): Promise<UserGraph> {
    try {
      const [rNew, rTop] = await Promise.allSettled([
        redditGet(`https://www.reddit.com/user/${encodeURIComponent(username)}/comments.json?limit=200&sort=new`),
        redditGet(`https://www.reddit.com/user/${encodeURIComponent(username)}/comments.json?limit=200&sort=top`),
      ]);

      const seenIds = new Set<string>();
      const allSnippets: string[] = [...entry.snippets];
      for (const result of [rNew, rTop]) {
        if (result.status !== "fulfilled") continue;
        for (const c of result.value.data?.children || []) {
          if (seenIds.has(c.data.id) || !c.data.body || !isMedRelevant(c.data.body)) continue;
          seenIds.add(c.data.id);
          allSnippets.push(c.data.body.slice(0, 400));
        }
      }

      return {
        username,
        commentCount: allSnippets.length,
        meds: extractMedGraph(allSnippets, entry.urls),
        urls: entry.urls.slice(0, 3),
      };
    } catch {
      return {
        username,
        commentCount: entry.snippets.length,
        meds: extractMedGraph(entry.snippets, entry.urls),
        urls: entry.urls.slice(0, 3),
      };
    }
  }

  for (let i = 0; i < sortedUsers.length; i += CONCURRENCY) {
    const chunk = sortedUsers.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      chunk.map(([username, entry]) => fetchUserHistory(username, entry))
    );
    // Sort chunk by activity before writing so the JSONL file is already sorted
    results.sort((a, b) => b.commentCount - a.commentCount);
    for (const r of results) appendNarrative(narrativesFile, r);
    writtenCount += results.length;
    if (writtenCount % 100 === 0 || writtenCount === totalUsers) {
      emit(`User histories: ${writtenCount}/${totalUsers} written to disk`);
    }
    await sleep(150);
  }

  emit(`Streamed ${writtenCount} user histories to disk — distributing across ${ALL_WORKERS.length} models...`);
  return { narrativesFile, count: writtenCount };
}

// ─── Max users workers can actually consume ───────────────────────────────────

const MAX_WORKER_CAPACITY = ALL_WORKERS.reduce((s, w) => s + w.batchSize, 0);

// ─── Disk-backed narrative store ──────────────────────────────────────────────

// Instead of holding all narratives in RAM, stream them to a temp JSONL file.
// Workers read only their assigned slice from disk — peak RAM stays flat.

function narrativeTempPath(): string {
  return path.join(os.tmpdir(), `adhd-narratives-${Date.now()}.jsonl`);
}

function appendNarrative(filePath: string, narrative: any): void {
  fs.appendFileSync(filePath, JSON.stringify(narrative) + "\n", "utf8");
}

async function readNarrativeSlice(filePath: string, start: number, count: number): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const results: any[] = [];
    let lineIdx = 0;
    const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
    rl.on("line", line => {
      if (lineIdx >= start && lineIdx < start + count && line.trim()) {
        try { results.push(JSON.parse(line)); } catch { /* skip malformed */ }
      }
      lineIdx++;
      if (lineIdx >= start + count) rl.close();
    });
    rl.on("close", () => resolve(results));
    rl.on("error", reject);
  });
}

function countNarrativeLines(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let count = 0;
    const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
    rl.on("line", l => { if (l.trim()) count++; });
    rl.on("close", () => resolve(count));
    rl.on("error", reject);
  });
}

// ─── Batch distribution (disk-backed) ────────────────────────────────────────

interface WorkerSlice {
  worker: Worker;
  start: number;
  count: number;
}

function distributeSlices(totalNarratives: number): WorkerSlice[] {
  const slices: WorkerSlice[] = [];
  let idx = 0;
  for (const worker of ALL_WORKERS) {
    if (idx >= totalNarratives) break;
    const count = Math.min(worker.batchSize, totalNarratives - idx);
    slices.push({ worker, start: idx, count });
    idx += count;
  }
  return slices;
}

// ─── Per-model analysis ───────────────────────────────────────────────────────

const WORKER_SYSTEM = `You are an expert ADHD Medication Analyst. You receive structured medication graph data extracted from Reddit users — not raw text. Each user entry shows which meds they used, outcomes (positive/negative/mixed/neutral), side effects, and benefits detected from their comments. Respond with valid JSON only — no markdown, no code fences, no explanation. Max 5 suggestedAlternatives, max 15 matches.`;

function workerUserPrompt(profile: any, graphs: UserGraph[]): string {
  // Format each user as a compact single line — ~60 tokens vs ~400 for raw narrative
  const graphBlock = graphs.map(u => {
    const medStr = u.meds.length === 0
      ? "no meds detected"
      : u.meds.map(m => {
          const parts = [`${m.name}→${m.outcome}`];
          if (m.sides.length) parts.push(`sides:[${m.sides.join(",")}]`);
          if (m.benefits.length) parts.push(`benefits:[${m.benefits.join(",")}]`);
          if (m.switched) parts.push("switched_away");
          return parts.join(" ");
        }).join(" | ");
    return `${u.username}(${u.commentCount}c): ${medStr} [${u.urls[0] || ""}]`;
  }).join("\n");

  // Highlight which users share the same current med + similar side effects
  const profileMedLow = (profile.currentMed?.name || "").toLowerCase();
  const profileSidesLow = (profile.sideEffects || []).map((s: string) => s.toLowerCase());
  const similarUsers = graphs
    .filter(u => u.meds.some(m =>
      m.name.toLowerCase().includes(profileMedLow) ||
      profileMedLow.includes(m.name.toLowerCase())
    ))
    .map(u => u.username);

  return `Match this user's profile against Reddit medication graphs and return a JSON analysis.

USER PROFILE:
- Current Med: ${profile.currentMed?.name} (${profile.currentMed?.dose}mg), Effectiveness: ${profile.currentMed?.effectiveness}/10
- Side Effects from current med: ${profile.sideEffects?.join(", ")}
- Symptoms: ${profile.coreSymptoms?.join(", ")}
- Wants: ${profile.priorities?.join(", ")}
- Notes: ${profile.freeText || "None"}

USERS WHO ALSO USED ${profile.currentMed?.name}: ${similarUsers.length > 0 ? similarUsers.join(", ") : "none in this batch"}

MEDICATION GRAPHS (${graphs.length} users — format: username(comments): med→outcome sides:[...] benefits:[...]):
${graphBlock}

INSTRUCTIONS:
1. Find users who used ${profile.currentMed?.name} and switched — what did they switch to and was it positive?
2. Find users with same side effects (${profileSidesLow.join(", ")}) — what helped them?
3. Rank medication alternatives by frequency of positive outcomes in similar users.
4. Score similarity based on: same starting med, overlapping side effects, overlapping symptoms.

Return ONLY this JSON:
{
  "workerModel": "<your model id>",
  "suggestedAlternatives": [{"medName":"string","confidenceScore":0.0,"supportingUserCount":0,"summary":"string","examples":[{"snippet":"string","url":"string"}]}],
  "matches": [{"username":"string","similarityScore":0.0,"medHistory":[{"medName":"string","outcome":"string","sentiment":"better|worse|neutral","snippet":"string","url":"string"}],"reasoning":"string"}]
}`;
}

function cleanJson(raw: string): string {
  // Strip DeepSeek think tags
  return raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^```(?:json)?\n?/im, "")
    .replace(/\n?```$/im, "")
    .trim();
}

async function runWorker(
  worker: Worker,
  profile: any,
  narrativesFile: string,
  slice: WorkerSlice,
  emit: (msg: string) => void
): Promise<any | null> {
  if (slice.count === 0) return null;

  // Read only this worker's slice from disk — compact graph objects, not raw text
  const graphs: UserGraph[] = await readNarrativeSlice(narrativesFile, slice.start, slice.count);
  if (graphs.length === 0) return null;

  const prompt = workerUserPrompt(profile, graphs);

  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      let content: string;

      if (worker.type === "azure") {
        const client = makeAzureClient(worker.id);
        const completion = await client.chat.completions.create({
          model: worker.id,
          messages: [
            { role: "system", content: WORKER_SYSTEM },
            { role: "user", content: prompt },
          ],
          temperature: 0.2,
          max_tokens: 6000,
        });
        content = completion.choices[0]?.message?.content || "{}";
      } else {
        const completion = await nvidiaClient.chat.completions.create({
          model: worker.id,
          messages: [
            { role: "system", content: WORKER_SYSTEM },
            { role: "user", content: prompt },
          ],
          temperature: 0.2,
          max_tokens: 6000,
        });
        content = completion.choices[0]?.message?.content || "{}";
      }

      const cleaned = cleanJson(content);
      const result = JSON.parse(cleaned);
      result.workerModel = worker.id;
      result.usersAnalyzed = slice.count;
      emit(`✓ ${worker.id} (${slice.count} users)`);
      return result;

    } catch (err: any) {
      const is429 = err?.status === 429 || err?.message?.includes("429") || err?.message?.includes("rate");
      const isConn = err?.message?.includes("Connection") || err?.message?.includes("ECONNRESET") ||
                     err?.message?.includes("ETIMEDOUT") || err?.message?.includes("network") ||
                     err?.code === "ECONNRESET" || err?.code === "ETIMEDOUT";
      const isJson = err instanceof SyntaxError;

      if ((is429 || isConn) && attempt < maxRetries - 1) {
        const wait = is429 ? 15000 * (attempt + 1) : 8000 * (attempt + 1);
        emit(`↻ ${worker.id} retry ${attempt + 1} in ${wait / 1000}s (${is429 ? "rate limit" : "connection"})`);
        await sleep(wait);
        continue;
      }
      if (isJson) {
        emit(`⚠ ${worker.id} malformed JSON — skipping`);
      } else {
        emit(`⚠ ${worker.id} failed: ${err.message?.slice(0, 80)}`);
      }
      return null;
    }
  }
  return null;
}

// ─── Final aggregation ────────────────────────────────────────────────────────

async function aggregate(profile: any, workerResults: any[]): Promise<any> {
  const validResults = workerResults.filter(Boolean);

  // Compact summary of all worker outputs
  const summary = validResults.map(r =>
    `=== ${r.workerModel} (${r.usersAnalyzed} users) ===\n` +
    `Alternatives: ${(r.suggestedAlternatives || []).map((a: any) =>
      `${a.medName}(score:${a.confidenceScore},n:${a.supportingUserCount})`
    ).join(", ")}\n` +
    `Top matches: ${(r.matches || []).slice(0, 5).map((m: any) =>
      `${m.username}(sim:${m.similarityScore})`
    ).join(", ")}`
  ).join("\n\n");

  // Pass full data for top matches too
  const allMatches = validResults.flatMap(r => r.matches || []);
  const allAlts = validResults.flatMap(r => r.suggestedAlternatives || []);

  const client = makeAzureClient(AGGREGATOR_DEPLOYMENT);

  const completion = await client.chat.completions.create({
    model: AGGREGATOR_DEPLOYMENT,
    messages: [
      {
        role: "system",
        content: "You are a senior ADHD medication analyst. Aggregate multiple AI model analyses into a single authoritative result. Return valid JSON only, no markdown.",
      },
      {
        role: "user",
        content: `You received analyses from ${validResults.length} different AI models (${ALL_WORKERS.length} total workers) covering hundreds of Reddit users.

USER PROFILE:
- Current Med: ${profile.currentMed?.name} (${profile.currentMed?.dose}mg)
- Symptoms: ${profile.coreSymptoms?.join(", ")}
- Side Effects: ${profile.sideEffects?.join(", ")}
- Wants: ${profile.priorities?.join(", ")}
- Notes: ${profile.freeText || "None"}

WORKER SUMMARIES:
${summary}

ALL SUGGESTED ALTERNATIVES (raw from all models):
${JSON.stringify(allAlts.slice(0, 100), null, 1)}

TOP SIMILAR USERS (raw from all models):
${JSON.stringify(allMatches.slice(0, 100), null, 1)}

INSTRUCTIONS:
1. Merge all suggested alternatives — combine scores weighted by supporting user counts
2. Deduplicate users across models — keep the highest similarity score entry
3. Re-rank everything by aggregated evidence
4. Include how many models mentioned each alternative
5. Produce the definitive analysis

Return ONLY this JSON:
{
  "modelsUsed": ${validResults.length},
  "totalUsersAnalyzed": <sum>,
  "suggestedAlternatives": [{"medName":"string","confidenceScore":0.0,"supportingUserCount":0,"modelAgreement":0,"summary":"string","examples":[{"snippet":"string","url":"string"}]}],
  "matches": [{"username":"string","similarityScore":0.0,"medHistory":[{"medName":"string","outcome":"string","sentiment":"better|worse|neutral","snippet":"string","url":"string"}],"reasoning":"string"}],
  "insight": "string (2-3 sentence overall synthesis)"
}`,
      },
    ],
    temperature: 0.1,
    max_tokens: 10000,
  });

  const raw = completion.choices[0]?.message?.content || "{}";
  return JSON.parse(cleanJson(raw));
}

// ─── Server ───────────────────────────────────────────────────────────────────

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT ?? 3000);

  app.use(cors());
  app.use(express.json({ limit: "8mb" }));

  app.post("/api/full-analysis", async (req, res) => {
    const { userProfile } = req.body;
    if (!userProfile) return res.status(400).json({ error: "userProfile required" });

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const send = (event: string, data: any) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    let narrativesFile: string | null = null;
    try {
      // 1. Massive Reddit scrape — narratives streamed to disk, not held in RAM
      const scraped = await scrapeReddit(
        {
          currentMed: userProfile.currentMed?.name,
          sideEffects: userProfile.sideEffects,
          symptoms: userProfile.coreSymptoms,
          freeText: userProfile.freeText,
        },
        msg => send("progress", { message: msg })
      );

      narrativesFile = scraped.narrativesFile;

      if (scraped.count === 0) {
        send("error", { message: "Reddit returned no results. Wait 30s and try again." });
        return res.end();
      }

      // 2. Compute disk-backed slices — no in-memory narrative array
      const slices = distributeSlices(scraped.count);
      send("progress", { message: `Launching ${slices.length} models (staggered 8 at a time to cap RAM)...` });

      // 3. Run workers in staggered batches of 8 — limits concurrent RAM from prompt strings
      const WORKER_CONCURRENCY = 8;
      const workerResults: any[] = [];

      for (let i = 0; i < slices.length; i += WORKER_CONCURRENCY) {
        const batch = slices.slice(i, i + WORKER_CONCURRENCY);
        const batchResults = await Promise.all(
          batch.map(slice =>
            runWorker(slice.worker, userProfile, narrativesFile!, slice, msg => send("progress", { message: msg }))
          )
        );
        workerResults.push(...batchResults);
        const doneCount = Math.min(i + WORKER_CONCURRENCY, slices.length);
        send("progress", { message: `Worker batch complete: ${doneCount}/${slices.length} models done` });
      }

      const succeeded = workerResults.filter(Boolean).length;

      if (succeeded === 0) {
        send("error", { message: "All models failed (likely network issue). Reddit data was collected — please retry the analysis part." });
        return res.end();
      }

      send("progress", { message: `${succeeded}/${slices.length} models succeeded — aggregating with ${AGGREGATOR_DEPLOYMENT}...` });

      // 4. Aggregate with reasoning model
      const final = await aggregate(userProfile, workerResults);
      send("result", final);

    } catch (err: any) {
      console.error("full-analysis error:", err.message);
      send("error", { message: err.message || "Analysis failed" });
    } finally {
      // Always clean up the temp narrative file
      if (narrativesFile && fs.existsSync(narrativesFile)) {
        fs.unlinkSync(narrativesFile);
      }
    }

    res.end();
  });

  // Reddit proxy endpoints (kept for compatibility)
  app.get("/api/reddit/search", async (req, res) => {
    try {
      const { q, subreddit, limit = 25 } = req.query;
      const subPath = subreddit ? `r/${subreddit}/` : "";
      const r = await redditGet(`https://www.reddit.com/${subPath}search.json?q=${encodeURIComponent(q as string)}&limit=${limit}&sort=relevance&t=all`);
      res.json(r);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.get("/api/reddit/post-comments", async (req, res) => {
    try {
      const { postId, subreddit = "ADHD" } = req.query;
      const r = await redditGet(`https://www.reddit.com/r/${subreddit}/comments/${postId}.json?limit=500&depth=10`);
      res.json(r);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.get("/api/reddit/user-history", async (req, res) => {
    try {
      const { username } = req.query;
      const r = await redditGet(`https://www.reddit.com/user/${encodeURIComponent(username as string)}/comments.json?limit=200&sort=new`);
      res.json(r);
    } catch (e: any) {
      if (e.response?.status === 404 || e.response?.status === 403) res.json({ data: { children: [] } });
      else res.status(500).json({ error: e.message });
    }
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, r) => r.sendFile(path.join(distPath, "index.html")));
  }

  app.listen(PORT, "0.0.0.0", () => console.log(`Server running on http://localhost:${PORT}`));
}

startServer();
