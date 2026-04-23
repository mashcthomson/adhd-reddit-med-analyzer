// RAM monitor — polls every 5s, warns at 80%, soft-kills server.ts at 90%
// Usage: node ram-monitor.mjs <pid-to-watch>
// If no PID given, monitors the whole system

import os from "os";
import { execSync } from "child_process";

const WARN_PCT  = 72;
const KILL_PCT  = 85;
const INTERVAL  = 5000;
const watchPid  = process.argv[2] ? parseInt(process.argv[2]) : null;

function totalRamGB()  { return os.totalmem() / 1024 / 1024 / 1024; }
function freeRamGB()   { return os.freemem()  / 1024 / 1024 / 1024; }
function usedPct()     { return Math.round((1 - os.freemem() / os.totalmem()) * 100); }

function bar(pct) {
  const filled = Math.round(pct / 5);
  return "[" + "█".repeat(filled) + "░".repeat(20 - filled) + "]";
}

let warned = false;
let lastPct = 0;

function check() {
  const pct = usedPct();
  const total = totalRamGB().toFixed(1);
  const used  = (totalRamGB() - freeRamGB()).toFixed(1);
  const ts    = new Date().toLocaleTimeString();

  // Only print if pct changed by 2+ or crossed a threshold
  if (Math.abs(pct - lastPct) >= 2 || pct >= WARN_PCT) {
    const icon = pct >= KILL_PCT ? "🔴" : pct >= WARN_PCT ? "🟡" : "🟢";
    process.stdout.write(`\r${icon} RAM ${bar(pct)} ${pct}%  (${used}/${total} GB)  ${ts}  `);
    lastPct = pct;
  }

  if (pct >= KILL_PCT) {
    console.log(`\n\n⛔  RAM at ${pct}% — above ${KILL_PCT}% kill threshold.`);
    if (watchPid) {
      try {
        console.log(`   Sending SIGTERM to PID ${watchPid}...`);
        process.kill(watchPid, "SIGTERM");
        console.log("   Process terminated. Your system is safe.");
      } catch (e) {
        console.log("   Could not kill PID — process may have already exited.");
      }
    } else {
      console.log("   No PID to kill — close the heaviest process manually.");
      console.log("   Pausing monitor for 30s to give you time...");
    }
    warned = true;
    setTimeout(() => { warned = false; }, 30000);
  } else if (pct >= WARN_PCT && !warned) {
    console.log(`\n⚠️   RAM at ${pct}% — approaching limit. Watching closely...`);
    warned = true;
    setTimeout(() => { warned = false; }, 15000);
  }
}

console.log(`RAM Monitor started — total RAM: ${totalRamGB().toFixed(1)} GB`);
console.log(`Thresholds: warn at ${WARN_PCT}%, kill server at ${KILL_PCT}%`);
if (watchPid) console.log(`Watching PID: ${watchPid}`);
console.log("Press Ctrl+C to stop monitor.\n");

setInterval(check, INTERVAL);
check();
