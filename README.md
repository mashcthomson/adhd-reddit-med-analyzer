# ADHD Reddit Med Analyzer

> **Finding the right ADHD medication shouldn't take 2–3 years.**

For most people with ADHD, the path to effective treatment is a long, frustrating process of trial and error. The average person cycles through multiple medications, multiple dosages, and multiple failures — often spending **2 to 3 years** before finding something that actually works. During that time, symptoms go unmanaged, quality of life suffers, and the emotional toll adds up.

This tool exists to shorten that journey.

---

## What It Does

**ADHD Reddit Med Analyzer** is a full-stack TypeScript application that mines real medication experiences shared on Reddit (r/ADHD, r/adhdwomen) and uses vector similarity search to match your specific symptom and medication profile to people who've been in your exact situation — and found something that worked.

Instead of starting from scratch, you can see:
- Which medications worked for people with **your symptom profile**
- Which medications failed, and **why** (side effects, tolerance, dosage issues)
- What dosage adjustments or combinations others found effective
- Patterns across people who had the **same prior medication failures as you**

It's not medical advice. It's the collective experience of thousands of people who've already walked this road — surfaced intelligently and matched to you.

---

## The Problem It Solves

ADHD medication management is notoriously slow because:

- **Psychiatrist appointments are infrequent** — often monthly or less
- **Each medication trial takes weeks** to assess properly
- **There's no systematic way** to learn from others with similar profiles
- **Reddit has years of rich, detailed experiences** — but it's unsearchable in any meaningful way

This app changes that last point. It treats Reddit as a structured dataset, extracts medication outcomes using LLMs, and makes that knowledge searchable by symptom and experience similarity.

---

## How It Works

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
3. **Embed** — Each user profile and post is embedded with Nomic Embed and stored in pgvector (Supabase)
4. **Match** — You input your symptoms, current/past medications, and what hasn't worked. That profile is embedded and similarity-searched against the database
5. **Surface** — The app streams back the most similar Reddit users and what ultimately worked for them

---

## Tech Stack

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

## Project Structure

```
adhd-reddit-med-analyzer/
├── frontend/                      # React/Vite UI
│   └── src/
│       ├── components/            # Profile input form, results viewer
│       └── hooks/                 # SSE streaming hook
├── backend/                       # Express API server
│   ├── scraper/                   # Reddit scraping logic
│   ├── workers/                   # Parallel LLM extraction workers
│   ├── embeddings/                # Nomic Embed integration
│   └── routes/                    # SSE + REST endpoints
├── overnight-orchestrator.mjs     # Long-running scrape orchestration
└── ram-monitor.mjs                # Memory monitoring for overnight jobs
```

---

## Getting Started

**Prerequisites:** Node.js 18+, a Supabase project with pgvector enabled

```bash
# Clone the repo
git clone https://github.com/mashcthomson/adhd-reddit-med-analyzer.git
cd adhd-reddit-med-analyzer

# Install dependencies
npm install
cd frontend && npm install && cd ..

# Configure environment
cp .env.example .env
# Fill in your API keys (see Environment Variables below)

# Start backend
npm run dev

# Start frontend (separate terminal)
cd frontend && npm run dev
```

---

## Long-running Data Jobs

The scraper is designed to run overnight to build up a large enough dataset for meaningful matching.

```bash
# Run the overnight scrape + extraction pipeline
node overnight-orchestrator.mjs

# Monitor memory usage during long jobs
node ram-monitor.mjs
```

---

## Environment Variables

| Variable | Description |
|---|---|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_KEY` | Supabase service role key |
| `GEMINI_API_KEY` | Google Gemini API key (LLM extraction) |
| `REDDIT_CLIENT_ID` | Reddit app client ID |
| `REDDIT_CLIENT_SECRET` | Reddit app client secret |
| `NOMIC_API_KEY` | Nomic Embed API key |

---

## Disclaimer

This tool is for **informational and research purposes only**. It does not provide medical advice. Always consult a qualified healthcare professional before making any changes to your medication. The experiences surfaced from Reddit reflect individual anecdotes and are not clinical recommendations.

---

## Why This Matters

ADHD affects roughly 1 in 14 adults. Effective treatment is life-changing — improved focus, better relationships, reduced anxiety, higher functioning. But the years-long medication search is a known, well-documented problem that nobody has solved well.

The knowledge to shorten that search already exists. It's scattered across hundreds of thousands of Reddit posts. This app is an attempt to make it useful.
