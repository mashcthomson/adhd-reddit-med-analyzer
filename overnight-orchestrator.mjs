/**
 * overnight-orchestrator.mjs
 *
 * Autonomous overnight controller:
 *   1. Watches ADHD analysis stream → saves result when done
 *   2. Waits for ADHD analysis to fully finish (RAM drops back below 65%)
 *   3. Launches seek scrapers (Chrome + Python)
 *   4. Checks scrapers healthy after 5 min
 *   5. Waits for scrapers to complete (watches log files for FINISHED markers)
 *   6. Kills Chrome instances
 *   7. 2-hour countdown → launches seek bots (once mode)
 *   8. Logs everything to adhd-reddit-med-analyzer/logs/overnight.log
 *
 * Usage: node overnight-orchestrator.mjs
 */

import os from "os";
import fs from "fs";
import path from "path";
import { execSync, spawn } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE  = path.join(__dirname, "logs", "overnight.log");
const RESULT_FILE = path.join(__dirname, "logs", "adhd-analysis-result.json");
const STREAM_FILE = path.join(os.tmpdir(), "analysis-stream.log");

const SEEK_DIR  = "C:\\Users\\claudebot\\Claudes\\computer-use-preview";
const CHROME    = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const SCRAPER_LOG_DIR = path.join(SEEK_DIR, "logs");

const CHROME_PROFILES = [
  { port: 9223, dir: "C:\\Users\\claudebot\\chrome_seek",   name: "seek1" },
  { port: 9225, dir: "C:\\Users\\claudebot\\chrome_seek_2", name: "seek2" },
  { port: 9226, dir: "C:\\Users\\claudebot\\chrome_seek_3", name: "seek3" },
];

const SCRAPERS = [
  { script: "scrapers\\scraper_seek_1.py", logSuffix: "seek_1", finishMarker: "SCRAPER 1 FINISHED" },
  { script: "scrapers\\scraper_seek_2.py", logSuffix: "seek_2", finishMarker: "SCRAPER 2 FINISHED" },
  { script: "scrapers\\scraper_seek_3.py", logSuffix: "seek_3", finishMarker: "SCRAPER 3 FINISHED" },
];

const BOTS = [
  { script: "bots\\seek_bot_1.py" },
  { script: "bots\\seek_bot_2.py" },
  { script: "bots\\seek_bot_3.py" },
];

fs.mkdirSync(path.join(__dirname, "logs"), { recursive: true });

function log(msg) {
  const ts = new Date().toLocaleTimeString("en-AU", { hour12: false });
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + "\n", "utf8");
}

function ramPct() {
  return Math.round((1 - os.freemem() / os.totalmem()) * 100);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function psRun(cmd) {
  try {
    return execSync(`powershell.exe -ExecutionPolicy Bypass -Command "${cmd}"`, {
      encoding: "utf8", timeout: 30000
    }).trim();
  } catch { return ""; }
}

// ─── Phase 1: Watch ADHD analysis stream for result ──────────────────────────

async function waitForAdhdResult() {
  log("Phase 1: Watching ADHD analysis stream for completion...");
  let lastSize = 0;
  let stallCount = 0;
  const MAX_STALL_CYCLES = 60; // 60 × 30s = 30 min stall timeout

  while (true) {
    await sleep(30000);

    if (!fs.existsSync(STREAM_FILE)) {
      log("  Stream file missing — analysis may have ended. Checking...");
      stallCount++;
      if (stallCount > 5) { log("  Stream gone for 2.5min — assuming done."); return null; }
      continue;
    }

    const content = fs.readFileSync(STREAM_FILE, "utf8");
    const currentSize = content.length;

    // Check for result event
    const resultMatch = content.match(/event: result\ndata: ({.+})/s);
    if (resultMatch) {
      try {
        const result = JSON.parse(resultMatch[1]);
        fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2), "utf8");
        log(`  ✅ ADHD analysis COMPLETE — result saved to ${RESULT_FILE}`);
        log(`  Models used: ${result.modelsUsed || "?"} | Users analyzed: ${result.totalUsersAnalyzed || "?"}`);
        if (result.suggestedAlternatives?.length) {
          log(`  Top alternatives:`);
          result.suggestedAlternatives.slice(0, 5).forEach(a => {
            log(`    ${a.medName} (score: ${a.confidenceScore}, n=${a.supportingUserCount})`);
          });
        }
        if (result.insight) log(`  Insight: ${result.insight}`);
        return result;
      } catch (e) {
        log(`  Result parse error: ${e.message}`);
      }
    }

    // Check for error event
    const errorMatch = content.match(/event: error\ndata: ({.+})/);
    if (errorMatch) {
      try {
        const err = JSON.parse(errorMatch[1]);
        log(`  ❌ Analysis error: ${err.message}`);
        fs.writeFileSync(RESULT_FILE, JSON.stringify({ error: err.message, timestamp: new Date().toISOString() }, null, 2));
        return null;
      } catch {}
    }

    // Progress reporting
    if (currentSize > lastSize) {
      stallCount = 0;
      const lastProgress = content.match(/data: \{"message":"([^"]+)"\}/g);
      if (lastProgress) {
        const last = lastProgress[lastProgress.length - 1].match(/"([^"]+)"\}/)?.[1];
        log(`  Progress: ${last} | RAM: ${ramPct()}%`);
      }
      lastSize = currentSize;
    } else {
      stallCount++;
      log(`  No new progress (${stallCount}/${MAX_STALL_CYCLES}) | RAM: ${ramPct()}%`);
      if (stallCount >= MAX_STALL_CYCLES) {
        log("  Stalled for 30min — saving partial result and moving on.");
        fs.writeFileSync(RESULT_FILE, JSON.stringify({ error: "stalled", streamContent: content.slice(-2000), timestamp: new Date().toISOString() }, null, 2));
        return null;
      }
    }
  }
}

