#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { scanAllSessions, PRICING, getPriceTier } from './engine.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_HTML = path.join(__dirname, '..', 'public', 'index.html');
const PKG_JSON = path.join(__dirname, '..', 'package.json');

const args = process.argv.slice(2);
const getArg = (flag, def) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};

const SHOW_HELP = args.includes('--help') || args.includes('-h');
const SHOW_VERSION = args.includes('--version') || args.includes('-v');
const DAYS = parseFloat(getArg('--days', '2'));
const APP_FILTER = getArg('--app', '');
const PORT = parseInt(getArg('--port', '4455'), 10);
const TABLE_ONLY = args.includes('--table');
const NO_OPEN = args.includes('--no-open');

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};

function pad(str, len, right = false) {
  const raw = String(str).replace(/\x1b\[[0-9;]*m/g, '');
  const diff = Math.max(0, len - raw.length);
  return right ? ' '.repeat(diff) + str : str + ' '.repeat(diff);
}

function fmtK(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n || 0);
}

function printHelp() {
  console.log(`
${C.bold}vibe-usage${C.reset} (ccdash)

Usage:
  vibe-usage [options]
  ccdash [options]

Options:
  --days <n>     Lookback window in days (default: 2, 0 for all)
  --app <name>   Filter sessions by project name
  --port <port>  HTTP server port (default: 4455)
  --table        Print terminal table and exit
  --no-open      Do not open browser automatically
  -v, --version  Print version
  -h, --help     Show help
`);
}

if (SHOW_VERSION) {
  const pkg = JSON.parse(fs.readFileSync(PKG_JSON, 'utf8'));
  console.log(pkg.version || '1.0.0');
  process.exit(0);
}

if (SHOW_HELP) {
  printHelp();
  process.exit(0);
}

function renderAnsiBar(pct, width = 20, urgent = false) {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  const color = urgent ? C.red : C.cyan;
  return `${color}${'█'.repeat(filled)}${C.dim}${'░'.repeat(width - filled)}${C.reset}`;
}

function printTerminalReport(data) {
  const { sessions, activeBlock } = data;
  const totalCost = sessions.reduce((s, x) => s + x.totalCost, 0);
  const warmCount = sessions.filter(s => s.isWarm).length;

  console.log(`\n${C.bold}${C.cyan}vibe-usage${C.reset}  last ${DAYS === 0 ? 'all' : DAYS + 'd'} | ${sessions.length} sessions | ${C.green}$${totalCost.toFixed(2)}${C.reset} | ${warmCount} warm`);
  if (activeBlock?.active) {
    const pct = Math.min(100, Math.round((activeBlock.elapsedMin / 300) * 100));
    const urgent = activeBlock.remainingMin < 60;
    const bar = renderAnsiBar(pct, 18, urgent);
    console.log(
      `${urgent ? C.red : C.yellow}5h block:${C.reset} [${bar}] ${pct}% | ` +
      `${Math.floor(activeBlock.remainingMin / 60)}h ${activeBlock.remainingMin % 60}m left | ` +
      `${C.bold}${fmtK(activeBlock.tokensPerMin)}/m${C.reset} ($${activeBlock.costPerHour.toFixed(2)}/h) | ` +
      `spend ${C.bold}$${activeBlock.totalCost.toFixed(2)}${C.reset}`
    );
  }
  console.log(`${C.dim}─`.repeat(122) + C.reset);
  console.log(
    pad(`${C.bold}App${C.reset}`, 16) +
    pad(`${C.bold}Session${C.reset}`, 32) +
    pad(`${C.bold}Context${C.reset}`, 10, true) +
    pad(`${C.bold}Integ.${C.reset}`, 8, true) +
    pad(`${C.bold}1h TTL${C.reset}`, 10, true) +
    pad(`${C.bold}Split${C.reset}`, 14, true) +
    pad(`${C.bold}Cost${C.reset}`, 9, true) +
    '  ' + `${C.bold}Status${C.reset}`
  );
  console.log(`${C.dim}─`.repeat(122) + C.reset);

  for (const s of sessions.slice(0, 18)) {
    const ctxColor = s.currentContext >= 200000 ? C.red : s.currentContext >= 140000 ? C.yellow : C.green;
    const intColor = s.cacheIntegrityPct >= 90 ? C.green : s.cacheIntegrityPct >= 75 ? C.yellow : C.red;
    const ttlStr = s.isWarm ? `${C.green}${Math.ceil(s.ttlRemainingSec / 60)}m left${C.reset}` : `${C.dim}cold${C.reset}`;
    const splitVerdict = s.simulators.sameVsNewSession.verdict === 'START_NEW_SESSION'
      ? `${C.yellow}new session${C.reset}`
      : `${C.green}stay${C.reset}`;
    const d = s.decisions[0];
    const dColor = d.type === 'critical' ? C.red : d.type === 'warning' ? C.yellow : d.type === 'info' ? C.cyan : C.green;

    console.log(
      pad(s.appName.slice(0, 14), 16) +
      pad(`${s.title.replace(/\s+/g, ' ').slice(0, 21)} ${C.dim}(${s.shortId})${C.reset}`, 32) +
      pad(`${ctxColor}${fmtK(s.currentContext)}${C.reset}`, 10, true) +
      pad(`${intColor}${s.cacheIntegrityPct}%${C.reset}`, 8, true) +
      pad(ttlStr, 10, true) +
      pad(splitVerdict, 14, true) +
      pad(`${C.bold}$${s.totalCost.toFixed(2)}${C.reset}`, 9, true) +
      '  ' + `${dColor}${d.badge}${C.reset}`
    );
  }
  console.log(`${C.dim}─`.repeat(122) + C.reset);
}

