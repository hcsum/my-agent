let WSImplPromise = null;

async function getWebSocketImpl() {
  if (WSImplPromise) return WSImplPromise;
  WSImplPromise = (async () => {
    if (typeof globalThis.WebSocket !== 'undefined') return globalThis.WebSocket;
    const ws = await import('ws');
    return ws.default;
  })();
  return WSImplPromise;
}

export class CdpRuntime {
  constructor(meta, options = {}) {
    this.meta = meta;
    this.options = options;
    this.ws = null;
    this.cmdId = 0;
    this.pending = new Map();
    this.sessions = new Map();
    this.portGuardedSessions = new Set();
    this.connectingPromise = null;
    this.shuttingDown = false;
    this.WS = null;
  }

  async connect() {
    if (this.ws && (this.ws.readyState === this.WS.OPEN || this.ws.readyState === 1)) return;
    if (this.connectingPromise) return this.connectingPromise;
    this.WS = this.WS || await getWebSocketImpl();

    this.connectingPromise = new Promise((resolve, reject) => {
      this.ws = new this.WS(this.meta.wsUrl);

      const onOpen = () => {
        cleanup();
        this.connectingPromise = null;
        resolve();
      };
      const onError = (event) => {
        cleanup();
        this.connectingPromise = null;
        this.ws = null;
        const msg = event?.message || event?.error?.message || '连接失败';
        reject(new Error(msg));
      };
      const onClose = () => {
        this.ws = null;
        this.sessions.clear();
        this.portGuardedSessions.clear();
      };
      const onMessage = (evt) => {
        const data = typeof evt === 'string' ? evt : (evt.data || evt);
        const msg = JSON.parse(typeof data === 'string' ? data : data.toString());
        if (msg.method === 'Target.attachedToTarget') {
          const { sessionId, targetInfo } = msg.params;
          this.sessions.set(targetInfo.targetId, sessionId);
        }
        if (msg.method === 'Fetch.requestPaused') {
          const { requestId, sessionId } = msg.params;
          this.sendCDP('Fetch.failRequest', { requestId, errorReason: 'ConnectionRefused' }, sessionId).catch(() => {});
        }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: done, timer } = this.pending.get(msg.id);
          clearTimeout(timer);
          this.pending.delete(msg.id);
          done(msg);
        }
      };

      const cleanup = () => {
        this.ws?.removeEventListener?.('open', onOpen);
        this.ws?.removeEventListener?.('error', onError);
      };

      if (this.ws.on) {
        this.ws.on('open', onOpen);
        this.ws.on('error', onError);
        this.ws.on('close', onClose);
        this.ws.on('message', onMessage);
      } else {
        this.ws.addEventListener('open', onOpen);
        this.ws.addEventListener('error', onError);
        this.ws.addEventListener('close', onClose);
        this.ws.addEventListener('message', onMessage);
      }
    });

    return this.connectingPromise;
  }

  async shutdown() {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    try { this.ws?.close?.(); } catch {}
    return { released: false, skipped: true, provider: 'local' };
  }

  async health() {
    return {
      provider: this.meta.provider,
      browserMode: this.meta.browserMode,
      connected: !!this.ws && (this.ws.readyState === this.WS?.OPEN || this.ws.readyState === 1),
      sessions: this.sessions.size,
      chromePort: this.meta.port,
      browserbaseSessionId: null,
      browserbaseDebugUrl: null,
    };
  }

  async sendCDP(method, params = {}, sessionId = null) {
    await this.connect();
    return new Promise((resolve, reject) => {
      if (!this.ws || (this.ws.readyState !== this.WS.OPEN && this.ws.readyState !== 1)) {
        return reject(new Error('WebSocket 未连接'));
      }
      const id = ++this.cmdId;
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 命令超时: ${method}`));
      }, 30000);
      this.pending.set(id, { resolve, timer });
      this.ws.send(JSON.stringify(msg));
    });
  }

  async ensureSession(targetId) {
    if (this.sessions.has(targetId)) return this.sessions.get(targetId);
    const resp = await this.sendCDP('Target.attachToTarget', { targetId, flatten: true });
    if (!resp.result?.sessionId) {
      throw new Error('attach 失败: ' + JSON.stringify(resp.error));
    }
    const sessionId = resp.result.sessionId;
    this.sessions.set(targetId, sessionId);
    await this.enablePortGuard(sessionId);
    return sessionId;
  }

  async enablePortGuard(sessionId) {
    if (!this.meta.port || this.portGuardedSessions.has(sessionId)) return;
    try {
      await this.sendCDP('Fetch.enable', {
        patterns: [
          { urlPattern: `http://127.0.0.1:${this.meta.port}/*`, requestStage: 'Request' },
          { urlPattern: `http://localhost:${this.meta.port}/*`, requestStage: 'Request' },
        ],
      }, sessionId);
      this.portGuardedSessions.add(sessionId);
    } catch {}
  }

  async waitForLoad(sessionId, timeoutMs = 15000) {
    await this.sendCDP('Page.enable', {}, sessionId);
    return new Promise((resolve) => {
      let resolved = false;
      const done = (value) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        clearInterval(interval);
        resolve(value);
      };
      const timer = setTimeout(() => done('timeout'), timeoutMs);
      const interval = setInterval(async () => {
        try {
          const resp = await this.sendCDP('Runtime.evaluate', {
            expression: 'document.readyState',
            returnByValue: true,
          }, sessionId);
          if (resp.result?.result?.value === 'complete') done('complete');
        } catch {}
      }, 500);
    });
  }

  async listTargets() {
    const resp = await this.sendCDP('Target.getTargets');
    return resp.result.targetInfos.filter((t) => t.type === 'page');
  }

  async createTarget({ url = 'about:blank', background = true } = {}) {
    const resp = await this.sendCDP('Target.createTarget', { url, background });
    const targetId = resp.result.targetId;
    if (url !== 'about:blank') {
      try {
        const sid = await this.ensureSession(targetId);
        await this.waitForLoad(sid);
        if (!background) await this.sendCDP('Target.activateTarget', { targetId });
      } catch {}
    }
    return { targetId };
  }

  async closeTarget(targetId) {
    await this.sendCDP('Target.closeTarget', { targetId });
    this.sessions.delete(targetId);
    return { success: true };
  }

  async navigate(targetId, url) {
    const sid = await this.ensureSession(targetId);
    const resp = await this.sendCDP('Page.navigate', { url }, sid);
    await this.waitForLoad(sid);
    return resp.result;
  }

  async activate(targetId) {
    const sid = await this.ensureSession(targetId);
    await this.sendCDP('Target.activateTarget', { targetId });
    await this.sendCDP('Page.bringToFront', {}, sid);
    return { ok: true };
  }

  async back(targetId) {
    const sid = await this.ensureSession(targetId);
    await this.sendCDP('Runtime.evaluate', { expression: 'history.back()' }, sid);
    await this.waitForLoad(sid);
    return { ok: true };
  }

  async evaluate(targetId, expression) {
    const sid = await this.ensureSession(targetId);
    const resp = await this.sendCDP('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }, sid);
    if (resp.result?.result?.value !== undefined) return { value: resp.result.result.value };
    if (resp.result?.exceptionDetails) {
      const error = new Error(resp.result.exceptionDetails.text);
      error.statusCode = 400;
      throw error;
    }
    return resp.result;
  }

  async click(targetId, selector) {
    const expr = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return { error: '未找到元素: ' + ${JSON.stringify(selector)} }; el.scrollIntoView({ block: 'center' }); el.click(); return { clicked: true, tag: el.tagName, text: (el.textContent || '').slice(0, 100) }; })()`;
    const result = await this.evaluate(targetId, expr);
    if (result.value?.error) {
      const error = new Error(result.value.error);
      error.statusCode = 400;
      throw error;
    }
    return result.value;
  }

  async clickAt(targetId, selector) {
    const sid = await this.ensureSession(targetId);
    const coord = await this.evaluate(targetId, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return { error: '未找到元素: ' + ${JSON.stringify(selector)} }; el.scrollIntoView({ block: 'center' }); const rect = el.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, tag: el.tagName, text: (el.textContent || '').slice(0, 100) }; })()`);
    if (!coord.value || coord.value.error) {
      const error = new Error(coord.value?.error || '未找到点击坐标');
      error.statusCode = 400;
      throw error;
    }
    await this.sendCDP('Input.dispatchMouseEvent', { type: 'mousePressed', x: coord.value.x, y: coord.value.y, button: 'left', clickCount: 1 }, sid);
    await this.sendCDP('Input.dispatchMouseEvent', { type: 'mouseReleased', x: coord.value.x, y: coord.value.y, button: 'left', clickCount: 1 }, sid);
    return { clicked: true, ...coord.value };
  }

  async setFiles(targetId, selector, files) {
    const sid = await this.ensureSession(targetId);
    await this.sendCDP('DOM.enable', {}, sid);
    const doc = await this.sendCDP('DOM.getDocument', {}, sid);
    const node = await this.sendCDP('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector }, sid);
    if (!node.result?.nodeId) {
      const error = new Error('未找到元素: ' + selector);
      error.statusCode = 400;
      throw error;
    }
    await this.sendCDP('DOM.setFileInputFiles', { nodeId: node.result.nodeId, files }, sid);
    return { success: true, files: files.length };
  }

  async scroll(targetId, { y = 3000, direction = 'down' } = {}) {
    let js;
    if (direction === 'top') js = 'window.scrollTo(0, 0); "scrolled to top"';
    else if (direction === 'bottom') js = 'window.scrollTo(0, document.body.scrollHeight); "scrolled to bottom"';
    else if (direction === 'up') js = `window.scrollBy(0, -${Math.abs(y)}); "scrolled up ${Math.abs(y)}px"`;
    else js = `window.scrollBy(0, ${Math.abs(y)}); "scrolled down ${Math.abs(y)}px"`;
    const result = await this.evaluate(targetId, js);
    await new Promise((resolve) => setTimeout(resolve, 800));
    return result;
  }

  async screenshot(targetId, { filePath = null, format = 'png' } = {}) {
    const sid = await this.ensureSession(targetId);
    const resp = await this.sendCDP('Page.captureScreenshot', { format, quality: format === 'jpeg' ? 80 : undefined }, sid);
    const buffer = Buffer.from(resp.result.data, 'base64');
    return { buffer, filePath };
  }

  async info(targetId) {
    const result = await this.evaluate(targetId, 'JSON.stringify({title: document.title, url: location.href, ready: document.readyState})');
    return result.value || '{}';
  }
}
