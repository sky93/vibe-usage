import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// USD per 1M tokens
export const PRICING = {
  'opus-5':   { in: 4.0, out: 20.0, w1h: 8.0,  w5m: 5.0,  read: 0.20, minCache: 4096 },
  'opus-4':   { in: 5.0, out: 25.0, w1h: 10.0, w5m: 6.25, read: 0.50, minCache: 4096 },
  'sonnet':   { in: 3.0, out: 15.0, w1h: 6.0,  w5m: 3.75, read: 0.30, minCache: 2048 },
  'haiku':    { in: 1.0, out: 5.0,  w1h: 2.0,  w5m: 1.25, read: 0.10, minCache: 4096 },
  'fable':    { in: 3.0, out: 15.0, w1h: 6.0,  w5m: 3.75, read: 0.30, minCache: 2048 },
};

export function getPriceTier(model = '') {
  const m = model.toLowerCase();
  if (m.includes('opus-5')) return PRICING['opus-5'];
  if (m.includes('opus')) return PRICING['opus-4'];
  if (m.includes('haiku')) return PRICING['haiku'];
  if (m.includes('fable')) return PRICING['fable'];
  return PRICING['sonnet'];
}

export function cleanAppName(dirName) {
  return dirName
    .replace(/^-Users-[^-]+-Codes-/, '')
    .replace(/^-Users-[^-]+-/, '')
    .replace(/^-/, '') || 'root';
}

function extractText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(b => b && b.type === 'text' && b.text)
      .map(b => b.text)
      .join('\n');
  }
  return '';
}

