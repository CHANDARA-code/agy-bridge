const fs = require('fs');
const path = require('path');

function getPeriodStart(period, now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  if (period === 'day') {
    return start;
  }
  if (period === 'week') {
    const day = now.getDay();
    const diff = day === 0 ? 6 : day - 1;
    start.setDate(start.getDate() - diff);
    return start;
  }
  if (period === 'month') {
    return new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  }
  throw new Error(`Invalid budget period: ${period}`);
}

let usageCache = { key: null, records: [] };

function readUsageRecords() {
  const { USAGE_LOG } = require('./dispatcher');
  let stat;
  try {
    stat = fs.statSync(USAGE_LOG);
  } catch (err) {
    return [];
  }
  const key = `${USAGE_LOG}:${stat.mtimeMs}:${stat.size}`;
  if (usageCache.key === key) return usageCache.records;
  let content = '';
  try {
    content = fs.readFileSync(USAGE_LOG, 'utf-8');
  } catch (err) {
    return [];
  }
  const lines = content.split('\n');
  const records = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      records.push({ ...record, account: record.account || 'agy', provider: record.provider || 'agy' });
    } catch (err) {}
  }
  usageCache = { key, records };
  return records;
}

function usageCountsFor(account, record) {
  if (record.account !== account.id) return false;
  if (!account.createdAt || !record.at) return true;
  return Date.parse(record.at) >= Date.parse(account.createdAt);
}

function accountUsageTotals(account, records = null) {
  const totals = { tasks: 0, total_tokens: 0 };
  for (const r of records || readUsageRecords()) {
    if (!usageCountsFor(account, r)) continue;
    totals.tasks++;
    totals.total_tokens += Number(r.usage && r.usage.total_tokens) || 0;
  }
  return totals;
}

function getBudgetUsed(account, records = null, now = new Date()) {
  if (!account || !account.budget) return null;
  const { period, tokens } = account.budget;
  const start = getPeriodStart(period, now);
  const allRecords = records || readUsageRecords();
  let used = 0;
  for (const r of allRecords) {
    if (usageCountsFor(account, r) && r.usage && r.at) {
      const atDate = new Date(r.at);
      if (atDate >= start) {
        used += Number(r.usage.total_tokens) || 0;
      }
    }
  }
  const percent = tokens > 0 ? Math.round((100 * used) / tokens) : 0;
  return {
    tokens: used,
    percent,
    periodStart: start.toISOString()
  };
}