function computeInteractiveSimulation({
  currentContext = 140000,
  startCacheRead = 42000,
  isWarm = true,
  ageMin = 5,
  ttlRemainingSec = 3300,
  model = 'opus-5',
  steps = 45,
  taskType = 'unrelated',
  awayMin = 90,
}) {
  const p = getPriceTier(model);
  const clampedSteps = Math.max(5, Math.min(100, Math.round(steps)));
  const clampedAway = Math.max(5, Math.min(2880, Math.round(awayMin)));
  const baseStaticPrefix = Math.min(currentContext, Math.max(32000, startCacheRead || 42000));

  const isSameFeature = taskType === 'same';
  const newPayloadTokens = isSameFeature ? 12500 : 2500;
  const newSessionStartCtx = Math.min(currentContext, baseStaticPrefix + newPayloadTokens);
  const sameReadTokens = currentContext * clampedSteps;
  const newReadTokens = newSessionStartCtx * clampedSteps;
  const savedReadTokens = Math.max(0, sameReadTokens - newReadTokens);

  const sameTurn1WriteUSD = isWarm ? 0 : (currentContext * p.w1h) / 1e6;
  const newTurn1WriteUSD = (((isWarm ? 0 : baseStaticPrefix) + newPayloadTokens) * p.w1h) / 1e6;
  const sameTotalUSD = sameTurn1WriteUSD + ((isWarm ? clampedSteps : clampedSteps - 1) * currentContext * p.read) / 1e6;
  const newTotalUSD = newTurn1WriteUSD + (newReadTokens * p.read) / 1e6;
  const savedReadDollars = (savedReadTokens * p.read) / 1e6;
  const netSavingsUSD = sameTotalUSD - newTotalUSD;

  const compactSummaryOutTokens = 3500;
  const compactNewCachedCtx = baseStaticPrefix + 18000;
  const clearExtraRehydrate = isSameFeature ? 10000 : 0;
  const clearWorkingCtx = Math.min(currentContext, baseStaticPrefix + 2500 + clearExtraRehydrate);

  const keepTurn1USD = ((isWarm ? currentContext * p.read : currentContext * p.w1h) + 600 * p.out) / 1e6;
  const keepNStepsUSD = keepTurn1USD + Math.max(0, clampedSteps - 1) * ((currentContext * p.read + 600 * p.out) / 1e6);

  const clearTurn1USD =
    ((isWarm ? baseStaticPrefix * p.read : baseStaticPrefix * p.w1h) +
      (2500 + clearExtraRehydrate) * p.w1h +
      600 * p.out) / 1e6;
  const clearNStepsUSD = clearTurn1USD + Math.max(0, clampedSteps - 1) * ((clearWorkingCtx * p.read + 600 * p.out) / 1e6);

  const compactImmediateUSD =
    ((isWarm ? currentContext * p.read : currentContext * p.w1h) +
      compactSummaryOutTokens * p.out +
      compactNewCachedCtx * p.w1h) / 1e6;
  const compactNStepsUSD = compactImmediateUSD + clampedSteps * ((compactNewCachedCtx * p.read + 600 * p.out) / 1e6);

  const singlePingUSD = (currentContext * p.read + 5 * p.out) / 1e6;
  const coldRewriteUSD = (currentContext * p.w1h) / 1e6;
  const pingsNeeded = clampedAway < 60 ? 0 : Math.max(1, Math.floor(clampedAway / 50));
  const totalPingUSD = pingsNeeded * singlePingUSD;
  const pingNetSavingsUSD = coldRewriteUSD - totalPingUSD;
  const breakEvenPings = singlePingUSD > 0 ? Math.floor(coldRewriteUSD / singlePingUSD) : 0;

  return {
    inputs: { currentContext, startCacheRead, isWarm, ageMin, ttlRemainingSec, model, steps: clampedSteps, taskType, awayMin: clampedAway },
    priceTier: p,
    sameVsNew: {
      baseStaticPrefix,
      newPayloadTokens,
      newSessionStartCtx,
      sameReadTokens,
      newReadTokens,
      savedReadTokens,
      savedReadDollars,
      sameTotalUSD,
      newTotalUSD,
      netSavingsUSD,
      winner: netSavingsUSD > 0.02 && (!isSameFeature || currentContext >= 115000 || !isWarm) ? 'NEW_SESSION' : 'SAME_SESSION',
    },
    actionsComparison: {
      keepTurn1USD,
      keepNStepsUSD,
      clearTurn1USD,
      clearNStepsUSD,
      compactImmediateUSD,
      compactNStepsUSD,
    },
    keepAlive: {
      singlePingUSD,
      coldRewriteUSD,
      pingsNeeded,
      totalPingUSD,
      pingNetSavingsUSD,
      breakEvenPings,
      breakEvenMinutes: breakEvenPings * 50,
    },
  };
}