function cleanPromptTitle(raw) {
  if (!raw) return '';
  return raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
    .replace(/<ide_[^>]+>[\s\S]*?<\/ide_[^>]+>/gi, '')
    .replace(/<command-[^>]+>[\s\S]*?<\/command-[^>]+>/gi, '')
    .replace(/<session>([\s\S]*?)<\/session>/gi, '$1')
    .replace(/<[^>]+>/g, '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)[0]?.slice(0, 72) || '';
}

export function evaluateSessionDecisions({
  currentContext,
  startCacheRead,
  totalCreated,
  totalRead,
  totalOut,
  cacheIntegrityPct,
  cacheBreaks,
  wastedWriteTokens,
  readToOutRatio,
  ttlRemainingSec,
  isWarm,
  ageMin,
  models,
  turnsCount,
  lastModel,
}) {
  const p = getPriceTier(lastModel);
  const estStepsNextTask = 45;
  const baseStaticPrefix = Math.min(currentContext, Math.max(32000, startCacheRead || 42000));
  const handoffSummaryTokens = 12500;
  const newSessionStartCtx = baseStaticPrefix + handoffSummaryTokens;
  const savedContextPerStep = Math.max(0, currentContext - newSessionStartCtx);

  const sameSessionReadTokens = currentContext * estStepsNextTask;
  const newSessionReadTokens = newSessionStartCtx * estStepsNextTask;
  const savedReadTokens50Steps = Math.max(0, sameSessionReadTokens - newSessionReadTokens);
  const savedDollars50Steps = (savedReadTokens50Steps * p.read) / 1e6;

  let sessionSplitVerdict = 'STAY_IN_SESSION';
  let sessionSplitSummary = `Context (${(currentContext / 1000).toFixed(1)}k) is still lean. Stay in this session to reuse warm context without handoff overhead.`;

  if (currentContext >= 140000) {
    sessionSplitVerdict = 'START_NEW_SESSION';
    sessionSplitSummary = `Starting a new session drops active context from ${(currentContext / 1000).toFixed(1)}k to ~${(newSessionStartCtx / 1000).toFixed(1)}k (-${Math.round((savedContextPerStep / currentContext) * 100)}%), saving ~${(savedReadTokens50Steps / 1e6).toFixed(2)}M cache_read tokens ($${savedDollars50Steps.toFixed(2)}) over the next ${estStepsNextTask} tool calls while keeping your ${Math.round(baseStaticPrefix / 1000)}k system prefix warm.`;
  } else if (currentContext >= 105000) {
    sessionSplitVerdict = 'NEW_SESSION_IF_UNRELATED';
    sessionSplitSummary = `If your next prompt is the same feature (2-6 turns), stay here. If switching to a new feature, start a new session to shed ${(savedContextPerStep / 1000).toFixed(1)}k of unrelated context.`;
  }

  const compactSummaryOutTokens = 3500;
  const compactNewCachedCtx = baseStaticPrefix + 18000;
  const compactImmediateCost =
    (currentContext * p.read + compactSummaryOutTokens * p.out + compactNewCachedCtx * p.w1h) / 1e6;
  const keepTypingNextTurnCost = (currentContext * p.read + 600 * p.out) / 1e6;
  const clearNextTurnCost = (baseStaticPrefix * p.read + 2500 * p.w1h + 600 * p.out) / 1e6;

  let contextActionVerdict = 'KEEP_TYPING';
  let contextActionSummary = `Keep typing inline. Warm 1h cache reads cost $${((currentContext * p.read) / 1e6).toFixed(3)}/turn. Running /compact here costs ~$${compactImmediateCost.toFixed(2)} and invalidates your KV-cache.`;

  if (currentContext >= 200000) {
    contextActionVerdict = 'COMMIT_AND_CLEAR';
    contextActionSummary = `Commit changes and run /clear. At ${(currentContext / 1000).toFixed(1)}k tokens, every tool call carries $${((currentContext * p.read) / 1e6).toFixed(3)}/step. Avoid /compact ($${compactImmediateCost.toFixed(2)} upfront).`;
  } else if (!isWarm && currentContext >= 100000) {
    contextActionVerdict = 'CLEAR_OR_COMPACT_BEFORE_RESUME';
    contextActionSummary = `1h cache is cold (${ageMin}m idle). Sending a message now triggers a 2.0x cache write on ${(currentContext / 1000).toFixed(1)}k tokens ($${((currentContext * p.w1h) / 1e6).toFixed(2)} on turn 1). Start a fresh session instead.`;
  }

  const pingCostUSD = (currentContext * p.read + 5 * p.out) / 1e6;
  const coldRewriteCostUSD = (currentContext * p.w1h) / 1e6;
  const pingSavingsUSD = Math.max(0, coldRewriteCostUSD - pingCostUSD);
  const shouldPingForBreak = isWarm && currentContext >= 75000;

  const decisions = [];
  let statusLevel = 'healthy';

  if (currentContext >= 200000) {
    statusLevel = 'critical';
    decisions.push({
      badge: 'COMMIT & /CLEAR (>200k)',
      type: 'critical',
      reason: `Context reached ${(currentContext / 1000).toFixed(1)}k tokens ($${((currentContext * p.read) / 1e6).toFixed(3)}/step). Commit changes and open a new session.`,
    });
  } else if (currentContext >= 140000) {
    statusLevel = 'warning';
    decisions.push({
      badge: 'SPLIT SESSION (>140k)',
      type: 'warning',
      reason: `Finish current work while cache is warm, then open a new session for the next task (saves ~$${savedDollars50Steps.toFixed(2)} over 45 steps).`,
    });
  }

  if (isWarm && ttlRemainingSec <= 900 && currentContext >= 75000) {
    if (statusLevel === 'healthy') statusLevel = 'warning';
    const minsLeft = Math.ceil(ttlRemainingSec / 60);
    decisions.push({
      badge: `PING IN ${minsLeft}M OR LOSE CACHE`,
      type: 'warning',
      reason: `1h cache expires in ${minsLeft}m. A keep-alive ping costs $${pingCostUSD.toFixed(3)} (0.1x) vs $${coldRewriteCostUSD.toFixed(2)} (2.0x) to rewrite cold.`,
    });
  } else if (!isWarm && currentContext >= 115000) {
    decisions.push({
      badge: 'COLD SESSION (DO NOT RESUME)',
      type: 'info',
      reason: `Cache expired ${ageMin}m ago. Resuming this ${(currentContext / 1000).toFixed(1)}k thread costs $${coldRewriteCostUSD.toFixed(2)} on turn 1. Start a fresh session instead.`,
    });
  }

  if (cacheBreaks.length > 0 || cacheIntegrityPct < 75) {
    if (statusLevel === 'healthy') statusLevel = 'warning';
    decisions.push({
      badge: `CACHE BROKE ${cacheBreaks.length || 1}x (${cacheIntegrityPct}%)`,
      type: 'warning',
      reason: `Wasted ~${(wastedWriteTokens / 1000).toFixed(1)}k cache-write tokens ($${((wastedWriteTokens * p.w1h) / 1e6).toFixed(2)}) from idle >60m, /compact, or model/MCP changes.`,
    });
  }

  if (models.length > 1) {
    if (statusLevel === 'healthy') statusLevel = 'warning';
    decisions.push({
      badge: `MODEL MIX (${models.join(' + ')})`,
      type: 'warning',
      reason: `Multiple models used in one session. Each model keeps a separate KV-cache, forcing a cold cache rewrite on switch.`,
    });
  }

  if (readToOutRatio > 330 && turnsCount > 15) {
    decisions.push({
      badge: `HIGH TOOL CHURN (${readToOutRatio}:1)`,
      type: 'info',
      reason: `High read-to-output ratio (${readToOutRatio}:1). Pass exact file paths and disable unused MCP servers.`,
    });
  }

  if (decisions.length === 0) {
    decisions.push({
      badge: isWarm ? 'WARM 1H CACHE' : 'CLEAN RUN',
      type: 'healthy',
      reason: isWarm
        ? `${cacheIntegrityPct}% cache integrity with ${Math.ceil(ttlRemainingSec / 60)}m left on 1h TTL. Keep working inline.`
        : `Completed with ${cacheIntegrityPct}% cache integrity and ${(currentContext / 1000).toFixed(1)}k final context.`,
    });
  }

  return {
    statusLevel,
    decisions,
    simulators: {
      sameVsNewSession: {
        verdict: sessionSplitVerdict,
        summary: sessionSplitSummary,
        currentContext,
        newSessionStartCtx,
        savedContextPerStep,
        savedReadTokens50Steps,
        savedDollars50Steps,
      },
      clearVsCompact: {
        verdict: contextActionVerdict,
        summary: contextActionSummary,
        keepTypingNextTurnCost,
        clearNextTurnCost,
        compactImmediateCost,
      },
      keepAlivePing: {
        shouldPingForBreak,
        pingCostUSD,
        coldRewriteCostUSD,
        pingSavingsUSD,
        loopCommand: `/loop 50m Reply with only the word OK. Do not call any tools or read any files.`,
        wakeupPrompt: `Call ScheduleWakeup with delaySeconds: 3000 and noop: true to keep this session warm while I step away.`,
      },
    },
  };
}

export function parseSessionFile(filePath, appName) {
  const sessionId = path.basename(filePath, '.jsonl');
  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const lines = content.split('\n');

  let title = '';
  let customTitle = '';
  const turns = [];
  const modelsSet = new Set();

  let totalIn = 0, totalOut = 0, totalCreated = 0, totalRead = 0;
  let totalW1h = 0, totalW5m = 0, totalCost = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }

    if (obj.type === 'custom-title' && obj.customTitle) customTitle = obj.customTitle;
    if (obj.type === 'summary' && obj.summary && !customTitle) customTitle = obj.summary;

    if (!title && obj.type === 'user' && !obj.isMeta && obj.message?.content) {
      const cleaned = cleanPromptTitle(extractText(obj.message.content));
      if (cleaned && cleaned.toLowerCase() !== 'quota') title = cleaned;
    }

    if (obj.type === 'assistant' && obj.message?.usage) {
      const u = obj.message.usage;
      const model = (obj.message.model || 'claude-opus-5-5').replace(/^claude-/, '');
      modelsSet.add(model);

      const inp = u.input_tokens || 0;
      const out = u.output_tokens || 0;
      const cr = u.cache_creation_input_tokens || 0;
      const rd = u.cache_read_input_tokens || 0;
      const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? cr;
      const w5m = u.cache_creation?.ephemeral_5m_input_tokens ?? 0;

      const p = getPriceTier(model);
      const turnCost = (inp * p.in + out * p.out + w1h * p.w1h + w5m * p.w5m + rd * p.read) / 1e6;

      totalIn += inp;
      totalOut += out;
      totalCreated += cr;
      totalRead += rd;
      totalW1h += w1h;
      totalW5m += w5m;
      totalCost += turnCost;

      const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : 0;
      const prevTurn = turns.length > 0 ? turns[turns.length - 1] : null;
      const gapSec = prevTurn && ts && prevTurn.ts ? Math.round((ts - prevTurn.ts) / 1000) : 0;

      // Classify any mid-session cache break (>25k cache write after Turn 1)
      let breakCause = null;
      if (turns.length > 0 && cr > 25000) {
        if (prevTurn && prevTurn.model !== model) {
          breakCause = `Model switch (${prevTurn.model} → ${model})`;
        } else if (gapSec >= 3550) {
          breakCause = `1h Cache TTL expired (${Math.round(gapSec / 60)}m idle gap)`;
        } else if (gapSec >= 300 && w5m > 20000) {
          breakCause = `5m Cache TTL expired (${Math.round(gapSec / 60)}m idle gap)`;
        } else if (prevTurn && rd < prevTurn.rd * 0.7) {
          breakCause = `/compact or prefix invalidation (MCP/effort toggle)`;
        } else {
          breakCause = `Large payload/tool dump added (+${(cr / 1000).toFixed(1)}k tokens)`;
        }
      }

      turns.push({
        idx: turns.length + 1,
        ts,
        iso: obj.timestamp || '',
        timeStr: obj.timestamp ? obj.timestamp.slice(11, 19) : '',
        model,
        inp,
        out,
        cr,
        rd,
        w1h,
        w5m,
        cost: turnCost,
        gapSec,
        breakCause,
      });
    }
  }

  if (turns.length === 0) return null;

  const firstTurn = turns[0];
  const lastTurn = turns[turns.length - 1];
  const startCacheRead = firstTurn.rd;
  const currentContext = lastTurn.rd + lastTurn.cr + lastTurn.inp;
  const expectedContext = startCacheRead + totalCreated;
  const cacheIntegrityPct = expectedContext > 0
    ? Math.min(100, Math.round((lastTurn.rd / expectedContext) * 100))
    : 100;

  const cacheBreaks = turns.slice(1).filter(t => t.cr > 25000);
  const wastedWriteTokens = Math.max(0, expectedContext - lastTurn.rd);
  const readToOutRatio = totalOut > 0 ? Math.round(totalRead / totalOut) : 0;

  const now = Date.now();
  const ageMs = now - lastTurn.ts;
  const ageMin = Math.max(0, Math.round(ageMs / 60000));
  const ttlRemainingSec = Math.max(0, Math.round((3600000 - ageMs) / 1000));
  const isWarm = ttlRemainingSec > 0;
  const models = Array.from(modelsSet);

  const evaluation = evaluateSessionDecisions({
    currentContext,
    startCacheRead,
    totalCreated,
    totalRead,
    totalOut,
    cacheIntegrityPct,
    cacheBreaks,
    wastedWriteTokens,
    readToOutRatio,
    ttlRemainingSec,
    isWarm,
    ageMin,
    models,
    turnsCount: turns.length,
    lastModel: lastTurn.model,
  });

  return {
    sessionId,
    shortId: sessionId.slice(0, 8),
    appName,
    title: customTitle || title || `(Session ${sessionId.slice(0, 8)})`,
    models,
    turnsCount: turns.length,
    firstTs: firstTurn.ts,
    lastTs: lastTurn.ts,
    lastActivityIso: new Date(lastTurn.ts).toISOString(),
    ageMin,
    ttlRemainingSec,
    isWarm,
    startCacheRead,
    currentContext,
    totalIn,
    totalOut,
    totalCreated,
    totalRead,
    totalW1h,
    totalW5m,
    totalTokens: totalIn + totalOut + totalCreated + totalRead,
    totalCost,
    cacheIntegrityPct,
    cacheBreaksCount: cacheBreaks.length,
    wastedWriteTokens,
    readToOutRatio,
    statusLevel: evaluation.statusLevel,
    decisions: evaluation.decisions,
    simulators: evaluation.simulators,
    turns,
  };
}

