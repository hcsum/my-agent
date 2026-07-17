import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

async function checkPort(port, host = '127.0.0.1', timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = net.createConnection(port, host);
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, timeoutMs);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once('error', () => { clearTimeout(timer); resolve(false); });
  });
}

function activePortFiles(browserMode, dedicatedProfileDir) {
  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA || '';
  switch (os.platform()) {
    case 'darwin':
      return browserMode === 'primary'
        ? [
            path.join(home, 'Library/Application Support/Google/Chrome/DevToolsActivePort'),
            path.join(home, 'Library/Application Support/Google/Chrome Canary/DevToolsActivePort'),
            path.join(home, 'Library/Application Support/Chromium/DevToolsActivePort'),
            path.join(home, 'Library/Application Support/BraveSoftware/Brave-Browser/DevToolsActivePort'),
            path.join(home, 'Library/Application Support/Microsoft Edge/DevToolsActivePort'),
            path.join(home, 'Library/Application Support/Arc/User Data/DevToolsActivePort'),
          ]
        : [path.join(dedicatedProfileDir, 'DevToolsActivePort')];
    case 'linux':
      return browserMode === 'primary'
        ? [
            path.join(home, '.config/google-chrome/DevToolsActivePort'),
            path.join(home, '.config/chromium/DevToolsActivePort'),
            path.join(home, '.config/BraveSoftware/Brave-Browser/DevToolsActivePort'),
            path.join(home, '.config/microsoft-edge/DevToolsActivePort'),
          ]
        : [path.join(dedicatedProfileDir, 'DevToolsActivePort')];
    case 'win32':
      return browserMode === 'primary'
        ? [
            path.join(localAppData, 'Google/Chrome/User Data/DevToolsActivePort'),
            path.join(localAppData, 'Chromium/User Data/DevToolsActivePort'),
            path.join(localAppData, 'BraveSoftware/Brave-Browser/User Data/DevToolsActivePort'),
            path.join(localAppData, 'Microsoft/Edge/User Data/DevToolsActivePort'),
          ]
        : [path.join(dedicatedProfileDir, 'DevToolsActivePort')];
    default:
      return [];
  }
}

async function fetchWsPath(port, fallbackWsPath) {
  // Verify the port actually serves CDP. A modern Chrome launched on the
  // default user-data-dir binds the DevTools port but rejects the /json
  // endpoints (404), so an open TCP port alone is not proof of usability.
  // Only treat the browser as usable when /json/version returns a real
  // webSocketDebuggerUrl; otherwise report it as unverified so the caller
  // skips it (and auto mode falls back to a working browser) instead of
  // fabricating a ws URL that will hang on connect.
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      const json = JSON.parse(await res.text());
      if (json?.webSocketDebuggerUrl) {
        return { verified: true, wsPath: new URL(json.webSocketDebuggerUrl).pathname || fallbackWsPath };
      }
    }
  } catch {}
  return { verified: false, wsPath: fallbackWsPath };
}

export async function resolveLocalBrowser(config) {
  if (config.browserMode === 'dedicated' && !config.dedicatedProfileDir) {
    return null;
  }
  const candidateFiles = activePortFiles(config.browserMode, config.dedicatedProfileDir);
  for (const filePath of candidateFiles) {
    try {
      const lines = fs.readFileSync(filePath, 'utf8').trim().split(/\r?\n/).filter(Boolean);
      const port = parseInt(lines[0], 10);
      if (!(port > 0 && port < 65536)) continue;
      if (!(await checkPort(port))) continue;
      const { verified, wsPath } = await fetchWsPath(port, lines[1] || null);
      // Prefer a /json/version-verified endpoint, but fall back to the ws path
      // from DevToolsActivePort (line 2) when present. A Chrome whose remote
      // debugging was enabled via the chrome://inspect checkbox binds the port
      // and serves a live browser websocket, yet blocks the /json endpoints —
      // the DevToolsActivePort ws path is the only usable handle in that mode.
      if (!verified && !wsPath) continue;
      return {
        provider: 'local',
        browserMode: config.browserMode,
        browserId: config.browserId || null,
        dedicatedProfileDir: config.dedicatedProfileDir || null,
        port,
        wsUrl: wsPath ? `ws://127.0.0.1:${port}${wsPath}` : `ws://127.0.0.1:${port}/devtools/browser`,
      };
    } catch {}
  }

  return null;
}