let cachedScan = {
  key: `${DAYS}::${APP_FILTER}`,
  at: Date.now(),
  data: scanAllSessions({ days: DAYS, appFilter: APP_FILTER }),
};

printTerminalReport(cachedScan.data);

if (TABLE_ONLY) process.exit(0);

function getPayload({ days, app, force = false }) {
  const key = `${days}::${app}`;
  const now = Date.now();
  if (!force && cachedScan.key === key && now - cachedScan.at < 3000) {
    return { ...cachedScan.data, pricing: PRICING, serverNow: now };
  }
  const fresh = scanAllSessions({ days, appFilter: app });
  cachedScan = { key, at: now, data: fresh };
  return { ...fresh, pricing: PRICING, serverNow: now };
}

function sendJson(req, res, status, obj) {
  const raw = Buffer.from(JSON.stringify(obj));
  const acceptEnc = req.headers['accept-encoding'] || '';
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  };
  if (raw.length > 1024 && acceptEnc.includes('gzip')) {
    const gz = zlib.gzipSync(raw);
    headers['Content-Encoding'] = 'gzip';
    headers['Content-Length'] = gz.length;
    res.writeHead(status, headers);
    res.end(gz);
  } else {
    headers['Content-Length'] = raw.length;
    res.writeHead(status, headers);
    res.end(raw);
  }
}

const server = http.createServer((req, res) => {
  const urlObj = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (urlObj.pathname === '/api/data') {
    const daysParam = parseFloat(urlObj.searchParams.get('days') ?? String(DAYS));
    const appParam = urlObj.searchParams.get('app') ?? APP_FILTER;
    const force = urlObj.searchParams.get('refresh') === '1';
    const payload = getPayload({
      days: Number.isNaN(daysParam) ? DAYS : daysParam,
      app: appParam,
      force,
    });
    return sendJson(req, res, 200, payload);
  }

  if (urlObj.pathname === '/api/session') {
    const id = urlObj.searchParams.get('id') || '';
    const payload = getPayload({ days: DAYS, app: APP_FILTER });
    const match = payload.sessions.find(s => s.sessionId === id || s.shortId === id);
    if (!match) return sendJson(req, res, 404, { error: 'Session not found' });
    return sendJson(req, res, 200, match);
  }

  if (urlObj.pathname === '/api/simulate') {
    const sessionId = urlObj.searchParams.get('sessionId') || '';
    const steps = parseFloat(urlObj.searchParams.get('steps') || '45');
    const taskType = urlObj.searchParams.get('taskType') === 'same' ? 'same' : 'unrelated';
    const awayMin = parseFloat(urlObj.searchParams.get('awayMin') || '90');

    let base = {
      currentContext: parseFloat(urlObj.searchParams.get('currentContext') || '140000'),
      startCacheRead: parseFloat(urlObj.searchParams.get('startCacheRead') || '42000'),
      isWarm: urlObj.searchParams.get('isWarm') !== 'false',
      ageMin: parseFloat(urlObj.searchParams.get('ageMin') || '5'),
      ttlRemainingSec: parseFloat(urlObj.searchParams.get('ttlRemainingSec') || '3300'),
      model: urlObj.searchParams.get('model') || 'opus-5',
    };

    if (sessionId) {
      const payload = getPayload({ days: DAYS, app: APP_FILTER });
      const s = payload.sessions.find(x => x.sessionId === sessionId || x.shortId === sessionId);
      if (s) {
        base = {
          currentContext: s.currentContext,
          startCacheRead: s.startCacheRead,
          isWarm: s.isWarm,
          ageMin: s.ageMin,
          ttlRemainingSec: s.ttlRemainingSec,
          model: s.turns[s.turns.length - 1]?.model || s.models[0] || 'opus-5',
        };
      }
    }

    return sendJson(req, res, 200, computeInteractiveSimulation({ ...base, steps, taskType, awayMin }));
  }

  if (urlObj.pathname === '/api/health') {
    return sendJson(req, res, 200, {
      ok: true,
      port: PORT,
      scannedAt: cachedScan.data.scannedAt,
      sessionsCount: cachedScan.data.sessions.length,
    });
  }

  if (urlObj.pathname.startsWith('/api/')) {
    return sendJson(req, res, 404, { error: 'Not found' });
  }

  try {
    const html = fs.readFileSync(PUBLIC_HTML, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(html);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`Missing public/index.html: ${err.message}`);
  }
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`error: port ${PORT} is already in use (try --port ${PORT + 1})`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`\nDashboard: ${C.bold}${C.cyan}${url}${C.reset}\n`);
  if (!NO_OPEN) {
    const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    exec(`${openCmd} "${url}"`);
  }
});
