import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { matchesAmoLicense } from "../../scripts/release/license.js";
import { sha256 } from "../../scripts/release/package.js";

test("the captured AMO 1.1.2 license matches the exact submitted WTFPL and CMU text", async () => {
  const raw = `${await readFile("LICENSE", "utf8")}\nCMU pronunciation data and derived metadata retain the following terms:\n\n${await readFile("naming-data/CMU-LICENSE.txt", "utf8")}`.trim();
  const api = await readFile("tests/release/fixtures/amo-license-1.1.2.txt", "utf8");
  assert.notEqual(api, raw, "This fixture must exercise real API rendering");
  assert(matchesAmoLicense(api, sha256(raw)));
  for (const changed of [
    api.replace("Quince Pie", "Another owner"),
    api.replace("pie@quince.org", "pie@other.org"),
    api.replace("You just DO", "You must not DO"),
    api.replace("retain the above copyright", "omit the above copyright"),
    api.replace('href="/"', 'href="https://evil.invalid/"'),
    api.replace('rel="nofollow"', 'rel="nofollow" style="display:none"'),
    api.replace("Stackma\n", "Stackma<br>\n"),
    api.replace("All rights reserved.", "All rights reserved.<!-- change -->"),
    `${api}\n`,
  ]) assert(!matchesAmoLicense(changed, sha256(raw)), "Unreviewed changes must not be normalized away");
});

test("HTML parsing accepts equivalent entities and attribute syntax without altering terms", () => {
  const raw = "Copyright <pie@quince.org> ©\nTerms & conditions";
  const api = 'Copyright &lt;<a rel="nofollow" href="/">pie@quince.org</a>&gt; &#169;\nTerms &amp; conditions';
  assert(matchesAmoLicense(api, sha256(raw)));
  assert(matchesAmoLicense(api.replace('href="/"', "href='/'"), sha256(raw)));
  for (const html of ["<script>terms</script>", "<!--terms-->", '<a href="/" rel="nofollow" href="https://evil.invalid">terms</a>', '<svg><a>terms</a></svg>', '<a href="/" rel="nofollow"><b>terms</b></a>']) {
    assert(!matchesAmoLicense(html, sha256("terms")));
  }
});

test("links retain their displayed destination, including Mozilla's outgoing wrapper", () => {
  const label = "https://example.org/license?a=1&b=2";
  const wrapped = `https://outgoing.prod.mozaws.net/v1/${"a".repeat(64)}/${encodeURIComponent(label)}`;
  for (const href of [wrapped, "https://example.org/license?a=1&amp;b=2"]) {
    assert(matchesAmoLicense(`<a href="${href}" rel="nofollow">https://example.org/license?a=1&amp;b=2</a>`, sha256(label)));
  }
  assert(!matchesAmoLicense('<a href="https://evil.invalid" rel="nofollow">https://example.org</a>', sha256("https://example.org")));
});

test("license comparison handles unavailable text and plain Unicode text", () => {
  for (const value of [undefined, null, {}, 42]) assert(!matchesAmoLicense(value, sha256("terms")));
  for (const text of ["terms", "Unicode © 中文"]) {
    assert(matchesAmoLicense(text, sha256(text)));
  }
  assert(!matchesAmoLicense("terms", undefined));
});