export function computeActive5HourBlock(allTurnsSorted) {
  const FIVE_HOURS_MS = 5 * 3600 * 1000;
  const now = Date.now();
  if (allTurnsSorted.length === 0) return null;

  let blockStartMs = null;
  for (const t of allTurnsSorted) {
    if (!t.ts) continue;
    if (blockStartMs === null || t.ts - blockStartMs >= FIVE_HOURS_MS) {
      const d = new Date(t.ts);
      d.setMinutes(0, 0, 0);
      blockStartMs = d.getTime();
    }
  }

  if (!blockStartMs || now - blockStartMs >= FIVE_HOURS_MS) {
    return { active: false };
  }

  const blockEndMs = blockStartMs + FIVE_HOURS_MS;
  const elapsedMin = Math.max(1, Math.round((now - blockStartMs) / 60000));
  const remainingMin = Math.max(0, Math.round((blockEndMs - now) / 60000));

  const blockTurns = allTurnsSorted.filter(t => t.ts >= blockStartMs && t.ts <= now);
  const inputTokens = blockTurns.reduce((s, t) => s + t.inp, 0);
  const outputTokens = blockTurns.reduce((s, t) => s + t.out, 0);
  const cacheCreateTokens = blockTurns.reduce((s, t) => s + t.cr, 0);
  const cacheReadTokens = blockTurns.reduce((s, t) => s + t.rd, 0);
  const totalTokens = inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens;
  const totalCost = blockTurns.reduce((s, t) => s + t.cost, 0);

  const tokensPerMin = Math.round(totalTokens / elapsedMin);
  const costPerHour = (totalCost / elapsedMin) * 60;

  let blockAdvice = `Block resets in ${Math.floor(remainingMin / 60)}h ${remainingMin % 60}m.`;
  if (remainingMin <= 60) {
    blockAdvice = `USE IT OR LOSE IT: ${remainingMin}m left in this 5h window. Run pending tasks before reset.`;
  }

  return {
    active: true,
    blockStartIso: new Date(blockStartMs).toISOString(),
    blockEndIso: new Date(blockEndMs).toISOString(),
    elapsedMin,
    remainingMin,
    inputTokens,
    outputTokens,
    cacheCreateTokens,
    cacheReadTokens,
    totalTokens,
    totalCost,
    tokensPerMin,
    costPerHour,
    blockAdvice,
  };
}

