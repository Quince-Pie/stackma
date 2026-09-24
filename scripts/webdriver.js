import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_DRIVER = process.env.GECKODRIVER ?? "geckodriver";
const DEFAULT_FIREFOX = process.env.FIREFOX ?? "/run/current-system/sw/bin/firefox";
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

/** A fresh, bounded Firefox session. Functions passed to scripts cannot capture variables. */
export class FirefoxDriver {
  #process;
  #closed = false;
  #closing;
  #lifetime;
  #exitHandler;
  #commands = Promise.resolve();
  #timeout;
  logs = "";

  static async start({
    geckodriver = DEFAULT_DRIVER,
    firefox = DEFAULT_FIREFOX,
    timeoutMs = 20_000,
    startupTimeoutMs = 40_000,
    maxLifetimeMs = 300_000,
    expectedMajor = 156,
    prefs = {},
  } = {}) {
    const driver = new FirefoxDriver();
    driver.#timeout = timeoutMs;
    driver.profileRoot = await mkdtemp(join(tmpdir(), "stackma-firefox-"));
    try {
      const ready = Promise.withResolvers();
      driver.#process = spawn(geckodriver, [
        "--allow-system-access", "--host", "127.0.0.1", "--port", "0",
        "--profile-root", driver.profileRoot, "--log", "info",
      ], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
      driver.#exitHandler = () => driver.#kill("SIGKILL");
      process.once("exit", driver.#exitHandler);
      track(driver);
      const capture = chunk => {
        driver.logs = (driver.logs + chunk).slice(-262_144);
        const match = /Listening on (127\.0\.0\.1:\d+)/.exec(driver.logs);
        if (match) ready.resolve(`http://${match[1]}`);
      };
      driver.#process.stdout.on("data", capture);
      driver.#process.stderr.on("data", capture);
      driver.#process.once("error", ready.reject);
      driver.#process.once("exit", (code, signal) => {
        ready.reject(new Error(`geckodriver exited (${code ?? signal})\n${driver.logs}`));
      });
      const deadline = AbortSignal.timeout(startupTimeoutMs);
      driver.origin = await Promise.race([
        ready.promise,
        new Promise((_, reject) => deadline.addEventListener("abort", () =>
          reject(new Error(`geckodriver startup timed out\n${driver.logs}`)), { once: true })),
      ]);
      driver.#lifetime = setTimeout(() => {
        driver.#kill("SIGKILL");
        driver.close().catch(() => {});
      }, maxLifetimeMs);
      driver.#lifetime.unref();
      const session = await driver.#request("POST", "/session", {
        capabilities: {
          alwaysMatch: {
            browserName: "firefox",
            "moz:firefoxOptions": {
              binary: firefox,
              args: ["-headless"],
              prefs: {
                "browser.startup.page": 0,
                "browser.startup.homepage": "about:blank",
                "browser.startup.homepage_override.mstone": "ignore",
                "startup.homepage_welcome_url": "",
                "startup.homepage_welcome_url.additional": "",
                "browser.shell.checkDefaultBrowser": false,
                "browser.sessionstore.resume_from_crash": false,
                "browser.tabs.warnOnClose": false,
                "browser.tabs.warnOnCloseOtherTabs": false,
                "browser.warnOnQuitShortcut": false,
                "network.proxy.type": 1,
                "network.proxy.http": "127.0.0.1",
                "network.proxy.http_port": 9,
                "network.proxy.ssl": "127.0.0.1",
                "network.proxy.ssl_port": 9,
                "network.proxy.no_proxies_on": "localhost, 127.0.0.1",
                ...prefs,
              },
            },
          },
        },
      }, startupTimeoutMs);
      driver.sessionId = session.sessionId;
      driver.capabilities = session.capabilities;
      if (Number.parseInt(driver.capabilities.browserVersion, 10) !== expectedMajor) {
        throw new Error(`Expected Firefox ${expectedMajor}; got ${driver.capabilities.browserVersion}`);
      }
      await driver.command("POST", "/timeouts", {
        script: timeoutMs - 1_000, pageLoad: timeoutMs - 1_000, implicit: 0,
      });
      return driver;
    } catch (error) {
      error.driverLog = driver.logs;
      await driver.close();
      throw error;
    }
  }

  async #request(method, path, body, timeoutMs = this.#timeout) {
    const response = await fetch(this.origin + path, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await response.json();
    if (!response.ok || payload.value?.error) {
      const error = new Error(`${method} ${path}: ${payload.value?.message ?? response.statusText}`);
      error.code = payload.value?.error;
      error.remoteStack = payload.value?.stacktrace;
      throw error;
    }
    return payload.value;
  }

  #serialize(operation) {
    if (this.#closed) return Promise.reject(new Error("Firefox session is closed"));
    const result = this.#commands.then(() => {
      if (this.#closed) throw new Error("Firefox session is closed");
      return operation();
    });
    this.#commands = result.catch(() => {});
    return result;
  }

  command(method, path, body) {
    return this.#serialize(() =>
      this.#request(method, `/session/${this.sessionId}${path}`, body));
  }

  async installAddon(path, { allowPrivateBrowsing = true, temporary = true } = {}) {
    return this.command("POST", "/moz/addon/install", {
      path: resolve(path), temporary, allowPrivateBrowsing,
    });
  }

  uninstallAddon(id) {
    return this.command("POST", "/moz/addon/uninstall", { id });
  }

  #execute(context, fn, args) {
    if (typeof fn !== "function") throw new TypeError("A script must be a function");
    return this.#serialize(async () => {
      await this.#request("POST", `/session/${this.sessionId}/moz/context`, { context });
      return this.#request("POST", `/session/${this.sessionId}/execute/sync`, {
        script: `return (${fn.toString()})(...arguments);`, args,
      });
    });
  }

  chrome(fn, ...args) {
    return this.#execute("chrome", fn, args);
  }

  content(fn, ...args) {
    return this.#execute("content", fn, args);
  }

  addon(id, fn, ...args) {
    if (typeof fn !== "function") throw new TypeError("An addon script must be a function");
    return this.chrome(async (addonId, source, parameters, timeout) => {
      const { ExtensionParent } = ChromeUtils.importESModule(
        "resource://gre/modules/ExtensionParent.sys.mjs");
      const extension = ExtensionParent.GlobalManager.getExtension(addonId);
      if (!extension) throw new Error(`Extension ${addonId} is not running`);
      await extension.wakeupBackground();
      const context = extension.backgroundContext;
      if (!context?.browsingContext?.currentWindowGlobal) {
        throw new Error(`Extension ${addonId} has no event-page context`);
      }
      // Execute in the real extension process; the parent's cloneScope is only an API proxy sandbox.
      const actor = context.browsingContext.currentWindowGlobal.getActor("MarionetteCommands");
      return actor.executeScript(`return (${source})(browser, ...arguments);`, parameters, {
        timeout, async: false, sandboxName: null, newSandbox: true,
        file: "stackma-browser-test", line: 1,
      });
    }, id, fn.toString(), args, this.#timeout - 2_000);
  }

  tab(tabId, fn, ...args) {
    if (typeof fn !== "function") throw new TypeError("A tab script must be a function");
    return this.chrome(async (id, source, parameters, timeout) => {
      const { ExtensionParent } = ChromeUtils.importESModule(
        "resource://gre/modules/ExtensionParent.sys.mjs");
      const tab = ExtensionParent.apiManager.global.tabTracker.getTab(id);
      const actor = tab.linkedBrowser.browsingContext.currentWindowGlobal.getActor("MarionetteCommands");
      return actor.executeScript(`return (${source})(...arguments);`, parameters, {
        timeout, async: false, sandboxName: null, newSandbox: true,
        file: "stackma-content-test", line: 1,
      });
    }, tabId, fn.toString(), args, this.#timeout - 2_000);
  }

  suspendAddon(id) {
    return this.chrome(async addonId => {
      const { ExtensionParent } = ChromeUtils.importESModule(
        "resource://gre/modules/ExtensionParent.sys.mjs");
      const extension = ExtensionParent.GlobalManager.getExtension(addonId);
      if (!extension) throw new Error(`Extension ${addonId} is not running`);
      await extension.terminateBackground({
        ignoreDevToolsAttached: true, disableResetIdleForTest: true,
      });
      return extension.backgroundState;
    }, id);
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
    this.#closed = true;
    this.#closing = (async () => {
      clearTimeout(this.#lifetime);
      try {
        if (this.sessionId && this.#process?.exitCode === null) {
          await this.#request("DELETE", `/session/${this.sessionId}`, undefined, 3_000).catch(() => {});
        }
      } finally {
        this.#kill("SIGTERM");
        if (this.#process?.exitCode === null && this.#process?.signalCode === null) {
          await Promise.race([
            new Promise(resolveExit => this.#process.once("exit", resolveExit)),
            delay(1_000),
          ]);
        }
        this.#kill("SIGKILL");
        if (this.#exitHandler) process.off("exit", this.#exitHandler);
        untrack(this);
        await rm(this.profileRoot, { recursive: true, force: true });
      }
    })();
    return this.#closing;
  }

  async [Symbol.asyncDispose]() {
    await this.close();
  }
}