// ─── Wait for RAM to settle after ADHD analysis ──────────────────────────────

async function waitForRamToClear(targetPct = 65, maxWaitMin = 10) {
  log(`Waiting for RAM to drop below ${targetPct}%...`);
  const deadline = Date.now() + maxWaitMin * 60 * 1000;
  while (Date.now() < deadline) {
    const pct = ramPct();
    if (pct <= targetPct) { log(`  RAM at ${pct}% — OK to proceed.`); return; }
    log(`  RAM still at ${pct}% — waiting...`);
    await sleep(15000);
  }
  log(`  RAM did not drop in ${maxWaitMin}min — proceeding anyway.`);
}

// ─── Phase 2: Launch scrapers ─────────────────────────────────────────────────

async function launchChrome() {
  log("Launching Chrome CDP instances for scrapers...");
  for (const p of CHROME_PROFILES) {
    const args = [
      `--remote-debugging-port=${p.port}`,
      `--user-data-dir="${p.dir}"`,
      "--disable-blink-features=AutomationControlled",
      "--no-first-run", "--no-default-browser-check",
      "--start-maximized", "--disable-extensions",
    ].join(" ");
    psRun(`Start-Process '${CHROME}' -ArgumentList '${args}'`);
    log(`  Chrome launched on port ${p.port}`);
    await sleep(3000);
  }
  log("Waiting 15s for Chrome to initialize...");
  await sleep(15000);

  // Verify
  let allUp = true;
  for (const p of CHROME_PROFILES) {
    const status = psRun(`try { (Invoke-WebRequest -Uri 'http://127.0.0.1:${p.port}/json' -TimeoutSec 5 -UseBasicParsing).StatusCode } catch { 'DOWN' }`);
    log(`  Port ${p.port}: ${status === "200" ? "✅ UP" : "❌ " + status}`);
    if (status !== "200") allUp = false;
  }
  return allUp;
}

async function launchScrapers() {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const procs = [];

  for (const s of SCRAPERS) {
    const logFile = path.join(SEEK_DIR, "logs", `${s.logSuffix}_tonight.log`);
    log(`  Launching ${s.script} → ${logFile}`);

    const proc = spawn("powershell.exe", [
      "-ExecutionPolicy", "Bypass",
      "-Command",
      `Set-Location '${SEEK_DIR}'; $env:PYTHONUTF8='1'; $env:PYTHONUNBUFFERED='1'; $env:PYTHONPATH='.'; python -u '${s.script}' --pages 4 2>&1 | Tee-Object -FilePath '${s.logSuffix}_tonight.log'`
    ], { cwd: SEEK_DIR, detached: false });

    proc.stdout?.on("data", d => fs.appendFileSync(logFile, d));
    proc.stderr?.on("data", d => fs.appendFileSync(logFile, d));
    procs.push({ proc, ...s, logFile });
    await sleep(2000);
  }

  return procs;
}

async function checkScrapersHealthy(procs, waitMs = 300000) {
  log(`Checking scraper health in 5 minutes...`);
  await sleep(waitMs);

  let healthy = 0;
  for (const { proc, script, logFile } of procs) {
    const exited = proc.exitCode !== null;
    const logExists = fs.existsSync(logFile);
    const logContent = logExists ? fs.readFileSync(logFile, "utf8") : "";
    const hasProgress = logContent.length > 100;
    const hasError = logContent.includes("ERROR") && !logContent.includes("Connecting");

    if (!exited && hasProgress && !hasError) {
      log(`  ✅ ${script} — running, ${logContent.length} bytes logged`);
      healthy++;
    } else if (exited) {
      log(`  ⚠️  ${script} — exited early (code ${proc.exitCode})`);
    } else {
      log(`  ⚠️  ${script} — running but progress unclear`);
      healthy++; // give benefit of doubt
    }
  }
  return healthy;
}