function getAccountsUsageReport(days = 30, now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const dayDates = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    dayDates.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
  }
  const fromStr = dayDates[0];
  const toStr = dayDates[dayDates.length - 1];

  const rangeStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1), 0, 0, 0, 0);
  const rangeEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const last7dStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6, 0, 0, 0, 0);

  const allRecords = readUsageRecords();
  const inRangeRecords = allRecords.filter((r) => {
    if (!r.at) return false;
    const d = new Date(r.at);
    return d >= rangeStart && d <= rangeEnd;
  });

  const totals = {
    tasks: inRangeRecords.length,
    total_tokens: 0,
    cost_usd: 0
  };
  for (const r of inRangeRecords) {
    const u = r.usage || {};
    totals.total_tokens += Number(u.total_tokens) || 0;
    if (u.cost_usd !== undefined) totals.cost_usd += Number(u.cost_usd) || 0;
  }
  totals.cost_usd = Math.round(totals.cost_usd * 1000000) / 1000000;

  const { listAccounts } = require('./accounts');
  const allAccounts = listAccounts();

  const accountEntries = allAccounts.map((acc) => {
    const accRecords = inRangeRecords.filter((r) => usageCountsFor(acc, r));
    const accAllRecords = allRecords.filter((r) => usageCountsFor(acc, r));

    const accTotals = {
      tasks: accRecords.length,
      input_tokens: 0,
      output_tokens: 0,
      thinking_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 0,
      cost_usd: 0
    };
    for (const r of accRecords) {
      const u = r.usage || {};
      accTotals.input_tokens += Number(u.input_tokens) || 0;
      accTotals.output_tokens += Number(u.output_tokens) || 0;
      accTotals.thinking_tokens += Number(u.thinking_tokens) || 0;
      accTotals.cache_read_tokens += Number(u.cache_read_tokens) || 0;
      accTotals.total_tokens += Number(u.total_tokens) || 0;
      if (u.cost_usd !== undefined) accTotals.cost_usd += Number(u.cost_usd) || 0;
    }
    accTotals.cost_usd = Math.round(accTotals.cost_usd * 1000000) / 1000000;

    let todayTasks = 0;
    let todayTokens = 0;
    let last7dTasks = 0;
    let last7dTokens = 0;
    for (const r of accAllRecords) {
      if (!r.at) continue;
      const d = new Date(r.at);
      const tok = Number(r.usage && r.usage.total_tokens) || 0;
      if (d >= todayStart) {
        todayTasks++;
        todayTokens += tok;
      }
      if (d >= last7dStart) {
        last7dTasks++;
        last7dTokens += tok;
      }
    }

    const byDayMap = new Map();
    for (const dateStr of dayDates) {
      byDayMap.set(dateStr, { date: dateStr, tasks: 0, total_tokens: 0 });
    }
    for (const r of accRecords) {
      const d = new Date(r.at);
      const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      const slot = byDayMap.get(dateStr);
      if (slot) {
        slot.tasks++;
        slot.total_tokens += Number(r.usage && r.usage.total_tokens) || 0;
      }
    }
    const byDay = Array.from(byDayMap.values());

    const roleMap = new Map();
    for (const r of accRecords) {
      const role = r.role || 'unknown';
      let entry = roleMap.get(role);
      if (!entry) {
        entry = { role, tasks: 0, total_tokens: 0 };
        roleMap.set(role, entry);
      }
      entry.tasks++;
      entry.total_tokens += Number(r.usage && r.usage.total_tokens) || 0;
    }
    const byRole = Array.from(roleMap.values()).sort((a, b) => b.total_tokens - a.total_tokens);

    const modelMap = new Map();
    for (const r of accRecords) {
      if (r.models && typeof r.models === 'object' && Object.keys(r.models).length > 0) {
        for (const [mName, mInfo] of Object.entries(r.models)) {
          let entry = modelMap.get(mName);
          if (!entry) {
            entry = { model: mName, tasks: 0, total_tokens: 0, cost_usd: 0 };
            modelMap.set(mName, entry);
          }
          entry.tasks++;
          entry.total_tokens += Number(mInfo.total_tokens) || 0;
          entry.cost_usd += Number(mInfo.cost_usd) || 0;
        }
      } else {
        const mName = r.model || 'default';
        let entry = modelMap.get(mName);
        if (!entry) {
          entry = { model: mName, tasks: 0, total_tokens: 0, cost_usd: 0 };
          modelMap.set(mName, entry);
        }
        entry.tasks++;
        entry.total_tokens += Number(r.usage && r.usage.total_tokens) || 0;
        entry.cost_usd += Number(r.usage && r.usage.cost_usd) || 0;
      }
    }
    const byModel = Array.from(modelMap.values()).sort((a, b) => b.total_tokens - a.total_tokens);
    for (const bm of byModel) {
      bm.cost_usd = Math.round(bm.cost_usd * 1000000) / 1000000;
    }

    let lastUsedAt = null;
    for (const r of accAllRecords) {
      if (r.at && (!lastUsedAt || r.at > lastUsedAt)) {
        lastUsedAt = r.at;
      }
    }

    const budgetUsed = acc.budget ? getBudgetUsed(acc, allRecords, now) : null;

    return {
      id: acc.id,
      provider: acc.provider,
      label: acc.label,
      system: Boolean(acc.system),
      identity: acc.identity || null,
      totals: accTotals,
      today: { tasks: todayTasks, total_tokens: todayTokens },
      last7d: { tasks: last7dTasks, total_tokens: last7dTokens },
      byDay,
      byRole,
      byModel,
      lastUsedAt,
      limits: acc.limits || null,
      budget: acc.budget || null,
      budgetUsed
    };
  });

  return {
    days,
    from: fromStr,
    to: toStr,
    generatedAt: now.toISOString(),
    totals,
    accounts: accountEntries
  };
}

