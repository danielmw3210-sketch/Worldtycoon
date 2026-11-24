import net from 'node:net';
import { numistaRpc } from '../numista/rpc.js';
import { CONFIG } from '../config.js';

export function startBuiltInStratumServer(port = Number(process.env.NUMISTA_STRATUM_PORT || 3333)) {
  const clients = new Set();
  const server = net.createServer((socket) => {
    clients.add(socket);
    let buf = '';
    socket.on('data', async (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const req = JSON.parse(line);
          if (req.method === 'login') {
            const addr = String(req.params?.login || '').split('.')[0] || CONFIG.CHAIN.TREASURY_ADDRESS;
            const tpl = await numistaRpc.getBlockTemplate(addr, 60).catch(() => null);
            socket.write(JSON.stringify({
              id: req.id,
              jsonrpc: '2.0',
              result: {
                id: 'numista-pplns-' + Date.now(),
                job: {
                  blob: tpl?.blockhashingBlob || '00'.repeat(76),
                  job_id: 'job-' + (tpl?.height || 0) + '-' + Math.floor(Math.random() * 9999),
                  target: 'b88d0600',
                  height: tpl?.height || numistaRpc.syncStatus.height || 0,
                  seed_hash: tpl?.seedHash || '00'.repeat(32)
                },
                status: 'OK'
              }
            }) + '\n');
          } else if (req.method === 'keepalived') {
            socket.write(JSON.stringify({ id: req.id, jsonrpc: '2.0', result: { status: 'KEEPALIVED' } }) + '\n');
          } else if (req.method === 'submit') {
            socket.write(JSON.stringify({ id: req.id, jsonrpc: '2.0', result: { status: 'OK' } }) + '\n');
          }
        } catch {}
      }
    });
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => clients.delete(socket));
  });
  server.on('error', (err) => console.warn('[stratum-server] port busy:', err.message));
  server.listen(port, '0.0.0.0', () => console.log(`[stratum-server] Numista PPLNS Stratum listening on tcp://0.0.0.0:${port}`));
  return server;
}