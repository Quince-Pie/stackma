import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { ChromeDriver } from "./chrome.js";

// Chrome manifest icons must be raster images (developer.chrome.com/docs/
// extensions/reference/manifest/icons). Render the maintained SVG in its light
// palette. Toolbar and management sizes use the mark's own margin; the 128px
// install/store icon draws the 32-unit mark at 3.5 px per unit inside an 8px
// border, so its 28-unit artwork spans 98px (77%), within the Chrome Web Store
// guidance of 75-80% for squarish icons (docs/webstore/images#icon-size).
export const icons = [
  { size: 16, inset: 0 }, { size: 24, inset: 0 }, { size: 32, inset: 0 },
  { size: 48, inset: 0 }, { size: 128, inset: 8 },
];
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

const svg = await readFile("extension/icon.svg");
const driver = await ChromeDriver.start({ maxLifetimeMs: 60_000 });
try {
  const { sessionId } = await driver.page("about:blank");
  await driver.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] }, sessionId);
  const rendered = await driver.evaluate(sessionId, async (source, icons) => {
    if (!matchMedia("(prefers-color-scheme: light)").matches) throw new Error("Expected light icon palette");
    const image = new Image();
    image.src = `data:image/svg+xml;base64,${source}`;
    await image.decode();
    const output = [];
    for (const { size, inset } of icons) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      const context = canvas.getContext("2d");
      context.imageSmoothingQuality = "high";
      context.drawImage(image, inset, inset, size - 2 * inset, size - 2 * inset);
      // The frame's left post is solid mark color in the light palette.
      const x = Math.floor(inset + (size - 2 * inset) * 4 / 32);
      const y = Math.floor(inset + (size - 2 * inset) * 20 / 32);
      output.push({ size, png: canvas.toDataURL("image/png").split(",")[1], sample: [...context.getImageData(x, y, 1, 1).data] });
    }
    return output;
  }, svg.toString("base64"), icons);
  const files = {};
  for (const { size, png: encoded, sample } of rendered) {
    const png = Buffer.from(encoded, "base64");
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
    assert.deepEqual(sample, [0x45, 0x5b, 0xd4, 255], `${size}px icon must use the light mark color`);
    const name = `icon-${size}.png`;
    await writeFile(`chrome/extension/${name}`, png);
    files[name] = { width: size, height: size, bytes: png.length, sha256: sha256(png) };
  }
  const record = {
    source: "extension/icon.svg", sourceSha256: sha256(svg), palette: "light",
    renderer: driver.version.product, geometry: Object.fromEntries(icons.map(({ size, inset }) => [`icon-${size}.png`, { inset }])),
    files,
  };
  await writeFile("chrome/icons.json", JSON.stringify(record, null, 2) + "\n");
  console.log(JSON.stringify(record));
} finally { await driver.close(); }
