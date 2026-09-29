import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { ChromeDriver } from "./chrome.js";

// The Chrome Web Store requires a 440x280 small promo tile. Its guidance asks
// for no text, saturated colour filling the tile and an image that still works
// at half size (developer.chrome.com/docs/webstore/images#promo). Draw the
// icon's mark in white on its own blue, with the lifted tab in the teal of its
// dark palette. At 5 px per unit the 28-unit mark spans 140 px, half the height.
const WIDTH = 440, HEIGHT = 280, UNIT = 5;
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

const svg = await readFile("extension/icon.svg");
const driver = await ChromeDriver.start({ maxLifetimeMs: 60_000 });
try {
  const { sessionId } = await driver.page("about:blank");
  const { png: encoded, samples } = await driver.evaluate(sessionId, async (source, width, height, unit) => {
    const doc = new DOMParser().parseFromString(source, "image/svg+xml");
    const icon = doc.documentElement;
    const background = icon.getAttribute("fill");
    doc.querySelector("style").remove();
    icon.setAttribute("fill", "#ffffff");
    doc.querySelector("#tab-lifted").setAttribute("fill", "#63d8ba");
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(doc)], { type: "image/svg+xml" }));
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    context.fillStyle = background;
    context.fillRect(0, 0, width, height);
    // The 32-unit viewBox centred on the tile; integer unit sizes keep edges on pixels.
    const size = 32 * unit;
    context.drawImage(image, (width - size) / 2, (height - size) / 2, size, size);
    URL.revokeObjectURL(url);
    const at = (x, y) => [...context.getImageData(x, y, 1, 1).data];
    const origin = [(width - size) / 2, (height - size) / 2];
    const point = (x, y) => at(origin[0] + x * unit, origin[1] + y * unit);
    return { png: canvas.toDataURL("image/png").split(",")[1],
      samples: { corner: at(0, 0), frame: point(4, 20), lifted: point(16, 12), middle: point(16, 22), gap: point(16, 17) } };
  }, svg.toString("utf8"), WIDTH, HEIGHT, UNIT);
  const png = Buffer.from(encoded, "base64");
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(png.readUInt32BE(16), WIDTH);
  assert.equal(png.readUInt32BE(20), HEIGHT);
  const blue = [0x45, 0x5b, 0xd4, 255], white = [255, 255, 255, 255];
  assert.deepEqual(samples, { corner: blue, frame: white, lifted: [0x63, 0xd8, 0xba, 255], middle: white, gap: blue });
  await mkdir("listing/chrome", { recursive: true });
  await writeFile("listing/chrome/small-promo-tile.png", png);
  console.log(JSON.stringify({ source: "extension/icon.svg", sourceSha256: sha256(svg), output: "listing/chrome/small-promo-tile.png",
    width: WIDTH, height: HEIGHT, bytes: png.length, sha256: sha256(png), renderer: driver.version.product }));
} finally { await driver.close(); }
