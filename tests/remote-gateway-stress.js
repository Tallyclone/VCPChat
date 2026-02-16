const WebSocket = require('ws');

const TARGET = process.env.TARGET || 'ws://127.0.0.1:17888';
const TOKEN = process.env.TOKEN || 'vchat-remote-token';
const CLIENTS = Number(process.env.CLIENTS || 20);
const DURATION_MS = Number(process.env.DURATION_MS || 30000);

let connected = 0;
let authOk = 0;
let rpcOk = 0;
let rpcFail = 0;
let rpcLatencyTotal = 0;
const rpcLatencies = [];
let eventCount = 0;
let closed = 0;
const sockets = [];

function createClient(index) {
  const ws = new WebSocket(TARGET);
  sockets.push(ws);

  let rpcId = 1;
  const pending = new Map();

  function send(payload) {
    ws.send(JSON.stringify(payload));
  }

  function call(method, params = {}) {
    const id = rpcId++;
    send({ type: 'rpc', id, method, params });
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, startedAt: Date.now() });
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`timeout: ${method}`));
        }
      }, 10000);
    });
  }

  ws.on('open', () => {
    connected += 1;
  });

  ws.on('message', async (event) => {
    const msg = JSON.parse(event.toString());

    if (msg.type === 'hello') {
      send({ type: 'auth', token: TOKEN, role: 'operator', clientId: `stress_${index}_${Date.now()}` });
      return;
    }

    if (msg.type === 'auth_result') {
      if (msg.success) {
        authOk += 1;
        try {
          await call('getAgents');
          rpcOk += 1;
        } catch (e) {
          rpcFail += 1;
        }
      }
      return;
    }

    if (msg.type === 'rpc_result') {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        const latency = Date.now() - p.startedAt;
        rpcLatencyTotal += latency;
        rpcLatencies.push(latency);
        if (msg.success) p.resolve(msg.result);
        else p.reject(new Error(msg.error || 'rpc error'));
      }
      return;
    }

    if (msg.type === 'event') {
      eventCount += 1;
    }
  });

  ws.on('close', () => {
    closed += 1;
  });

  ws.on('error', () => {
    // ignore per-client noise
  });
}

for (let i = 0; i < CLIENTS; i += 1) {
  createClient(i + 1);
}

setTimeout(() => {
  sockets.forEach((s) => {
    try { s.close(); } catch (_) {}
  });

  const sorted = [...rpcLatencies].sort((a, b) => a - b);
  const p95 = sorted.length ? sorted[Math.max(0, Math.floor(sorted.length * 0.95) - 1)] : 0;
  const p99 = sorted.length ? sorted[Math.max(0, Math.floor(sorted.length * 0.99) - 1)] : 0;
  const avgLatency = rpcLatencies.length ? Math.round((rpcLatencyTotal / rpcLatencies.length) * 100) / 100 : 0;

  const report = {
    target: TARGET,
    clients: CLIENTS,
    durationMs: DURATION_MS,
    connected,
    authOk,
    rpcOk,
    rpcFail,
    rpcCount: rpcLatencies.length,
    rpcAvgMs: avgLatency,
    rpcP95Ms: p95,
    rpcP99Ms: p99,
    eventCount,
    closed
  };

  console.log('[stress-report]', JSON.stringify(report, null, 2));
  process.exit(0);
}, DURATION_MS);