async function waitForScrapersComplete(procs, timeoutMin = 120) {
  log("Waiting for scrapers to complete...");
  const deadline = Date.now() + timeoutMin * 60 * 1000;

  while (Date.now() < deadline) {
    await sleep(60000); // check every minute

    let doneCount = 0;
    for (const { script, logFile, finishMarker } of procs) {
      if (!fs.existsSync(logFile)) continue;
      const content = fs.readFileSync(logFile, "utf8");
      if (content.includes(finishMarker)) {
        doneCount++;
      }
    }

    log(`  Scrapers done: ${doneCount}/${procs.length} | RAM: ${ramPct()}%`);
    if (doneCount >= procs.length) {
      log("  All scrapers finished.");
      return true;
    }
  }

  log(`  Timeout after ${timeoutMin}min — some scrapers may still be running.`);
  return false;
}

function killChrome() {
  log("Killing Chrome CDP instances...");
  psRun(`
    Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match '9223|9225|9226' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Host "Killed PID $($_.ProcessId)" }
  `);
}

// ─── Phase 3: Launch bots ─────────────────────────────────────────────────────

async function launchBots() {
  log("Phase 3: Launching seek bots (--once mode)...");

  // Re-launch Chrome for bots (same ports)
  const chromeUp = await launchChrome();
  if (!chromeUp) {
    log("  ⚠️  Chrome failed to start for bots — skipping bot launch.");
    return;
  }

  for (const b of BOTS) {
    log(`  Launching ${b.script}...`);
    const logFile = path.join(SEEK_DIR, "logs", `${path.basename(b.script, ".py")}_tonight.log`);

    const proc = spawn("powershell.exe", [
      "-ExecutionPolicy", "Bypass",
      "-Command",
      `Set-Location '${SEEK_DIR}'; $env:PYTHONUTF8='1'; $env:PYTHONUNBUFFERED='1'; $env:PYTHONPATH='.'; python -u '${b.script}' --once 2>&1 | Tee-Object -FilePath '${path.basename(b.script, ".py")}_tonight.log'`
    ], { cwd: SEEK_DIR, detached: false });

    // Wait for bot to finish before starting next (port safety)
    await new Promise(resolve => {
      proc.on("exit", code => {
        log(`  Bot ${b.script} finished (exit ${code})`);
        resolve();
      });
      setTimeout(resolve, 30 * 60 * 1000); // 30min max per bot
    });

    await sleep(5000);
    killChrome(); // kill after each bot to free RAM
    await sleep(3000);
    await launchChrome(); // re-launch for next bot
  }

  killChrome();
  log("All bots finished.");
}

// ─── Main orchestration ───────────────────────────────────────────────────────

async function main() {
  log("=".repeat(60));
  log("Overnight orchestrator started");
  log(`RAM: ${ramPct()}% | ${(os.totalmem() / 1024 / 1024 / 1024).toFixed(1)} GB total`);
  log("=".repeat(60));

  // Phase 1: Wait for ADHD analysis
  await waitForAdhdResult();
  await waitForRamToClear(65);

  // Phase 2: Scrapers
  log("Phase 2: Launching seek scrapers...");
  const chromeUp = await launchChrome();
  if (!chromeUp) {
    log("Chrome failed to start — retrying in 30s...");
    await sleep(30000);
    await launchChrome();
  }

  const scraperProcs = await launchScrapers();
  const healthy = await checkScrapersHealthy(scraperProcs, 300000); // 5 min
  log(`Scrapers healthy: ${healthy}/${scraperProcs.length}`);

  const scrapersDone = await waitForScrapersComplete(scraperProcs, 120);
  killChrome();

  if (!scrapersDone) {
    log("⚠️  Not all scrapers finished within 2hr — proceeding to bot schedule anyway.");
  }

  // Phase 3: 2-hour wait then bots
  log("Phase 2 complete. Waiting 2 hours before launching bots...");
  await sleep(2 * 60 * 60 * 1000);

  await launchBots();

  log("=".repeat(60));
  log("Overnight orchestrator COMPLETE.");
  log("=".repeat(60));
}

main().catch(err => {
  log(`FATAL: ${err.message}`);
  log(err.stack);
  process.exit(1);
});
