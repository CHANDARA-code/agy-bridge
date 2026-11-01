const http = require('http');
const url = require('url');
const { getAgentCard, runAgyTask, cancelTask, activeTasks } = require('./dispatcher');
const dashboard = require('./dashboard');
const security = require('./security');
const presets = require('./presets');
const accounts = require('./accounts');

process.on('unhandledRejection', (err) => {
  console.error('[A2A Protocol Server] Unhandled rejection:', err && err.message);
});

const PORT = parseInt(process.env.A2A_PORT || '5188', 10);
const HOST = process.env.A2A_HOST || '127.0.0.1';
const TOKEN = security.loadOrCreateToken();
const ALLOWED_HOSTS = security.allowedHosts(HOST, PORT);

function sendJson(res, statusCode, data) {
  const payload = JSON.stringify(data, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(payload);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > 10 * 1024 * 1024) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error('Invalid JSON: ' + err.message));
      }
    });
    req.on('error', reject);
  });
}

function extractPromptFromParams(params) {
  if (!params) return null;
  if (typeof params.prompt === 'string' && params.prompt.trim()) {
    return params.prompt;
  }
  if (params.message) {
    if (typeof params.message === 'string') return params.message;
    if (Array.isArray(params.message.parts)) {
      const texts = params.message.parts
        .map(p => (typeof p === 'string' ? p : p.text || ''))
        .filter(Boolean);
      if (texts.length > 0) return texts.join('\n');
    }
  }
  return null;
}

