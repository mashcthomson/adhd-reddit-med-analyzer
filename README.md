# ADHD Reddit Med Analyzer

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)
![React](https://img.shields.io/badge/React-20232A?style=flat-square&logo=react&logoColor=61DAFB)
![Supabase](https://img.shields.io/badge/Supabase-3ECF8E?style=flat-square&logo=supabase&logoColor=white)
![Gemini](https://img.shields.io/badge/Gemini_Flash-4285F4?style=flat-square&logo=google&logoColor=white)

> Finding the right ADHD medication shouldn't take 2–3 years.

---

## The problem

For most people with ADHD, finding the right medication is a long, frustrating process of trial and error. You try something for six weeks, it doesn't work, you wait a month for your next psychiatrist appointment, try something else, repeat. The average person spends **2 to 3 years** cycling through medications before landing on one that actually works.

The frustrating part is that the knowledge to shorten that search already exists. It's scattered across hundreds of thousands of Reddit posts — people sharing in detail what worked, what didn't, what side effects they experienced, what dosage adjustments helped. It's all there. It's just completely unsearchable in any meaningful way.

This app is an attempt to fix that.

---

## What it does

**ADHD Reddit Med Analyzer** mines real medication experiences from r/ADHD and r/adhdwomen, extracts structured data from them using LLMs, and uses vector similarity search to match your specific symptom and medication profile to people who've been in your exact situation — and found something that worked.

You input your symptoms, your current medications, and what hasn't worked for you. The app embeds that profile and searches it against a database of real Reddit user experiences. What comes back is a stream of the most similar profiles, showing what ultimately worked for them and why.

It's not medical advice. It's the collective experience of thousands of people who've already walked this road, surfaced intelligently and matched to you.

---

## How it works

```
Your Profile Input
        |
        v
Vector Embedding (Nomic Embed)
        |
        v
Similarity Search (pgvector / Supabase)
        |
        v
Matched Reddit Users with Similar Profiles
        |
        v
Surface: What Worked, What Didn't, and Why
        |
        v
Streamed to UI in Real-Time (SSE)
```

1. **Scrape** — Posts from r/ADHD and r/adhdwomen are collected and stored
2. **Extract** — Parallel LLM workers (Gemini Flash / Claude Haiku) parse each post for medications, dosages, symptom profiles, side effects, and outcomes
3. **Embed** — Each profile is embedded with Nomic Embed and stored in pgvector (Supabase)
4. **Match** — Your input profile is embedded and similarity-searched against the database
5. **Surface** — The app streams back the closest matches and what worked for them

---

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React + Vite + TypeScript |
| Backend | Express + TypeScript |
| Database | Supabase (pgvector) |
| Embeddings | Nomic Embed |
| LLM Extraction | Gemini Flash, Claude Haiku |
| Data Source | Reddit (r/ADHD, r/adhdwomen) |
| Streaming | Server-Sent Events (SSE) |

---

## Project structure

```
adhd-reddit-med-analyzer/
├── frontend/                       # React/Vite UI
│   └── src/
│       ├── components/             # Profile input form, results viewer
│       └── hooks/                  # SSE streaming hook
├── backend/                        # Express API server
│   ├── scraper/                    # Reddit scraping logic
│   ├── workers/                    # Parallel LLM extraction workers
│   ├── embeddings/                 # Nomic Embed integration
│   └── routes/                     # SSE + REST endpoints
├── overnight-orchestrator.mjs      # Long-running scrape orchestration
└── ram-monitor.mjs                 # Memory monitoring for overnight jobs
```

---

## Getting started

**Prerequisites:** Node.js 18+, a Supabase project with pgvector enabled

```bash
git clone https://github.com/mashcthomson/adhd-reddit-med-analyzer.git
cd adhd-reddit-med-analyzer
npm install
cd frontend && npm install && cd ..
cp .env.example .env
# Fill in your API keys
npm run dev
```

---

## Environment variables

| Variable | Description |
|---|---|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_KEY` | Supabase service role key |
| `GEMINI_API_KEY` | Google Gemini API key (LLM extraction) |
| `REDDIT_CLIENT_ID` | Reddit app client ID |
| `REDDIT_CLIENT_SECRET` | Reddit app client secret |
| `NOMIC_API_KEY` | Nomic Embed API key |

---

## Running the data pipeline

The scraper is designed to run overnight to build a large enough dataset for meaningful matching:

```bash
# Run the overnight scrape + extraction pipeline
node overnight-orchestrator.mjs

# Monitor memory usage during long jobs
node ram-monitor.mjs
```

---

## Disclaimer

This tool is for **informational and research purposes only**. It does not provide medical advice. Always consult a qualified healthcare professional before making any changes to your medication. The experiences surfaced from Reddit are individual anecdotes, not clinical recommendations.

---

## Why this matters

ADHD affects roughly 1 in 14 adults. Effective treatment is genuinely life-changing — better focus, better relationships, lower anxiety. But the years-long medication search is a well-documented problem that nobody has solved well at scale.

The knowledge to shorten it exists. This is an attempt to make it useful.

---

*Personal project – Monish Chezhian, 2024*
