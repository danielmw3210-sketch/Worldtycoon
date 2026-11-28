import net from 'node:net';

/**
 * Real Monero/Numista JSON-RPC Stratum TCP Client Bridge
 * Connects a player's native Sb... address to an external PPLNS Stratum pool (host:port)
 * without flooding HTTP endpoints.
 */
class StratumBridgeManager {
  constructor() {
    this.sessions = new Map(); // username -> session state
  }

  getStatus(username) {
    const clean = String(username || '').trim().toLowerCase();
    const s = this.sessions.get(clean);
    if (!s) {
      return {
        connected: false,
        mode: 'pplns',
        poolHost: '',
        poolPort: 3333,
        loginAddress: '',
        workerName: clean,
        jobId: null,
        height: 0,
        target: null,
        acceptedShares: 0,
        rejectedShares: 0,
        lastError: null,
        connectedAt: null
      };
    }
    return {
      connected: s.connected,
      mode: s.mode,
      poolHost: s.poolHost,
      poolPort: s.poolPort,
      loginAddress: s.loginAddress,
      workerName: s.workerName,
      jobId: s.job?.job_id || null,
      blob: s.job?.blob || '',
      seedHash: s.job?.seed_hash || '',
      height: s.job?.height || 0,
      target: s.job?.target || null,
      acceptedShares: s.acceptedShares,
      rejectedShares: s.rejectedShares,
      lastError: s.lastError,
      connectedAt: s.connectedAt
    };
  }