function formatClaudeWindowLabel(key) {
  if (key === 'five_hour') return '5-hour';
  if (key === 'seven_day') return '7-day';
  if (key === 'seven_day_opus') return '7-day Opus';
  if (key === 'seven_day_sonnet') return '7-day Sonnet';
  return key.replace(/_/g, ' ');
}

function formatCodexWindowLabel(minutes) {
  if (minutes === 300) return '5-hour';
  if (minutes === 10080) return 'Weekly';
  return `${minutes}-minute`;
}

function parseClaudeQuota(rateLimitInfo, taskRecord) {
  if (!rateLimitInfo) {
    if (taskRecord && taskRecord.status === 'failed' && /usage limit|hit your limit|rate limit/i.test(taskRecord.agentError || '')) {
      return {
        checkedAt: new Date().toISOString(),
        status: 'limited',
        detail: taskRecord.agentError || 'Usage limit reached',
        windows: []
      };
    }
    return null;
  }
  const windows = [];
  const uWindows = rateLimitInfo.unifiedWindows || {};
  for (const [key, win] of Object.entries(uWindows)) {
    if (!win) continue;
    const resetsAt = win.resetsAt
      ? (typeof win.resetsAt === 'number' && win.resetsAt < 1e11
          ? new Date(win.resetsAt * 1000).toISOString()
          : new Date(win.resetsAt).toISOString())
      : null;
    windows.push({
      name: key,
      label: formatClaudeWindowLabel(key),
      usedPercent: Math.round((Number(win.utilization) || 0) * 100),
      resetsAt
    });
  }
  const isLimited = (rateLimitInfo.status && rateLimitInfo.status !== 'allowed') ||
    Boolean(taskRecord && taskRecord.status === 'failed' && /usage limit|hit your limit|rate limit/i.test(taskRecord.agentError || ''));
  return {
    checkedAt: new Date().toISOString(),
    status: isLimited ? 'limited' : 'ok',
    detail: isLimited ? (taskRecord && taskRecord.agentError) || (rateLimitInfo.status !== 'allowed' ? rateLimitInfo.status : null) : null,
    windows
  };
}

function parseCodexQuota(rateLimits) {
  if (!rateLimits) return null;
  const windows = [];
  if (rateLimits.primary) {
    const p = rateLimits.primary;
    windows.push({
      name: 'primary',
      label: formatCodexWindowLabel(p.window_minutes),
      usedPercent: Math.round(Number(p.used_percent) || 0),
      resetsAt: p.resets_at ? new Date(p.resets_at * 1000).toISOString() : null
    });
  }
  if (rateLimits.secondary) {
    const s = rateLimits.secondary;
    windows.push({
      name: 'secondary',
      label: formatCodexWindowLabel(s.window_minutes),
      usedPercent: Math.round(Number(s.used_percent) || 0),
      resetsAt: s.resets_at ? new Date(s.resets_at * 1000).toISOString() : null
    });
  }
  const isLimited = rateLimits.rate_limit_reached_type !== null && rateLimits.rate_limit_reached_type !== undefined;
  return {
    checkedAt: new Date().toISOString(),
    status: isLimited ? 'limited' : 'ok',
    detail: isLimited ? String(rateLimits.rate_limit_reached_type) : null,
    windows
  };
}

