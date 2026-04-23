# Folder Info: `adhd-reddit-med-analyzer`

Generated on: 2026-04-20

This folder is a TypeScript full-stack app for ADHD medication experience analysis using Reddit data, with a React/Vite frontend and an Express/LLM backend.

## Quick stats

- Files (excluding `.git`, `node_modules`, `graphify-out\cache`): **60**
- Most common file types: `.tsx` (28), `.json` (13), `.ts` (5), `.md` (3)

## Top-level structure

- `src/` - Main frontend app (`main.tsx`, `App.tsx`, `components/`, `lib/`)
- `server.ts` - API server, Reddit scrape pipeline, worker orchestration, SSE responses
- `logs/` - Runtime outputs (for example `adhd-analysis-result.json`, `overnight.log`)
- `graphify-out/` - Graph artifacts (`GRAPH_REPORT.md`, `graph.json`, `graph.html`, `manifest.json`, `cost.json`)
- `components/` - Secondary UI component tree (duplicates many files in `src/components/ui`)
- `overnight-orchestrator.mjs` - Overnight execution/monitoring script
- `ram-monitor.mjs` - Memory watchdog script
- `package.json`, `vite.config.ts`, `tsconfig.json` - Build/runtime config

## API + app flow

1. Frontend mounts via `src/main.tsx` and runs `src/App.tsx`.
2. UI sends a request to `POST /api/full-analysis`.
3. `server.ts` scrapes Reddit data and prepares narratives.
4. Work is distributed to model workers and aggregated.
5. Server streams progress + final result back to UI (SSE).

## Notable routes

- `POST /api/full-analysis`
- `GET /api/reddit/search`
- `GET /api/reddit/post-comments`
- `GET /api/reddit/user-history`

## Graphified view (Mermaid)

```mermaid
flowchart TD
  A[React UI: src/App.tsx] -->|SSE request| B[/api/full-analysis]
  B --> C[Reddit scrape + narrative prep]
  C --> D[Parallel worker models]
  D --> E[Aggregate final analysis]
  E -->|result/progress/error| A
  B -.-> F[logs/adhd-analysis-result.json]
  G[overnight-orchestrator.mjs] --> H[logs/overnight.log]
```

## Notes

- There are two similar UI trees:
  - `components/ui/*.tsx`
  - `src/components/ui/*.tsx`
- Current app imports UI from `src/components/ui`.