  async submitShare({ username, jobId, nonceHex, resultHex }) {
    const clean = String(username || '').trim().toLowerCase();
    const s = this.sessions.get(clean);
    if (!s || !s.connected || !s.socket || !s.rpcId) {
      throw new Error('Stratum session not connected');
    }
    const id = s.nextRequestId++;
    const payload = JSON.stringify({
      id,
      jsonrpc: '2.0',
      method: 'submit',
      params: {
        id: s.rpcId,
        job_id: String(jobId || s.job?.job_id || ''),
        nonce: String(nonceHex || ''),
        result: String(resultHex || '')
      }
    }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        s.pendingSubmissions.delete(id);
        reject(new Error('Timed out waiting for pool share response'));
      }, 12000);
      s.pendingSubmissions.set(id, { resolve, reject, timer });
      s.socket.write(payload, err => {
        if (!err) return;
        const pending = s.pendingSubmissions.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        s.pendingSubmissions.delete(id);
        reject(err);
      });
    });
  }

  disconnect(username) {
    const clean = String(username || '').trim().toLowerCase();
    const s = this.sessions.get(clean);
    if (s) {
      if (s.keepaliveTimer) clearInterval(s.keepaliveTimer);
      for (const pending of s.pendingSubmissions.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Stratum session disconnected before pool response'));
      }
      s.pendingSubmissions.clear();
      try { s.socket?.destroy(); } catch {}
      this.sessions.delete(clean);
    }
    return this.getStatus(clean);
  }

  connect({ username, poolEndpoint, loginAddress, workerName = '', mode = 'pplns' }) {
    const clean = String(username || '').trim().toLowerCase();
    if (!clean) throw new Error('Username required');

    const raw = String(poolEndpoint || '').trim().replace(/^stratum\+tcp:\/\//i, '');
    const [host, portStr] = raw.split(':');
    const port = Number(portStr || 3333);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('Enter a valid Stratum pool endpoint as host:port (e.g. pool.example.com:3333)');
    }
    const builtInPort = Number(process.env.NUMISTA_STRATUM_PORT || 3333);
    if (!['127.0.0.1', 'localhost', '::1'].includes(host.toLowerCase()) || port !== builtInPort) {
      throw new Error(`Only the built-in pool is allowed (127.0.0.1:${builtInPort})`);
    }
    if (!loginAddress) {
      throw new Error('Player native Sb... address not ready yet; refresh wallet first');
    }

    this.disconnect(clean);

    const worker = String(workerName || clean).trim();
    const stratumLogin = worker ? `${loginAddress}.${worker}` : loginAddress;

    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      let buffer = '';
      let settled = false;

      const session = {
        socket,
        connected: false,
        mode,
        poolHost: host,
        poolPort: port,
        loginAddress,
        workerName: worker,
        rpcId: null,
        job: null,
        acceptedShares: 0,
        rejectedShares: 0,
        lastError: null,
        connectedAt: null,
        keepaliveTimer: null,
        nextRequestId: 3,
        pendingSubmissions: new Map()
      };
      this.sessions.set(clean, session);

      socket.setTimeout(12000);

      socket.on('connect', () => {
        const loginPayload = JSON.stringify({
          id: 1,
          jsonrpc: '2.0',
          method: 'login',
          params: {
            login: stratumLogin,
            pass: 'x',
            agent: 'Worldtycoon-StratumBridge/1.0'
          }
        }) + '\n';
        socket.write(loginPayload);
      });

      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let idx;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.id === 1 && msg.result) {
              if (!msg.result.id || !msg.result.job) {
                session.lastError = 'Stratum login response is missing a session ID or job';
                this.disconnect(clean);
                if (!settled) {
                  settled = true;
                  reject(new Error(session.lastError));
                }
                continue;
              }
              socket.setTimeout(0);
              session.connected = true;
              session.connectedAt = new Date().toISOString();
              session.rpcId = msg.result.id || null;
              session.job = msg.result.job || null;
              session.keepaliveTimer = setInterval(() => {
                if (session.connected && session.rpcId) {
                  try {
                    socket.write(JSON.stringify({
                      id: 2,
                      jsonrpc: '2.0',
                      method: 'keepalived',
                      params: { id: session.rpcId }
                    }) + '\n');
                  } catch {}
                }
              }, 45000);
              if (!settled) {
                settled = true;
                resolve(this.getStatus(clean));
              }
            } else if (msg.id === 1 && msg.error) {
              const errMsg = msg.error.message || 'Stratum login rejected by pool';
              session.lastError = errMsg;
              this.disconnect(clean);
              if (!settled) {
                settled = true;
                reject(new Error(errMsg));
              }
            } else if (msg.method === 'job' && msg.params) {
              session.job = msg.params;
            } else if (session.pendingSubmissions.has(msg.id)) {
              const pending = session.pendingSubmissions.get(msg.id);
              session.pendingSubmissions.delete(msg.id);
              clearTimeout(pending.timer);
              const accepted = !msg.error && msg.result?.status === 'OK';
              if (accepted) session.acceptedShares += 1;
              else session.rejectedShares += 1;
              session.lastError = accepted ? null : (msg.error?.message || 'Pool rejected share');
              pending.resolve({ accepted, error: session.lastError, status: this.getStatus(clean) });
            }
          } catch (err) {
            session.lastError = `Invalid Stratum message: ${err.message}`;
            console.warn('[stratum-bridge]', session.lastError);
          }
        }
      });

      socket.on('timeout', () => {
        const errMsg = `Connection timed out reaching Stratum pool ${host}:${port}`;
        session.lastError = errMsg;
        if (this.sessions.get(clean) === session) this.disconnect(clean);
        if (!settled) {
          settled = true;
          reject(new Error(errMsg));
        }
      });

      socket.on('error', (err) => {
        const errMsg = `Stratum socket error (${host}:${port}): ${err.message}`;
        session.lastError = errMsg;
        if (this.sessions.get(clean) === session) this.disconnect(clean);
        if (!settled) {
          settled = true;
          reject(new Error(errMsg));
        }
      });

      socket.on('close', () => {
        session.connected = false;
        if (session.keepaliveTimer) clearInterval(session.keepaliveTimer);
        for (const pending of session.pendingSubmissions.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error('Stratum connection closed before pool response'));
        }
        session.pendingSubmissions.clear();
        if (!settled) {
          settled = true;
          reject(new Error('Stratum connection closed before login completed'));
        }
      });

      socket.connect(port, host);
    });
  }
}

export const stratumBridge = new StratumBridgeManager();