# adhd-reddit-med-analyzer

A full-stack TypeScript application for ADHD medication research powered by Reddit community data. Input your symptom and medication profile to find Reddit users with similar experiences and discover which medications worked for them.

## Features

- **Profile Matching** — Input your ADHD symptom/medication history and get matched to similar Reddit users via vector similarity search
- **Reddit Scraping** — Pulls medication experience narratives from r/ADHD and r/adhdwomen
- **Parallel LLM Extraction** — Uses Gemini Flash / Claude Haiku workers to extract structured medication data from posts
- **SSE Streaming** — Results streamed in real-time to the UI via Server-Sent Events
- **Semantic Search** — Nomic Embed + pgvector (Supabase) for similarity matching
- **Long-running Jobs** — `overnight-orchestrator.mjs` and `ram-monitor.mjs` for large-scale background scraping

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React + Vite + TypeScript |
| Backend | Express + TypeScript |
| Database | Supabase (pgvector) |
| Embeddings | Nomic Embed |
| LLM Extraction | Gemini Flash, Claude Haiku |
| Streaming | Server-Sent Events (SSE) |

## Project Structure

```
adhd-reddit-med-analyzer/
├── frontend/          # React/Vite UI
├── backend/           # Express API server
│   ├── scraper/       # Reddit scraping logic
│   ├── workers/       # Parallel LLM extraction workers
│   └── routes/        # SSE + REST endpoints
├── overnight-orchestrator.mjs  # Long-running scrape orchestration
└── ram-monitor.mjs             # Memory monitoring for overnight jobs
```

## How It Works

1. **Scrape** — Reddit posts from r/ADHD and r/adhdwomen are scraped and stored
2. **Extract** — Parallel LLM workers parse each post for medication names, dosages, symptom profiles, and outcomes
3. **Embed** — User profiles and post data are embedded with Nomic Embed and stored in pgvector
4. **Match** — Your input profile is embedded and similarity-searched against the database
5. **Surface** — The UI streams back matched users and the medications that worked for them

## Getting Started

```bash
# Install dependencies
npm install
cd frontend && npm install

# Set up environment variables
cp .env.example .env
# Fill in: SUPABASE_URL, SUPABASE_KEY, GEMINI_API_KEY, REDDIT_CLIENT_ID, etc.

# Run backend
npm run dev

# Run frontend (separate terminal)
cd frontend && npm run dev
```

## Long-running Jobs

```bash
# Run overnight scrape orchestrator
node overnight-orchestrator.mjs

# Monitor RAM usage during long jobs
node ram-monitor.mjs
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_KEY` | Supabase anon/service key |
| `GEMINI_API_KEY` | Google Gemini API key |
| `REDDIT_CLIENT_ID` | Reddit app client ID |
| `REDDIT_CLIENT_SECRET` | Reddit app client secret |
| `NOMIC_API_KEY` | Nomic Embed API key |
