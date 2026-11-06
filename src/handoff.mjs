import { WebSocketServer } from 'ws';
import { timingSafeEqual } from 'node:crypto';
import { Lane } from './actions.mjs';

export class HandoffBroker {
  constructor({ assertRunning = () => {} } = {}) {
    this.assertRunning = assertRunning;
    this.lane = new Lane();
    this.pending = new Map();
    this.nextID = 1;
    this.cachedTabs = [];
  }
  attach(server, token) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
    server.on('upgrade', (req, socket, head) => {
      if (req.url !== '/extension') return;
      const received = Buffer.from(req.headers['sec-websocket-protocol'] ?? '');
      const expected = Buffer.from('ic-' + token);
      let origin;
      try { origin = new URL(req.headers.origin); } catch {}
      if (req.url !== '/extension' || !['chrome-extension:', 'moz-extension:', 'safari-web-extension:'].includes(origin?.protocol) ||
          req.headers.host !== `127.0.0.1:${server.address().port}` || received.length !== expected.length || !timingSafeEqual(received, expected)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return;
      }
      this.wss.handleUpgrade(req, socket, head, ws => {
        this.socket?.close();
        this.socket = ws;
        ws.on('message', raw => {
          try {
            const message = JSON.parse(raw);
            if (message.event === 'tabs') { this.cachedTabs = message.tabs; return; }
            if (message.event === 'ping') { ws.send(JSON.stringify({ event: 'pong' })); return; }
            const pending = this.pending.get(message.id);
            if (!pending) return;
            clearTimeout(pending.timer); this.pending.delete(message.id);
            if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.result);
          } catch { ws.close(1008, 'Invalid message'); }
        });
        ws.on('close', () => {
          if (this.socket === ws) {
            this.socket = null; this.cachedTabs = [];
            for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Browser extension disconnected; handoff is paused')); }
            this.pending.clear();
          }
        });
      });
    });
  }
  request(op, args = {}) {
    if (!this.socket || this.socket.readyState !== 1) return Promise.reject(new Error('Handoff extension not connected; pair it with extensionURL from computer_status'));
    const id = this.nextID++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Handoff command timed out; observe before retrying')); }, 120000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, op, args }));
    });
  }
  tabs() { return this.request('list'); }
  observe(args) { return this.lane.run(() => this.request('observe', args)); }
  act(args) { return this.lane.run(() => { this.assertRunning(); return this.request('act', args); }); }
  controls(args) { return this.lane.run(() => { this.assertRunning(); return this.request('controls', args); }); }
  requestUser(args) { return this.request('requestUser', args); }
  async close() { this.socket?.close(); this.wss?.close(); }
}
