import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_CHROME = process.env.CHROME ?? "chromium";
// The declared minimum_chrome_version. Older browsers cannot run the package.
export const MINIMUM_MAJOR = 148;
const sessions = new Set();
const signalHandlers = new Map([
  ["SIGINT", () => interrupt(130)],
  ["SIGTERM", () => interrupt(143)],
]);

async function interrupt(code) {
  const deadline = setTimeout(() => process.exit(code), 5_000);
  await Promise.allSettled([...sessions].map(session => session.close()));
  clearTimeout(deadline);
  process.exit(code);
}

function track(session) {
  sessions.add(session);
  if (sessions.size === 1) {
    for (const [signal, handler] of signalHandlers) process.once(signal, handler);
  }
}

function untrack(session) {
  sessions.delete(session);
  if (sessions.size === 0) {
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  }
}

/**
 * A fresh, bounded headless Chrome controlled over --remote-debugging-pipe.
 * Extensions load through CDP Extensions.loadUnpacked, which requires the pipe
 * and --enable-unsafe-extension-debugging; Chrome 137 removed --load-extension
 * from branded builds. Functions passed to scripts cannot capture variables.
 */
export class ChromeDriver {
  #process;
  #closed = false;
  #closing;
  #lifetime;
  #exitHandler;
  #timeout;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Set();
  #buffer = Buffer.alloc(0);
  logs = "";

