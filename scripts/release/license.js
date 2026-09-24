import { parseFragment } from "parse5";
import { sha256 } from "./package.js";

function matchesLink(label, href) {
  // AMO maps generated mailto links to '/' in get_outgoing_url(). Accept an
  // actual mailto destination as well, but never an unrelated clickable target.
  if (/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/u.test(label)) {
    return href === "/" || href === `mailto:${label}`;
  }
  try {
    let target = new URL(href);
    if (target.origin === "https://outgoing.prod.mozaws.net") {
      const match = /^\/v1\/[a-f0-9]{64}\/(.+)$/u.exec(target.pathname);
      if (!match || target.username || target.password || target.search || target.hash) return false;
      target = new URL(decodeURIComponent(match[1]));
    }
    if (!["http:", "https:"].includes(target.protocol)) return false;
    const expected = /^[a-z][a-z0-9+.-]*:/iu.test(label)
      ? new URL(label) : new URL(`${target.protocol}//${label}`);
    return target.href === expected.href;
  } catch { return false; }
}

// License files are plain text; AMO's documented LinkifiedField is an HTML
// fragment. Parse using HTML's tree/character-reference rules, then validate the
// allowed presentation structure and every link destination before comparing
// the complete text. Never trim/collapse whitespace or discard arbitrary tags.
export function matchesAmoLicense(apiText, expectedSha256) {
  if (typeof apiText !== "string" || apiText.length > 4 * 1024 * 1024) return false;
  let malformed = false;
  const fragment = parseFragment(apiText, { scriptingEnabled: false, onParseError: () => { malformed = true; } });
  if (malformed) return false;
  const text = [];
  for (const node of fragment.childNodes) {
    if (node.nodeName === "#text") { text.push(node.value); continue; }
    if (node.nodeName !== "a" || node.namespaceURI !== "http://www.w3.org/1999/xhtml" ||
        node.attrs.length !== 2 || node.attrs.some(attr => attr.namespace || !["href", "rel"].includes(attr.name)) ||
        node.childNodes.some(child => child.nodeName !== "#text")) return false;
    const attrs = Object.fromEntries(node.attrs.map(attr => [attr.name, attr.value]));
    const label = node.childNodes.map(child => child.value).join("");
    if (attrs.rel !== "nofollow" || !matchesLink(label, attrs.href)) return false;
    text.push(label);
  }
  return sha256(text.join("")) === expectedSha256;
}