// Message for a "preset" request field that is not a known preset id, null, "" or "none".
function presetError(preset) {
  if (preset === undefined) return null;
  if (preset !== null && typeof preset !== 'string') return 'preset must be a preset id, or null for none';
  try {
    presets.resolvePresetId(preset);
    return null;
  } catch (err) {
    return err.message;
  }
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method.toUpperCase();

  if (!security.isAllowedHost(req, ALLOWED_HOSTS)) {
    return sendJson(res, 403, { error: 'Forbidden host' });
  }

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (method !== 'GET' && method !== 'HEAD') {
    if (!security.isSameOrigin(req)) {
      return sendJson(res, 403, { error: 'Cross-origin requests are not allowed' });
    }
    if (!security.isValidToken(req, TOKEN)) {
      return sendJson(res, 401, { error: `Missing or invalid token. Send it as "Authorization: Bearer <token>" or "X-A2A-Token"; it is stored in ${security.TOKEN_FILE}` });
    }
  }

  try {
    if (await dashboard.handle(req, res, pathname, { token: TOKEN })) return;

    // 1. A2A Agent Card Discovery (Official path: /.well-known/agent-card.json)
    if (
      method === 'GET' &&
      (pathname === '/.well-known/agent-card.json' ||
        pathname === '/agent-card.json' ||
        pathname === '/.well-known/agent.json' ||
        pathname === '/agent.json')
    ) {
      return sendJson(res, 200, getAgentCard());
    }

    // 2. Health & Status
    if (method === 'GET' && pathname === '/health') {
      return sendJson(res, 200, {
        status: 'healthy',
        service: 'antigravity-a2a-protocol-server',
        version: '1.0.0',
        protocolVersion: '1.0.0',
        uptime: process.uptime(),
        activeTaskCount: Array.from(activeTasks.values()).filter(t => t.status === 'running').length
      });
    }

    // 3. List Skills (A2A official terminology)
    if (method === 'GET' && (pathname === '/skills' || pathname === '/roles' || pathname === '/agents')) {
      const card = getAgentCard();
      return sendJson(res, 200, { skills: card.skills || [] });
    }

    // 4. List Tasks
    if (method === 'GET' && pathname === '/tasks') {
      const tasks = Array.from(activeTasks.values()).map(t => ({
        id: t.id,
        role: t.role,
        status: t.status,
        startedAt: t.startedAt,
        finishedAt: t.finishedAt,
        workspace: t.workspace,
        promptPreview: t.prompt ? t.prompt.slice(0, 100) : ''
      }));
      return sendJson(res, 200, { tasks });
    }

    // 5. Get Specific Task
    const taskGetMatch = pathname.match(/^\/tasks\/([a-zA-Z0-9_\-]+)$/);
    if (method === 'GET' && taskGetMatch) {
      const taskId = taskGetMatch[1];
      const task = activeTasks.get(taskId);
      if (!task) {
        return sendJson(res, 404, { error: 'Task not found', taskId });
      }
      return sendJson(res, 200, {
        id: task.id,
        role: task.role,
        account: task.account || null,
        provider: task.provider || null,
        status: task.status,
        startedAt: task.startedAt,
        finishedAt: task.finishedAt,
        exitCode: task.exitCode,
        output: task.output,
        error: task.error,
        workspace: task.workspace,
        usage: task.usage || null,
        verification: task.verification || null,
        conversationId: task.conversationId || null,
        changes: task.changes || null,
        preset: task.preset || null,
        preferenceFiles: task.preferenceFiles || []
      });
    }

    // 6. Cancel Task
    const taskCancelMatch = pathname.match(/^\/tasks\/([a-zA-Z0-9_\-]+)\/cancel$/);
    if (method === 'POST' && taskCancelMatch) {
      const taskId = taskCancelMatch[1];
      const task = activeTasks.get(taskId);
      if (!task) {
        return sendJson(res, 404, { error: 'Task not found', taskId });
      }
      if (task.status === 'running') {
        const result = cancelTask(taskId);
        if (!result.ok) return sendJson(res, result.code, { error: result.error, taskId });
      }
      return sendJson(res, 200, { id: taskId, status: task.status });
    }

    // 7. REST Task Dispatch: POST /tasks/send or POST /tasks or POST /message/send
    if (method === 'POST' && (pathname === '/tasks/send' || pathname === '/tasks' || pathname === '/message/send')) {
      const body = await parseBody(req);
      const role = body.skill || body.role || 'lead-software-engineer';
      const prompt = extractPromptFromParams(body) || body.prompt;
      const workspace = body.workspace;
      const mode = body.mode || 'accept-edits';
      const effort = body.effort || 'high';
      const model = body.model;
      const conversation_id = body.conversation_id;
      const verification_command = typeof body.verification_command === 'string' ? body.verification_command : undefined;
      const preset = body.preset;
      const account = body.account;
      const isAsync = body.isAsync || body.async || false;

      if (!prompt) {
        return sendJson(res, 400, { error: 'Missing required parameter: "prompt" or "message"' });
      }
      const presetProblem = presetError(preset);
      if (presetProblem) {
        return sendJson(res, 400, { error: presetProblem });
      }
      if (account !== undefined && account !== null) {
        if (typeof account !== 'string' || !accounts.getAccount(account)) {
          return sendJson(res, 400, { error: 'Unknown account' });
        }
      }

      if (isAsync) {
        const { taskId, taskRecord } = runAgyTask({ role, prompt, workspace, mode, effort, model, conversation_id, verification_command, preset, account });
        return sendJson(res, 202, {
          taskId,
          status: 'running',
          skill: taskRecord.role,
          account: taskRecord.account,
          provider: taskRecord.provider,
          preset: taskRecord.preset,
          workspace: taskRecord.workspace,
          checkUrl: `http://${HOST}:${PORT}/tasks/${taskId}`
        });
      }

      return await new Promise((resolve) => {
        runAgyTask({
          role,
          prompt,
          workspace,
          mode,
          effort,
          model,
          conversation_id,
          verification_command,
          preset,
          account,
          onDone: (taskRecord) => {
            sendJson(res, 200, {
              taskId: taskRecord.id,
              account: taskRecord.account,
              provider: taskRecord.provider,
              preset: taskRecord.preset,
              preferenceFiles: taskRecord.preferenceFiles,
              usage: taskRecord.usage,
              verification: taskRecord.verification,
              conversationId: taskRecord.conversationId,
              changes: taskRecord.changes,
              status: taskRecord.status,
              skill: taskRecord.role,
              workspace: taskRecord.workspace,
              exitCode: taskRecord.exitCode,
              message: {
                role: 'ROLE_ASSISTANT',
                parts: [{ text: taskRecord.output }]
              },
              output: taskRecord.output,
              startedAt: taskRecord.startedAt,
              finishedAt: taskRecord.finishedAt
            });
            resolve();
          },
          onError: (err) => {
            sendJson(res, 500, {
              error: err.message,
              status: 'failed'
            });
            resolve();
          }
        });
      });
    }

    // 8. Official JSON-RPC 2.0 Endpoint: POST /rpc or POST /
    if (method === 'POST' && (pathname === '/rpc' || pathname === '/')) {
      const body = await parseBody(req);
      const { jsonrpc, id, method: rpcMethod, params } = body;

      if (jsonrpc !== '2.0') {
        return sendJson(res, 400, {
          jsonrpc: '2.0',
          id: id || null,
          error: { code: -32600, message: 'Invalid Request: jsonrpc must be 2.0' }
        });
      }

      // Spec method: agent.getCard / agent/card
      if (rpcMethod === 'agent.getCard' || rpcMethod === 'agent/card') {
        return sendJson(res, 200, { jsonrpc: '2.0', id, result: getAgentCard() });
      }

      // Spec method: agent.listSkills / agent/skills
      if (rpcMethod === 'agent.listSkills' || rpcMethod === 'agent.listRoles') {
        const card = getAgentCard();
        return sendJson(res, 200, { jsonrpc: '2.0', id, result: card.skills || [] });
      }

      // Official Spec Method: message/send or legacy tasks.send
      if (rpcMethod === 'message/send' || rpcMethod === 'tasks.send') {
        const role = (params && (params.skill || params.role)) || 'lead-software-engineer';
        const prompt = extractPromptFromParams(params);
        const workspace = params && params.workspace;
        const mode = (params && params.mode) || 'accept-edits';
        const effort = (params && params.effort) || 'high';
        const model = params && params.model;
        const conversation_id = params && params.conversation_id;
        const verification_command = params && typeof params.verification_command === 'string' ? params.verification_command : undefined;
        const preset = params ? params.preset : undefined;
        const account = params && params.account;
        const isAsync = (params && (params.isAsync || params.async)) || false;

        if (!prompt) {
          return sendJson(res, 200, {
            jsonrpc: '2.0',
            id,
            error: { code: -32602, message: 'Missing parameter: prompt or message.parts[].text' }
          });
        }
        const presetProblem = presetError(preset);
        if (presetProblem) {
          return sendJson(res, 200, { jsonrpc: '2.0', id, error: { code: -32602, message: presetProblem } });
        }
        if (account !== undefined && account !== null) {
          if (typeof account !== 'string' || !accounts.getAccount(account)) {
            return sendJson(res, 200, { jsonrpc: '2.0', id, error: { code: -32602, message: 'Unknown account' } });
          }
        }

        if (isAsync) {
          const { taskId, taskRecord } = runAgyTask({ role, prompt, workspace, mode, effort, model, conversation_id, verification_command, preset, account });
          return sendJson(res, 200, {
            jsonrpc: '2.0',
            id,
            result: {
              taskId,
              status: 'running',
              skill: taskRecord.role,
              account: taskRecord.account,
              provider: taskRecord.provider,
              preset: taskRecord.preset
            }
          });
        }

        return await new Promise((resolve) => {
          runAgyTask({
            role,
            prompt,
            workspace,
            mode,
            effort,
            model,
            conversation_id,
            verification_command,
            preset,
            account,
            onDone: (taskRecord) => {
              sendJson(res, 200, {
                jsonrpc: '2.0',
                id,
                result: {
                  taskId: taskRecord.id,
                  account: taskRecord.account,
                  provider: taskRecord.provider,
                  usage: taskRecord.usage,
                  verification: taskRecord.verification,
                  conversationId: taskRecord.conversationId,
                  changes: taskRecord.changes,
                  status: taskRecord.status,
                  skill: taskRecord.role,
                  message: {
                    role: 'ROLE_ASSISTANT',
                    parts: [{ text: taskRecord.output }]
                  },
                  output: taskRecord.output,
                  exitCode: taskRecord.exitCode
                }
              });
              resolve();
            },
            onError: (err) => {
              sendJson(res, 200, {
                jsonrpc: '2.0',
                id,
                error: { code: -32000, message: err.message }
              });
              resolve();
            }
          });
        });
      }

      if (rpcMethod === 'tasks/list' || rpcMethod === 'tasks.list') {
        const wanted = params && params.status;
        const pageSize = Math.min(Math.max(parseInt(params && params.pageSize, 10) || 50, 1), 100);
        const tasks = dashboard.listTasks()
          .filter((task) => !wanted || task.status === wanted)
          .slice(0, pageSize);
        return sendJson(res, 200, { jsonrpc: '2.0', id, result: { tasks } });
      }

      // Spec method: tasks/get or tasks.get
      if (rpcMethod === 'tasks/get' || rpcMethod === 'tasks.get') {
        const taskId = params && (params.taskId || params.id);
        const task = activeTasks.get(taskId);
        if (!task) {
          return sendJson(res, 200, { jsonrpc: '2.0', id, error: { code: -32602, message: 'Task not found' } });
        }
        return sendJson(res, 200, {
          jsonrpc: '2.0',
          id,
          result: {
            id: task.id,
            status: task.status,
            skill: task.role,
            account: task.account || null,
            provider: task.provider || null,
            message: {
              role: 'ROLE_ASSISTANT',
              parts: [{ text: task.output }]
            },
            output: task.output,
            exitCode: task.exitCode,
            error: task.error,
            workspace: task.workspace,
            usage: task.usage || null,
            verification: task.verification || null,
            conversationId: task.conversationId || null,
            changes: task.changes || null,
            preset: task.preset || null,
            preferenceFiles: task.preferenceFiles || []
          }
        });
      }

      // Spec method: tasks/cancel or tasks.cancel
      if (rpcMethod === 'tasks/cancel' || rpcMethod === 'tasks.cancel') {
        const taskId = params && (params.taskId || params.id);
        const task = activeTasks.get(taskId);
        if (!task) {
          return sendJson(res, 200, { jsonrpc: '2.0', id, error: { code: -32602, message: 'Task not found' } });
        }
        if (task.status === 'running') {
          const result = cancelTask(task.id);
          if (!result.ok) {
            return sendJson(res, 200, { jsonrpc: '2.0', id, error: { code: -32000, message: result.error } });
          }
        }
        return sendJson(res, 200, {
          jsonrpc: '2.0',
          id,
          result: { id: task.id, status: task.status }
        });
      }

      return sendJson(res, 200, {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${rpcMethod}` }
      });
    }

    // Default 404
    return sendJson(res, 404, { error: 'Not found', path: pathname });
  } catch (err) {
    return sendJson(res, 500, { error: 'Internal server error', details: err.message });
  }
});

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function startServer() {
  if (!LOOPBACK_HOSTS.has(HOST)) {
    console.error(`[A2A Protocol Server] Refusing to listen on "${HOST}": the server hands its token to any client that can reach it, so it only binds to loopback (127.0.0.1, localhost or ::1).`);
    process.exit(1);
  }
  const { stopAllLogins } = require('./account-login');
  process.on('exit', stopAllLogins);
  for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]]) {
    process.once(signal, () => {
      stopAllLogins();
      process.exit(code);
    });
  }
  server.listen(PORT, HOST, () => {
    require('./telegram').reconfigure();
    console.log(`[A2A Protocol Server] Listening on http://${HOST}:${PORT}`);
    console.log(`[A2A Protocol Server] Agent Card: http://${HOST}:${PORT}/.well-known/agent-card.json`);
    console.log(`[A2A Protocol Server] JSON-RPC Endpoint: http://${HOST}:${PORT}/rpc`);
    console.log(`[A2A Protocol Server] Health: http://${HOST}:${PORT}/health`);
    console.log(`[A2A Protocol Server] Dashboard: http://${HOST}:${PORT}/dashboard`);
    console.log(`[A2A Protocol Server] POST requests need the token in ${security.TOKEN_FILE}`);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = { server, startServer };
