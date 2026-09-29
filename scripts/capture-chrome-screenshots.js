import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { crc32, deflateSync } from "node:zlib";
import { chromePackage } from "./chrome-package.js";
import { ChromeDriver } from "./chrome.js";

// Chrome Web Store screenshots are 1280x800 and should show the actual user
// experience (developer.chrome.com/docs/webstore/images#screenshots). Headless
// Chrome draws no tab strip, so a visible Chrome runs on an Xvfb screen and the
// capture is its window's own pixels. The screen is larger than the window: the
// pointer starts at the screen's centre, outside the window, and hovers nothing.
// The store shows screenshots downscaled to 640x400, so the window uses a 1.25
// display scale, common on laptops, to keep tab and group names legible. Use
// Chromium or Chrome: Chrome for Testing draws its own warning bar
// (chrome/browser/ui/startup/infobar_utils.cc).
//
// The pages are live Wikipedia, Wikimedia Commons and Wikivoyage pages. Links
// are middle-clicked, as a reader opens them, and Tab Gantry groups and names
// each set. Site notices are closed with the sites' own close buttons.
const WIDTH = 1280, HEIGHT = 800, SCALE = 1.25;
const reading = { url: "https://en.wikipedia.org/wiki/Sourdough",
  links: [{ text: "yeast" }, { href: "https://commons.wikimedia.org/" }] };
const trip = { url: "https://en.wikivoyage.org/wiki/Lisbon", links: [{ text: "Sintra" }, { text: "Cascais" }] };
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

// Xvfb -fbdir exposes the screen as an XWD file: a big-endian header, then
// ZPixmap rows in the server's byte order, little-endian BGRX at depth 24.
async function screenPixels(path) {
  const file = await readFile(path);
  const field = index => file.readUInt32BE(index * 4);
  const [size, version, format, , width, height, , byteOrder] = [0, 1, 2, 3, 4, 5, 6, 7].map(field);
  assert.deepEqual({ version, format, byteOrder, bitsPerPixel: field(11), masks: [field(14), field(15), field(16)] },
    { version: 7, format: 2, byteOrder: 0, bitsPerPixel: 32, masks: [0xff0000, 0xff00, 0xff] }, "Unexpected Xvfb framebuffer layout");
  assert(width >= WIDTH && height >= HEIGHT);
  const start = size + field(19) * 12, stride = field(12);
  const rgb = Buffer.alloc(WIDTH * HEIGHT * 3);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const source = start + y * stride + x * 4, target = (y * WIDTH + x) * 3;
      rgb[target] = file[source + 2];
      rgb[target + 1] = file[source + 1];
      rgb[target + 2] = file[source];
    }
  }
  return rgb;
}

