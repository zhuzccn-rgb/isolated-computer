import { readFileSync } from 'node:fs';
import { Lane } from './actions.mjs';
import { assertIsolation } from './identity.mjs';

export class DesktopEngine {
  constructor({ url = process.env.IC_DESKTOP_URL, tokenFile = process.env.IC_DESKTOP_TOKEN_FILE, assertRunning = () => {} } = {}) {
    this.url = url;
    this.tokenFile = tokenFile;
    this.assertRunning = assertRunning;
    this.lane = new Lane();
    this.humanLane = new Lane();
    this.owner = 'ai';
  }
  async request(path, body) {
    if (!this.url || !this.tokenFile) throw new Error('Desktop disabled: configure IC_DESKTOP_URL and IC_DESKTOP_TOKEN_FILE');
    const url = new URL(this.url);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('Use HTTPS or an SSH tunnel to a loopback desktop bridge');
    if (url.username || url.password || url.search || url.hash) throw new Error('Desktop URL must not contain credentials, query or fragment');
    url.pathname = path;
    const token = readFileSync(this.tokenFile, 'utf8').trim();
    if (token.length < 32) throw new Error('Desktop token must contain at least 32 characters');
    const response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(120000), redirect: 'error'
    });
    if (!response.ok) {const failure=await response.json().catch(()=>({}));throw new Error(`Desktop bridge returned HTTP ${response.status}: ${failure.error??'Request failed'}`);}
    return response.json();
  }
  async verify() {
    const info = await this.request('/health');
    assertIsolation(info);
    return info;
  }
  assertAI() {
    this.assertRunning();
    if (this.owner !== 'ai') throw new Error('Desktop input is paused or owned by the human; wait for explicit hand-back');
  }
  async setPaused(paused) {
    if (!paused && ['human','acquiring'].includes(this.owner)) throw new Error('Hand the desktop back before resuming AI');
    await this.verify();
    await this.request('/control', { paused });
    if (this.owner !== 'human') this.owner = paused ? 'paused' : 'ai';
  }
  async takeOver(client) {
    if (['human','acquiring'].includes(this.owner)) throw new Error('Another window already owns the desktop');
    this.owner = 'acquiring'; this.humanClient = client;
    try {
      const info=await this.verify();
      await this.request('/control', { paused:true });
      await this.lane.drain();
      const result = await this.request('/human', {op:'acquire'});
      this.humanLease = result.lease; this.humanSequence = 0;
      this.humanDimensions = {width:result.width,height:result.height};
      this.owner = 'human';
      const {lease,...metadata} = result; return {owner:this.owner,platform:info.platform,...metadata};
    } catch (error) {
      this.owner = 'paused'; this.humanClient = null; throw error;
    }
  }
  humanCommand(client, operation, extra = {}) {
    return this.humanLane.run(async()=>{
      if (this.owner !== 'human' || this.humanClient !== client || !this.humanLease) throw new Error('This window does not own desktop input');
      const payload={...extra};if(operation==='input')payload.sequence=++this.humanSequence;
      try { return await this.request('/human',{op:operation,lease:this.humanLease,...payload}); }
      catch(error) {
        // The bridge watchdog is authoritative; an uncertain lease never
        // enables AI automatically. Explicit resume/takeover is required.
        await this.request('/human',{op:'release',lease:this.humanLease,resume:false}).catch(()=>{});
        this.owner='paused';this.humanLease=null;this.humanClient=null;throw error;
      }
    });
  }
  humanInput(client, events) {
    return this.humanCommand(client,'input',{dimensions:this.humanDimensions,events});
  }
  async releaseHuman(client, resume = false) {
    if (this.humanClient !== client) return {owner:this.owner,released:false};
    await this.humanCommand(client,'release',{resume});
    this.owner=resume?'ai':'paused';this.humanLease=null;this.humanClient=null;
    return {owner:this.owner,released:true};
  }
  async preview() {
    await this.verify();
    return this.request('/preview',{});
  }
  act(args) {
    return this.lane.run(async () => {
      this.assertAI();
      await this.verify();
      this.assertAI();
      const result = await this.request('/act', args);
      if (result.error) throw new Error(result.error);
      this.frame = result.image ? { ...result.image, timestamp: Date.now() } : this.frame;
      return result;
    });
  }
  controls(args) {
    return this.lane.run(async()=>{
      this.assertAI();await this.verify();this.assertAI();
      const result=await this.request('/controls',args);if(result.error)throw new Error(result.error);
      this.frame=result.image?{...result.image,timestamp:Date.now()}:this.frame;return result;
    });
  }
  observe({ capture = 'none' } = {}) {
    return this.lane.run(async () => {
      await this.verify();
      const result = await this.request('/observe', { capture });
      if (result.error) throw new Error(result.error);
      this.frame = result.image ? { ...result.image, timestamp: Date.now() } : this.frame;
      return result;
    });
  }
}
