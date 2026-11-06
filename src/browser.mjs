import { chromium } from 'playwright';
import { performance } from 'node:perf_hooks';
import { Lane, checkCoordinates, allowedURL } from './actions.mjs';
import { accessibilitySnapshot, accessibilityAction } from '../extension/accessibility.js';

export class BrowserEngine {
  constructor({ executablePath = process.env.IC_BROWSER_EXECUTABLE, assertRunning = () => {} } = {}) {
    this.executablePath = executablePath;
    this.assertRunning = assertRunning;
    this.lane = new Lane();
    this.pages = new Map();
    this.nextID = 1;
    this.frames = new Map();
    this.dialogs = [];
    this.accessibility = new Map();
  }

  async ensure() {
    if (this.browser?.isConnected()) return;
    this.pages.clear();
    this.frames.clear();
    this.browser = await chromium.launch({ headless: true, executablePath: this.executablePath, chromiumSandbox: true });
    this.context = await this.browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, acceptDownloads: false });
    this.context.setDefaultTimeout(10000);
    this.context.on('page', page => this.register(page));
  }

  register(page) {
    if ([...this.pages.values()].includes(page)) return;
    const id = `tab-${this.nextID++}`;
    this.pages.set(id, page);
    this.activeID = id;
    page.on('dialog', async dialog => {
      this.dialogs.push({ tab: id, type: dialog.type(), message: dialog.message(), dismissed: true });
      this.dialogs = this.dialogs.slice(-10);
      await dialog.dismiss().catch(() => {});
    });
    page.on('close', () => {
      this.pages.delete(id);
      this.frames.delete(id);
      this.accessibility.delete(id);
      if (this.activeID === id) this.activeID = [...this.pages.keys()].at(-1);
    });
  }

  page(id = this.activeID) {
    const page = this.pages.get(id);
    if (!page || page.isClosed()) throw new Error('Unknown or closed tab; use browser_open or browser_tabs');
    return { page, id };
  }

  async snapshot(page, id, format) {
    const size = page.viewportSize();
    const result = { target: 'browser', tab: id, url: page.url(), ...size, dialogs: this.dialogs };
    const ax=await this.ax(page,id);
    Object.assign(result,await accessibilitySnapshot((method,params)=>ax.session.send(method,params),ax));
    if (format !== 'none') {
      const data = await page.screenshot({ type: format, ...(format === 'jpeg' ? { quality: 85 } : {}), timeout: 10000 });
      result.image = { data: data.toString('base64'), mimeType: `image/${format}` };
      this.frames.set(id, { ...result.image, timestamp: Date.now() });
    }
    return result;
  }

  async ax(page,id) {
    if(!this.accessibility.has(id))this.accessibility.set(id,{session:await this.context.newCDPSession(page)});
    return this.accessibility.get(id);
  }

  controls({tab,actions,capture='none'}) {
    return this.lane.run(async()=>{
      this.assertRunning();
      const {page,id}=this.page(tab),ax=await this.ax(page,id);
      for(const action of actions){
        this.assertRunning();
        const result=await accessibilityAction((method,params)=>ax.session.send(method,params),ax,action);
        if(result?.needsConfirmation)throw new Error('Conventional submit control requires human confirmation');
      }
      return this.snapshot(page,id,capture);
    });
  }

  open({ url, width = 1280, height = 800, capture = 'none' }) {
    url = allowedURL(url);
    return this.lane.run(async () => {
      this.assertRunning();
      await this.ensure();
      const page = await this.context.newPage();
      const id = [...this.pages].find(([, p]) => p === page)[0];
      await page.setViewportSize({ width, height });
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      return this.snapshot(page, id, capture);
    });
  }

  act({ tab, actions, capture = 'none' }) {
    return this.lane.run(async () => {
      this.assertRunning();
      const { page, id } = this.page(tab);
      checkCoordinates(actions, page.viewportSize());
      const started = performance.now();
      for (const action of actions) {
        this.assertRunning();
        switch (action.type) {
          case 'click': await page.mouse.click(action.x, action.y, { button: action.button, clickCount: action.clicks }); break;
          case 'move': await page.mouse.move(action.x, action.y); break;
          case 'scroll':
            await page.mouse.move(action.x, action.y);
            await page.mouse.wheel(action.deltaX, action.deltaY);
            break;
          case 'type': await page.keyboard.insertText(action.text); break;
          case 'key': await page.keyboard.press(action.keys.join('+')); break;
          case 'wait': await new Promise(r => setTimeout(r, action.ms)); break;
          case 'drag':
            await page.mouse.move(action.path[0].x, action.path[0].y);
            await page.mouse.down({ button: action.button });
            try {
              for (const point of action.path.slice(1)) await page.mouse.move(point.x, point.y);
            } finally { await page.mouse.up({ button: action.button }); }
            break;
        }
      }
      const actionMs = performance.now() - started;
      const result = await this.snapshot(page, id, capture);
      return { ...result, actionsCompleted: actions.length, actionMs, totalMs: performance.now() - started };
    });
  }

  observe({ tab, capture = 'none' } = {}) {
    return this.lane.run(async () => {
      const { page, id } = this.page(tab);
      return this.snapshot(page, id, capture);
    });
  }

  tabs() { return [...this.pages].map(([id, page]) => ({ tab: id, url: page.url(), active: id === this.activeID })); }

  closeTab(tab) { return this.lane.run(async () => { await this.page(tab).page.close(); return { tabs: this.tabs() }; }); }

  close() { return this.lane.run(async () => { await this.context?.close(); await this.browser?.close(); }); }
}