  static async start({
    chrome = DEFAULT_CHROME,
    timeoutMs = 20_000,
    startupTimeoutMs = 40_000,
    maxLifetimeMs = 300_000,
    expectedVersion = process.env.CHROME_VERSION,
    args = [],
  } = {}) {
    const driver = new ChromeDriver();
    driver.#timeout = timeoutMs;
    driver.profileRoot = await mkdtemp(join(tmpdir(), "tab-gantry-chrome-"));
    try {
      driver.#process = spawn(chrome, [
        "--headless", "--no-first-run", "--no-default-browser-check", "--disable-sync",
        "--disable-background-networking", "--disable-component-update", "--disable-default-apps",
        "--mute-audio", "--password-store=basic", "--window-size=1280,800",
        // Chromium and Chrome for Testing otherwise apply field-trial testing
        // configs that branded Chrome does not; test the default features.
        "--disable-field-trial-config",
        // Loopback stays reachable; every other destination fails fast.
        "--proxy-server=127.0.0.1:9",
        "--remote-debugging-pipe", "--enable-unsafe-extension-debugging",
        `--user-data-dir=${join(driver.profileRoot, "profile")}`, ...args, "about:blank",
      ], { detached: true, stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] });
      driver.#exitHandler = () => driver.#kill("SIGKILL");
      process.once("exit", driver.#exitHandler);
      track(driver);
      const capture = chunk => { driver.logs = (driver.logs + chunk).slice(-262_144); };
      driver.#process.stdout.on("data", capture);
      driver.#process.stderr.on("data", capture);
      driver.#process.stdio[4].on("data", chunk => driver.#receive(chunk));
      driver.#process.stdio[3].on("error", () => {});
      const exited = new Promise((_, reject) => driver.#process.once("exit", (code, signal) => {
        const error = new Error(`Chrome exited (${code ?? signal})\n${driver.logs}`);
        for (const { reject: fail } of driver.#pending.values()) fail(error);
        driver.#pending.clear();
        reject(error);
      }));
      exited.catch(() => {});
      driver.#process.once("error", error => { driver.logs += `\n${error}`; });
      driver.#lifetime = setTimeout(() => {
        driver.#kill("SIGKILL");
        driver.close().catch(() => {});
      }, maxLifetimeMs);
      driver.#lifetime.unref();
      const version = await Promise.race([driver.send("Browser.getVersion", {}, undefined, startupTimeoutMs), exited]);
      driver.version = version;
      const match = /\/(\d+)\.(\d+)\.(\d+)\.(\d+)$/u.exec(version.product);
      if (!match) throw new Error(`Unrecognized browser version ${version.product}`);
      driver.browserVersion = match.slice(1).join(".");
      if (Number(match[1]) < MINIMUM_MAJOR) {
        throw new Error(`Expected Chrome ${MINIMUM_MAJOR} or newer; got ${driver.browserVersion}`);
      }
      if (expectedVersion && driver.browserVersion !== expectedVersion) {
        throw new Error(`Expected Chrome ${expectedVersion}; got ${driver.browserVersion}`);
      }
      await driver.send("Target.setDiscoverTargets", { discover: true });
      return driver;
    } catch (error) {
      error.driverLog = driver.logs;
      await driver.close();
      throw error;
    }
  }

  #receive(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    for (let end; (end = this.#buffer.indexOf(0)) >= 0;) {
      const message = JSON.parse(this.#buffer.subarray(0, end).toString("utf8"));
      this.#buffer = this.#buffer.subarray(end + 1);
      if (message.id === undefined) {
        for (const listener of this.#listeners) listener(message);
        continue;
      }
      const entry = this.#pending.get(message.id);
      if (!entry) continue;
      this.#pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        entry.reject(Object.assign(new Error(`${entry.method}: ${message.error.message}`), { code: message.error.code, data: message.error.data }));
      } else entry.resolve(message.result);
    }
  }

  /** One CDP command; sessionId addresses an attached target. */
  send(method, params = {}, sessionId, timeoutMs = this.#timeout) {
    if (this.#closed) return Promise.reject(new Error("Chrome session is closed"));
    const id = this.#nextId++;
    const { promise, resolve, reject } = Promise.withResolvers();
    const timer = setTimeout(() => {
      this.#pending.delete(id);
      reject(new Error(`${method} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    this.#pending.set(id, { resolve, reject, method, timer });
    this.#process.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
    return promise;
  }

  /** Resolve with the first protocol event satisfying predicate. */
  waitFor(predicate, timeoutMs = this.#timeout) {
    const { promise, resolve, reject } = Promise.withResolvers();
    const listener = message => {
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error("Timed out waiting for a Chrome event")); }, timeoutMs);
    const cleanup = () => { clearTimeout(timer); this.#listeners.delete(listener); };
    this.#listeners.add(listener);
    return promise;
  }

  async loadExtension(path, { incognito = false } = {}) {
    return (await this.send("Extensions.loadUnpacked", { path, enableInIncognito: incognito })).id;
  }

  async #workerTarget(extensionId, timeoutMs = this.#timeout) {
    const deadline = Date.now() + timeoutMs;
    const url = `chrome-extension://${extensionId}/`;
    for (;;) {
      const { targetInfos } = await this.send("Target.getTargets");
      const target = targetInfos.find(info => info.type === "service_worker" && info.url.startsWith(url));
      if (target) return target;
      if (Date.now() > deadline) throw new Error(`Extension ${extensionId} has no running service worker`);
      await delay(50);
    }
  }

  /** Evaluate fn(...leading, ...args) as an awaited expression in a session. */
  async #run(sessionId, fn, leading, args) {
    if (typeof fn !== "function") throw new TypeError("A script must be a function");
    const result = await this.send("Runtime.evaluate", {
      expression: `(${fn.toString()})(${leading.map(name => `${name}, `).join("")}...${JSON.stringify(args)})`,
      awaitPromise: true, returnByValue: true, userGesture: true,
    }, sessionId);
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result.value;
  }

  /** Evaluate fn(...args) in an attached page, with transient user activation. */
  evaluate(sessionId, fn, ...args) {
    return this.#run(sessionId, fn, [], args);
  }

  /**
   * Run fn(browser, ...args) in the extension's service worker. Waking an idle
   * worker needs an extension event; tests stop it only to exercise wake-up.
   */
  async extension(extensionId, fn, ...args) {
    const target = await this.#workerTarget(extensionId);
    const { sessionId } = await this.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    try {
      // A restarting worker's target can appear before its extension bindings.
      const deadline = Date.now() + this.#timeout;
      while (!await this.#run(sessionId, () => typeof browser === "object" && typeof browser.runtime?.id === "string", [], [])) {
        if (Date.now() > deadline) throw new Error(`Extension ${extensionId} bindings did not initialize`);
        await delay(25);
      }
      return await this.#run(sessionId, fn, ["browser"], args);
    } finally {
      await this.send("Target.detachFromTarget", { sessionId }).catch(() => {});
    }
  }

  /** Terminate the extension's service worker, as Chrome does after idling. */
  async stopWorker(extensionId) {
    const target = await this.#workerTarget(extensionId);
    const gone = this.waitFor(message => message.method === "Target.targetDestroyed" && message.params.targetId === target.targetId);
    await this.send("Target.closeTarget", { targetId: target.targetId });
    await gone;
  }

  async hasWorker(extensionId) {
    const { targetInfos } = await this.send("Target.getTargets");
    return targetInfos.some(info => info.type === "service_worker" && info.url.startsWith(`chrome-extension://${extensionId}/`));
  }

  /** Open a page target and attach to it. */
  async page(url, { background = false, newWindow = false } = {}) {
    const { targetId } = await this.send("Target.createTarget", { url, background, newWindow });
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    await this.send("Page.enable", {}, sessionId);
    return { targetId, sessionId };
  }

  #kill(signal) {
    if (!this.#process?.pid) return;
    try {
      process.kill(-this.#process.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }

  close() {
    if (this.#closing) return this.#closing;
    this.#closing = (async () => {
      clearTimeout(this.#lifetime);
      try {
        if (this.#process?.exitCode === null && !this.#closed) {
          await this.send("Browser.close", {}, undefined, 3_000).catch(() => {});
        }
      } finally {
        this.#closed = true;
        this.#kill("SIGTERM");
        if (this.#process && this.#process.exitCode === null && this.#process.signalCode === null) {
          await Promise.race([new Promise(resolveExit => this.#process.once("exit", resolveExit)), delay(1_000)]);
        }
        this.#kill("SIGKILL");
        for (const { reject, timer } of this.#pending.values()) {
          clearTimeout(timer);
          reject(new Error("Chrome session is closed"));
        }
        this.#pending.clear();
        if (this.#exitHandler) process.off("exit", this.#exitHandler);
        untrack(this);
        if (this.profileRoot) await rm(this.profileRoot, { recursive: true, force: true });
      }
    })();
    return this.#closing;
  }

  async [Symbol.asyncDispose]() {
    await this.close();
  }
}