function png(rgb) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const frame = Buffer.alloc(8);
    frame.writeUInt32BE(data.length, 0);
    frame.writeUInt32BE(crc32(body), 4);
    return Buffer.concat([frame.subarray(0, 4), body, frame.subarray(4)]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(WIDTH, 0);
  header.writeUInt32BE(HEIGHT, 4);
  header.set([8, 2], 8); // 8-bit RGB, no alpha
  const rows = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
  for (let y = 0; y < HEIGHT; y++) rgb.copy(rows, y * (WIDTH * 3 + 1) + 1, y * WIDTH * 3, (y + 1) * WIDTH * 3);
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

async function startXvfb(fbdir) {
  const server = spawn(process.env.XVFB ?? "Xvfb", ["-displayfd", "3", "-screen", "0", "2600x1700x24", "-fbdir", fbdir,
    "-nolisten", "tcp", "-nocursor", "-dpi", "96"], { stdio: ["ignore", "ignore", "pipe", "pipe"] });
  let log = "";
  server.stderr.on("data", chunk => { log = (log + chunk).slice(-8192); });
  const { promise, resolve, reject } = Promise.withResolvers();
  let number = "";
  server.stdio[3].on("data", chunk => {
    number += chunk;
    if (number.includes("\n")) resolve(`:${number.trim()}`);
  });
  server.once("error", reject);
  server.once("exit", code => reject(new Error(`Xvfb exited (${code})\n${log}`)));
  const timer = setTimeout(() => reject(new Error("Xvfb did not report a display")), 10_000);
  try {
    return { server, display: await promise };
  } catch (error) {
    server.kill("SIGKILL");
    throw error;
  } finally { clearTimeout(timer); }
}

// Chrome's interface font is fontconfig's "sans". Prefer Noto Sans, a common
// Linux interface font, over the local default when it is installed.
const fontconfig = base => `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <alias binding="strong"><family>sans-serif</family><prefer><family>Noto Sans</family></prefer></alias>
  <alias binding="strong"><family>Sans</family><prefer><family>Noto Sans</family></prefer></alias>
  <include ignore_missing="no">${base.replace(/[&<>"]/gu, character => `&#${character.charCodeAt(0)};`)}</include>
</fontconfig>
`;

const root = await mkdtemp(join(tmpdir(), "tab-gantry-screenshots-"));
let xvfb, driver;
try {
  const unpacked = join(root, "extension");
  await mkdir(unpacked);
  const { manifest, entries } = await chromePackage();
  for (const entry of entries) {
    if (entry.path) await copyFile(entry.path, join(unpacked, entry.name));
    else await writeFile(join(unpacked, entry.name), entry.content);
  }
  await mkdir(join(root, "fb"));
  await mkdir(join(root, "home"));
  await writeFile(join(root, "fonts.conf"), fontconfig(process.env.FONTCONFIG_FILE ?? "/etc/fonts/fonts.conf"));
  xvfb = await startXvfb(join(root, "fb"));
  // A minimal environment keeps the desktop's theme, dark mode, scale and
  // session bus out of the capture. Chromium builds without a Google API key
  // show a notice bar; any GOOGLE_API_KEY value counts as configured
  // (google_apis/api_key_cache.cc), and official Chrome builds ignore it.
  const env = { PATH: process.env.PATH, HOME: join(root, "home"), DISPLAY: xvfb.display, LANG: "en_US.UTF-8",
    FONTCONFIG_FILE: join(root, "fonts.conf"), GOOGLE_API_KEY: "no",
    ...(process.env.TZDIR ? { TZDIR: process.env.TZDIR } : {}) };
  driver = await ChromeDriver.start({ headless: false, offline: false, env, timeoutMs: 30_000, maxLifetimeMs: 300_000,
    args: ["--ozone-platform=x11", `--force-device-scale-factor=${SCALE}`, "--window-position=0,0",
      `--window-size=${WIDTH / SCALE},${HEIGHT / SCALE}`] });
  const { targetInfos: initial } = await driver.send("Target.getTargets");
  const id = await driver.loadExtension(unpacked);
  const sw = (fn, ...args) => driver.extension(id, fn, ...args);
  // Pin the action as a reader would, so the popup opens from its own button.
  const extensions = await driver.page("chrome://extensions");
  await driver.evaluate(extensions.sessionId, extensionId =>
    chrome.developerPrivate.updateExtensionConfiguration({ extensionId, pinnedToToolbar: true }), id);
  await driver.send("Target.closeTarget", { targetId: extensions.targetId });

  async function open({ url, links }) {
    const page = await driver.page("about:blank");
    const loaded = driver.waitFor(message => message.method === "Page.loadEventFired" && message.sessionId === page.sessionId);
    await driver.send("Page.navigate", { url }, page.sessionId);
    await loaded;
    const notices = await driver.evaluate(page.sessionId, async () => {
      const closed = new Set();
      const shown = element => element.getClientRects().length > 0;
      // Campaign banners and site notices arrive after load.
      for (let turn = 0; turn < 40; turn++) {
        for (const control of document.querySelectorAll("#centralNotice :is(.frb-close, .cn-closeButton), #siteNotice .mw-dismissable-notice-close a")) {
          if (shown(control) && !closed.has(control)) { control.click(); closed.add(control); }
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return { closed: closed.size, remaining: [...document.querySelectorAll("#centralNotice, #siteNotice")].filter(notice => notice.offsetHeight > 0).length };
    });
    assert.equal(notices.remaining, 0, `${url} still shows a site notice; capture again later`);
    for (const link of links) {
      const point = await driver.evaluate(page.sessionId, async ({ text, href }) => {
        const anchor = [...document.querySelectorAll("#mw-content-text a")].find(candidate =>
          text ? candidate.textContent.trim() === text : candidate.href.startsWith(href));
        if (!anchor) throw new Error(`No link ${text ?? href}`);
        anchor.scrollIntoView({ block: "center" });
        await new Promise(requestAnimationFrame);
        const [box] = anchor.getClientRects();
        const target = { x: box.x + Math.min(8, box.width / 2), y: box.y + box.height / 2 };
        if (!anchor.contains(document.elementFromPoint(target.x, target.y))) throw new Error(`Link ${text ?? href} is covered`);
        return target;
      }, link);
      for (const type of ["mousePressed", "mouseReleased"]) {
        await driver.send("Input.dispatchMouseEvent", { type, ...point, button: "middle", buttons: type === "mousePressed" ? 4 : 0, clickCount: 1 }, page.sessionId);
      }
      await delay(500);
    }
    // Leave the page as a reader would: at the top, with no link focused or hovered.
    const height = await driver.evaluate(page.sessionId, () => {
      document.activeElement?.blur();
      scrollTo(0, 0);
      return innerHeight;
    });
    await driver.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 4, y: height - 40 }, page.sessionId);
    return { ...page, notices: notices.closed };
  }

  const first = await open(reading);
  for (const target of initial.filter(info => info.type === "page")) await driver.send("Target.closeTarget", { targetId: target.targetId });
  const second = await open(trip);

  const deadline = Date.now() + 10_000;
  let state;
  for (;;) {
    state = await sw(async browser => ({
      tabs: (await browser.tabs.query({})).sort((a, b) => a.index - b.index).map(tab => tab.groupId),
      groups: (await browser.tabGroups.query({})).map(({ id, title, color }) => ({ id, title, color })),
    }));
    if (state.groups.length === 2 && state.groups.every(group => group.title)) break;
    assert(Date.now() < deadline, `Expected two named groups; got ${JSON.stringify(state)}`);
    await delay(100);
  }
  const [a, b] = [state.tabs[0], state.tabs[3]];
  assert.deepEqual(state.tabs, [a, a, a, b, b, b], "Each page and the two tabs opened from it form one group");
  const { targetInfos } = await driver.send("Target.getTargets");
  const hosts = targetInfos.filter(info => info.type === "page").map(info => new URL(info.url).hostname).sort();
  assert.deepEqual(hosts, ["commons.wikimedia.org", "en.wikipedia.org", "en.wikipedia.org",
    "en.wikivoyage.org", "en.wikivoyage.org", "en.wikivoyage.org"]);

  async function capture(name) {
    let previous;
    for (let frame = 0; frame < 40; frame++) {
      await delay(250);
      const rgb = await screenPixels(join(root, "fb", "Xvfb_screen0"));
      if (previous?.equals(rgb)) {
        const bytes = png(rgb);
        await mkdir("listing/chrome", { recursive: true });
        await writeFile(`listing/chrome/${name}`, bytes);
        return { bytes: bytes.length, sha256: sha256(bytes) };
      }
      previous = rgb;
    }
    throw new Error(`The screen did not settle for ${name}`);
  }

  const files = {};
  await driver.send("Target.activateTarget", { targetId: first.targetId });
  await delay(1_000);
  files["screenshot-1.png"] = await capture("screenshot-1.png");

  await driver.send("Target.activateTarget", { targetId: second.targetId });
  await delay(500);
  await sw(browser => browser.action.openPopup());
  let popupInfo;
  for (let turn = 0; !popupInfo; turn++) {
    assert(turn < 100, "The popup did not open");
    await delay(50);
    popupInfo = (await driver.send("Target.getTargets")).targetInfos.find(info => info.url === `chrome-extension://${id}/popup.html`);
  }
  const { sessionId: popup } = await driver.send("Target.attachToTarget", { targetId: popupInfo.targetId, flatten: true });
  for (let turn = 0; await driver.evaluate(popup, () => document.querySelector("#result-count")?.textContent) !== "2 groups"; turn++) {
    assert(turn < 100, "The popup did not list both groups");
    await delay(50);
  }
  await driver.send("Target.detachFromTarget", { sessionId: popup });
  await delay(500);
  files["screenshot-2.png"] = await capture("screenshot-2.png");

  console.log(JSON.stringify({ chrome: driver.version.product, extension: manifest.version, scale: SCALE,
    pages: [reading.url, trip.url], noticesClosed: first.notices + second.notices,
    groups: state.groups.map(({ title, color }) => ({ title, color })), files }, null, 2));
} finally {
  await driver?.close();
  xvfb?.server.kill("SIGTERM");
  await rm(root, { recursive: true, force: true });
}