export function scanAllSessions({ days = 2, appFilter = '' } = {}) {
  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) {
    return { sessions: [], apps: [], activeBlock: { active: false } };
  }

  const cutoff = days > 0 ? Date.now() - days * 86400000 : 0;
  const projectDirs = fs.readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true }).filter(d => d.isDirectory());

  const sessions = [];
  const allRecentTurns = [];

  for (const dir of projectDirs) {
    const appName = cleanAppName(dir.name);
    if (appFilter && !appName.toLowerCase().includes(appFilter.toLowerCase())) continue;

    const fullDir = path.join(CLAUDE_PROJECTS_DIR, dir.name);
    let files = [];
    try {
      files = fs.readdirSync(fullDir).filter(f => f.endsWith('.jsonl'));
    } catch { continue; }

    for (const file of files) {
      const fullPath = path.join(fullDir, file);
      let stat;
      try { stat = fs.statSync(fullPath); } catch { continue; }
      if (cutoff && stat.mtimeMs < cutoff) continue;

      const parsed = parseSessionFile(fullPath, appName);
      if (parsed && (!cutoff || parsed.lastTs >= cutoff)) {
        sessions.push(parsed);
        for (const t of parsed.turns) {
          if (t.ts >= Date.now() - 48 * 3600 * 1000) allRecentTurns.push(t);
        }
      }
    }
  }

  sessions.sort((a, b) => b.lastTs - a.lastTs);
  allRecentTurns.sort((a, b) => a.ts - b.ts);

  const activeBlock = computeActive5HourBlock(allRecentTurns);

  const appMap = new Map();
  for (const s of sessions) {
    if (!appMap.has(s.appName)) {
      appMap.set(s.appName, {
        appName: s.appName,
        sessionsCount: 0,
        warmCount: 0,
        totalTurns: 0,
        totalCost: 0,
        totalTokens: 0,
        totalRead: 0,
        totalCreated: 0,
        totalOut: 0,
        totalWastedWrites: 0,
        avgIntegritySum: 0,
        maxContext: 0,
        lastTs: 0,
      });
    }
    const a = appMap.get(s.appName);
    a.sessionsCount++;
    if (s.isWarm) a.warmCount++;
    a.totalTurns += s.turnsCount;
    a.totalCost += s.totalCost;
    a.totalTokens += s.totalTokens;
    a.totalRead += s.totalRead;
    a.totalCreated += s.totalCreated;
    a.totalOut += s.totalOut;
    a.totalWastedWrites += s.wastedWriteTokens;
    a.avgIntegritySum += s.cacheIntegrityPct;
    if (s.currentContext > a.maxContext) a.maxContext = s.currentContext;
    if (s.lastTs > a.lastTs) a.lastTs = s.lastTs;
  }

  const apps = Array.from(appMap.values())
    .map(a => ({
      ...a,
      avgIntegrityPct: Math.round(a.avgIntegritySum / a.sessionsCount),
    }))
    .sort((a, b) => b.totalCost - a.totalCost);

  return {
    sessions,
    apps,
    activeBlock,
    scannedAt: new Date().toISOString(),
    daysFilter: days,
  };
}