function findCodexRolloutRateLimits(account, conversationId) {
  if (!conversationId) return null;
  const { accountFolder } = require('./accounts');
  let codexHome;
  if (account.system) {
    codexHome = process.env.CODEX_HOME || path.join(process.env.HOME || '', '.codex');
  } else {
    codexHome = accountFolder(account);
  }
  const pad = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  const dirs = [
    path.join(codexHome, 'sessions', String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate())),
    path.join(codexHome, 'sessions', String(yesterday.getFullYear()), pad(yesterday.getMonth() + 1), pad(yesterday.getDate()))
  ];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    let files = [];
    try {
      files = fs.readdirSync(dir);
    } catch (err) {
      continue;
    }
    const matchingFiles = files.filter((f) => f.includes(conversationId) && f.endsWith('.jsonl'));
    for (const file of matchingFiles) {
      try {
        const fullPath = path.join(dir, file);
        const lines = fs.readFileSync(fullPath, 'utf-8').split('\n');
        let lastRateLimits = null;
        for (const line of lines) {
          if (!line.includes('rate_limits')) continue;
          try {
            const parsed = JSON.parse(line);
            const rl = (parsed.payload && parsed.payload.rate_limits) || parsed.rate_limits;
            if (rl) lastRateLimits = rl;
          } catch (err) {}
        }
        if (lastRateLimits) return lastRateLimits;
      } catch (err) {}
    }
  }
  return null;
}

function checkAgyQuotaExhaustion(taskRecord, stderrTail = '') {
  if (!taskRecord || taskRecord.status !== 'failed') return null;
  const failureText = `${taskRecord.agentError || ''}\n${stderrTail}`;
  const pattern = /quota|resource.?exhausted|capacity.?exhausted|rate.?limit|resets in/i;
  if (pattern.test(failureText)) {
    const match = failureText.match(pattern);
    return {
      checkedAt: new Date().toISOString(),
      status: 'limited',
      detail: match ? match[0] : 'Quota or rate limit reached',
      windows: []
    };
  }
  return null;
}

function formatAccountUsageForMcp(now = new Date()) {
  const { listAccounts } = require('./accounts');
  const accountsList = listAccounts();
  const allRecords = readUsageRecords();
  const pad = (n) => String(n).padStart(2, '0');
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const last7dStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6, 0, 0, 0, 0);

  const lines = accountsList.map((acc) => {
    let todayTokens = 0;
    let last7dTokens = 0;
    for (const r of allRecords) {
      if (!usageCountsFor(acc, r) || !r.at) continue;
      const d = new Date(r.at);
      const tok = Number(r.usage && r.usage.total_tokens) || 0;
      if (d >= todayStart) todayTokens += tok;
      if (d >= last7dStart) last7dTokens += tok;
    }

    const { PROVIDERS } = require('./providers');
    const pName = (PROVIDERS[acc.provider] && PROVIDERS[acc.provider].name) || acc.provider;
    const parts = [
      `today ${todayTokens.toLocaleString('en-US')}`,
      `7 days ${last7dTokens.toLocaleString('en-US')} tokens`
    ];

    if (acc.limits && Array.isArray(acc.limits.windows) && acc.limits.windows.length > 0) {
      for (const w of acc.limits.windows) {
        let winStr = `${w.label} ${w.usedPercent}%`;
        if (w.resetsAt) {
          const d = new Date(w.resetsAt);
          winStr += ` (resets ${pad(d.getHours())}:${pad(d.getMinutes())})`;
        }
        parts.push(winStr);
      }
    } else if (acc.limits && acc.limits.status === 'limited') {
      parts.push(`limited${acc.limits.detail ? ': ' + acc.limits.detail : ''}`);
    }

    if (acc.budget) {
      const bUsed = getBudgetUsed(acc, allRecords, now);
      if (bUsed) {
        parts.push(`budget ${bUsed.percent}% of ${acc.budget.tokens.toLocaleString('en-US')}/${acc.budget.period}`);
      }
    }

    return `- ${acc.id} (${pName}, ${acc.label}): ${parts.join(' · ')}`;
  });

  return lines.join('\n');
}

module.exports = {
  getPeriodStart,
  readUsageRecords,
  usageCountsFor,
  accountUsageTotals,
  getBudgetUsed,
  getAccountsUsageReport,
  formatClaudeWindowLabel,
  formatCodexWindowLabel,
  parseClaudeQuota,
  parseCodexQuota,
  findCodexRolloutRateLimits,
  checkAgyQuotaExhaustion,
  formatAccountUsageForMcp
};
