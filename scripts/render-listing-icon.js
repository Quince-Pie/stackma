import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { FirefoxDriver } from "./webdriver.js";

// AMO requires a raster listing icon. Render the maintained SVG with the same
// Firefox baseline as the extension, explicitly using its light palette.
const svg = await readFile("extension/icon.svg");
const driver = await FirefoxDriver.start({ maxLifetimeMs: 60_000,
  prefs: { "layout.css.prefers-color-scheme.content-override": 1 } });
try {
  const encoded = await driver.content(async source => {
    if (!matchMedia("(prefers-color-scheme: light)").matches) throw new Error("Expected light icon palette");
    const image = new Image();
    image.src = `data:image/svg+xml;base64,${source}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 128;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0, 128, 128);
    if (!context.getImageData(0, 0, 128, 128).data.some(value => value !== 0)) throw new Error("Empty rendered icon");
    return canvas.toDataURL("image/png").split(",")[1];
  }, svg.toString("base64"));
  const png = Buffer.from(encoded, "base64");
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(png.readUInt32BE(16), 128); assert.equal(png.readUInt32BE(20), 128);
  await mkdir("listing", { recursive: true });
  await writeFile("listing/icon.png", png);
  console.log(JSON.stringify({ source: "extension/icon.svg", sourceSha256: createHash("sha256").update(svg).digest("hex"),
    output: "listing/icon.png", bytes: png.length, sha256: createHash("sha256").update(png).digest("hex"),
    firefox: driver.capabilities.browserVersion, palette: "light", width: 128, height: 128 }));
} finally { await driver.close(); }
