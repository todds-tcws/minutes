// Stubs window.__TAURI__ for tests that load a Tauri frontend page directly
// against file://, per spec section 5(b) accepted evidence. Installed via
// page.addInitScript so it exists before the page's own <script> runs.
//
// Node-side control is via window.__testState, mutated through page.evaluate
// by the helpers below — nothing here crosses the Node/browser boundary as a
// function, only JSON-serializable data, so it works the same whether the
// page later runs under a real or a Playwright-faked clock.

function stubInPage() {
  const state = {
    queues: {},   // cmd -> [{ type: 'resolve'|'reject', value?, error? }, ...] (FIFO)
    defaults: {}, // cmd -> value returned once its queue is empty
    calls: {},    // cmd -> call count
    callLog: [],  // [{ cmd, args, t }]
    listeners: {}, // event name -> [callback]
  };
  window.__testState = state;

  function invoke(cmd, args) {
    state.calls[cmd] = (state.calls[cmd] || 0) + 1;
    state.callLog.push({ cmd, args, t: Date.now() });
    const q = state.queues[cmd];
    if (q && q.length) {
      const next = q.shift();
      if (next.type === 'reject') return Promise.reject(new Error(next.error || `stub reject: ${cmd}`));
      return Promise.resolve(next.value);
    }
    if (Object.prototype.hasOwnProperty.call(state.defaults, cmd)) {
      return Promise.resolve(state.defaults[cmd]);
    }
    return Promise.resolve({});
  }

  function listen(name, cb) {
    (state.listeners[name] = state.listeners[name] || []).push(cb);
    return Promise.resolve(() => {
      const list = state.listeners[name] || [];
      const i = list.indexOf(cb);
      if (i !== -1) list.splice(i, 1);
    });
  }

  window.__testEmit = (name, payload) => {
    (state.listeners[name] || []).forEach((cb) => cb({ event: name, payload }));
  };

  window.__TAURI__ = {
    core: { invoke },
    event: { listen },
    window: {
      getCurrentWindow: () => ({
        startDragging: () => Promise.resolve(),
        setSize: () => Promise.resolve(),
        innerSize: () => Promise.resolve({ width: 460, height: 520 }),
        close: () => Promise.resolve(),
        onCloseRequested: () => Promise.resolve(() => {}),
        onResized: () => Promise.resolve(() => {}),
        isFullscreen: () => Promise.resolve(false),
        listen,
      }),
    },
    app: {
      getName: () => Promise.resolve('Minutes'),
      getVersion: () => Promise.resolve('0.0.0-test'),
    },
    shell: { open: () => Promise.resolve() },
    dialog: {
      open: () => Promise.resolve(null),
      ask: () => Promise.resolve(false),
      confirm: () => Promise.resolve(false),
      message: () => Promise.resolve(),
    },
  };
}

export async function installTauriStub(page) {
  await page.addInitScript(stubInPage);
}

/** Queue a sequence of responses for one command; consumed FIFO, one per invoke call. */
export async function queueInvoke(page, cmd, entries) {
  await page.evaluate(([c, e]) => {
    window.__testState.queues[c] = e;
  }, [cmd, entries]);
}

/** Set (or replace) the steady-state response returned once a command's queue is empty. */
export async function setDefault(page, cmd, value) {
  await page.evaluate(([c, v]) => {
    window.__testState.defaults[c] = v;
  }, [cmd, value]);
}

export async function callCount(page, cmd) {
  return page.evaluate((c) => window.__testState.calls[c] || 0, cmd);
}

export async function callLog(page, cmd) {
  return page.evaluate((c) => window.__testState.callLog.filter((entry) => entry.cmd === c), cmd);
}

export function resolve(value) {
  return { type: 'resolve', value };
}

export function reject(error) {
  return { type: 'reject', error };
}
