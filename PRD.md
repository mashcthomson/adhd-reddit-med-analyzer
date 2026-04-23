# Product Requirements Document (PRD)

## 1. Overview
**Product name:** ADHD Reddit Med‑Analyzer  
**Owner:** ClaudeBot (AI Assistant) & Founding Team  
**Date / Version:** 14 Apr 2026 v0.2 (Updated with Architecture & Stack)  

**Goal:** Enable an ADHD patient to input their symptom/medication profile, automatically analyze ADHD‑related subreddits, find users with similar experiences, and surface which alternative medications or strategies worked better for those peers.  

## 2. Problem & Motivation
**Problem:** Manually searching Reddit for medication experiences is time‑consuming, fragmented, and prone to bias; patients often try many medications over months before finding a better fit.  
**Why this product:** Reddit contains rich, real‑world narratives about medication effects, side effects, and switches; aggregating and matching these stories can shorten the trial‑and‑error cycle.  

**Out of scope (v1):**
* Providing medical advice or prescribing medication.
* Analyzing non‑Reddit sources (e.g., forums, clinical trials).
* Real‑time streaming of new posts (periodic refresh/batch processing is sufficient).

## 3. Reference Architecture & Technology Stack
To run this efficiently and cost-effectively, we have selected the following stack:

*   **Frontend/Backend Framework:** **Next.js (React, TypeScript)**. Great for rapid prototyping and seamless API integration.
*   **Database & Vector Search:** **PostgreSQL with `pgvector`** (e.g., hosted on Supabase). This will handle user profiles and store embeddings to perform the mathematical similarity matching requested (symptom pattern match, priority alignment).
*   **Data Collection (Scraping Reddit):** 
    *   **Apify (Reddit Scraper)** or **PRAW (Python Reddit API Wrapper)** for controlled rate-limited endpoints. Since Reddit's API changes, Apify provides a resilient, proxy-backed way to extract historical threads from `r/ADHD`, `r/adhdwomen`, etc.
*   **LLM for Data Extraction & Normalization (The "Cheaper Model"):**
    *   **Primary Choice: Gemini 1.5 Flash** or **Claude 3.5 Haiku**. 
    *   **Why:** Both models are ridiculously fast, incredibly cheap (e.g., <$0.25 per 1M input tokens), and have massive context windows. They are perfect for reading massive, messy Reddit threads, standardizing colloquial terms (like “wired”, “zonked” -> “hyperactive,” “fatigued”), and parsing them into the structured `RedditUserProfile` JSON schema.
*   **Embeddings Model:** **Nomic Embed Text** or **OpenAI `text-embedding-3-small`**. Extremely cheap text vectorization models to map out user symptom similarities.

## 4. Target Users
*   **Primary:** Adults with ADHD considering a medication change.
*   **Secondary:** Clinicians or ADHD coaches who want quick, evidence‑based peer insights.

## 5. Success Metrics (v1)
*   **Match quality:** ≥80% of top‑3 suggested alternatives corroborated by ≥2 independent reports.
*   **Response time:** End‑to‑end analysis < 30 seconds.
*   **User satisfaction:** Post‑use survey scores ≥4/5 on usefulness.

## 6. Functional Requirements

### 6.1 Input & Profile Modeling
*   Accept free‑text description or a structured JSON object.
*   Core ADHD symptoms, current medication & dose, effectiveness (0‑10), side‑effect checklist, desired improvements.
*   Normalize input into the internal `UserProfile` schema using the chosen LLM.

### 6.2 Data Collection (Reddit)
*   **Target subreddits:** `r/ADHD`, `r/adhdwomen`, `r/ADHDparenting`, `r/TwoXADHD`, `r/ADHDteen`
*   **Offline Batching:** Pre-scrape the past 6-12 months of top med-related threads, process them via the LLM (Gemini 1.5 Flash), and store them in the database to keep application real-time response fast and cheap.
*   **Extraction details:** Medications tried, subjective effects, side-effects reported, explicit switches, outcome sentiment.

### 6.3 Similarity & Matching
*   **Similarity Score Calculation:** Represent `UserProfile` and `RedditUserProfile` as vector embeddings in `pgvector`. Combine this with a weighted algorithm for:
    *   Symptom pattern match
    *   Medication experience
    *   Side‑effect cluster overlap
    *   Priority alignment
*   Produce a ranked list of alternative meds/strategies with representative Reddit excerpts.

### 6.4 Output & UX
*   **Display:** Ranked alternatives, confidence score, supporting user count.
*   **UI Elements:** Collapsible snippet cards linking to the original Reddit thread.
*   **Disclaimer:** "This tool aggregates anecdotal reports; it is not a substitute for professional medical advice."

## 7. Non‑Functional Requirements
*   **Performance:** End‑to‑end latency ≤30s. Offline batching of Reddit data guarantees instantaneous UI loads.
*   **Scalability:** Handle 500 concurrent users. Database reads only.
*   **Privacy/Ethics:** Store only Reddit usernames/public text. Clear disclaimers. Mobile‑responsive UI, ARIA accessible.

## 8. Data Model Sketch (JSON)
*(Matches the original requirements exactly)*

**UserProfile (input)**
```json
{
  "user_id": "string",
  "core_symptoms": ["task_initiation","prioritisation","hyperfocus"],
  "current_med": {"name":"Ritalin","dose_mg":10,"formulation":"IR"},
  "effectiveness_score": 5,
  "side_effects": ["appetite_loss","insomnia"],
  "priorities": [{"factor":"less_restlessness","weight":0.3}]
}
```

**RedditUserProfile (built from scraped data)**
```json
{
  "username": "string",
  "med_history": [
    {
      "med_name":"Vyvanse",
      "dose_mg":30,
      "period_start":"2024-03",
      "period_end":"2024-09",
      "effectiveness":7,
      "reported_effects":["better focus","less jitter"],
      "reported_side_effects":["dry_mild_headache"],
      "switch_to":null,
      "outcome":"same"
    }
  ],
  "symptom_tags":["task_initiation_issues"],
  "side_effect_tags":["appetite_loss"]
}
```

## 9. Open Questions & Addressed Gaps
*   **How far back should Reddit scraping go?** *Resolved:* Start with the last 12 months to maintain high relevance regarding modern medication formulations/shortages, processed offline to save real-time scraping costs/rate limits.
*   **Normalizing colloquial language?** *Resolved:* The extraction pipeline runs all scraped text through Gemini 1.5 Flash (or Claude 3.5 Haiku) with a strict system prompt to map words like "zonked" to standard medical terms ("fatigue/sedation").
*   **Vulnerability to Rate Limits?** *Resolved:* By batch processing via Apify and storing locally in PostgreSQL + pgvector, the user-facing web app does virtually zero live parsing, protecting against Reddit API throttling.