# AMO representation corrections

Baseline: `9038a87ab8d754fe11156acfb4ebce5d11325636` (`v1.1.2`), fetched and
fast-forwarded locally without altering the tag. A 45-minute investigation and
verification budget began at 2026-09-24 04:30:26 UTC. After the user chose a fresh
release, experimental controller separation was removed. The proposed next
release is **v1.1.3** through the normal release-PR flow. No remote version, tag,
license, source attachment or publication was modified during this investigation.

## Provider mechanisms and contract

AMO version `6510050` exists, listed and unreviewed at inspection, with no source
attachment. Its license is rendered HTML, not the submitted plain text. Its XPI
also has a normalized manifest. All other 12 original members match local source.
These are observed transformations, not authorization to accept arbitrary changes.

The inspected addons-server revision is
[`4b4e5bb354a846a548a0baade9f21504a2c5a92a`](https://github.com/mozilla/addons-server/tree/4b4e5bb354a846a548a0baade9f21504a2c5a92a):

- [`License.text`](https://github.com/mozilla/addons-server/blob/4b4e5bb354a846a548a0baade9f21504a2c5a92a/src/olympia/versions/models.py)
  is a `LinkifiedField`. `TranslationSerializerField` calls `str(translation)`;
  `LinkifiedTranslation` sanitizes and linkifies through JustHTML. Its permitted
  element is `a`. `get_outgoing_url()` maps non-HTTP schemes such as generated
  mailto links to `/`. This explains the escaped brackets and email anchors.
  The [API documentation](https://mozilla.github.io/addons-server/topics/api/overview.html#outgoing-links)
  confirms inline wrapping in license fields; the inspected version-detail
  serializer exposes no raw-text selection option.
- [`repack_fileupload`](https://github.com/mozilla/addons-server/blob/4b4e5bb354a846a548a0baade9f21504a2c5a92a/src/olympia/files/tasks.py)
  runs manifest normalization when enabled, writing `json.dumps(data, indent=2)`.
  Its default ASCII escaping and lack of a trailing newline account for all
  differences in the captured manifest. The signing GUID-injection path was
  also inspected; Stackma already declares its GUID.

The preserved constraints are complete license terms, checked link destinations,
unchanged add-on identity/behavior, exact original XPI member bytes, fixed source
and tag identities, and conflict-preserving recovery. Source and packaged license
files remain unchanged. This is an occasional release operation; no performance
ranking or universal optimality claim is made.

## Selection and implementation

Raw string equality is the conventional control and fails the live license.
A narrow email substitution prototype was rejected: it binds correctness to one
HTML spelling. Unrestricted tag stripping/textContent alone would ignore hidden
markup and changed links. A raw API representation would be preferable for a raw
byte comparison, but the documented/inspected endpoint supplies cleaned HTML.

The delivered parser uses **parse5 8.0.1**, a locked development dependency, with
its HTML5 fragment and character-reference handling. Its
[release history](https://github.com/inikulin/parse5/releases/tag/v8.0.1) includes
the v8 ESM transition, entities 8, a BMP decoding optimization and a reverted
tag-lookup optimization; no upstream speed result is claimed for this workflow.
The entry point, fragment parser, default tree adapter, tokenizer/entity decoding
and error path were inspected. The maintained
[htmlparser2 alternative](https://github.com/fb55/htmlparser2) explicitly directs
strict HTML-spec consumers to parse5. Running a browser only to parse metadata
would add a process and startup/failure boundary; Node 24 has no native DOMParser.

`license.js` accepts text and validated, text-only anchors. Unknown elements,
namespaces, attributes, parse errors and comments fail. Each anchor must have
`rel=nofollow`; email destinations must match their label or AMO's documented
non-HTTP fallback. URL destinations must match the displayed URL, including
decoding the production outgoing wrapper. The entire decoded text is hashed;
there is no whitespace trimming/collapsing or legal-clause omission. The scope
is Stackma's plain-text license documents presented by AMO, not arbitrary authored
HTML license documents. The API/HTML checks do not prove equality of inaccessible
database raw text; the package and source copies retain their exact byte checks.

The signer records both the submitted text digest and the verified API HTML
digest. The publisher rechecks the latter exactly. This also keeps the parser
out of preparation and publication jobs, which intentionally do not install npm
dependencies. A dependency-free import test covers that boundary. The parser is
not bundled in the extension. Body limits bound input; parsing is synchronous,
network calls retain their deadlines, and the existing job timeout remains the
total execution bound. No lock-free or wait-free claim applies.

For the manifest, semantic-only ZIP exceptions and tolerance for arbitrary
rewrites were rejected. Instead, the checked-in manifest and version preparer
use the provider's serialization profile **before** testing/packaging. The exact
byte comparator is unchanged. This encoding is qualified against Stackma's
manifest fields and captured AMO output; it is not a general replacement for
Python's JSON encoder over arbitrary JavaScript values. If future fields produce
different provider bytes, the unchanged payload gate stops publication.

## Verification and limits

The captured license and manifest are checked-in fixtures. Negative cases cover
changed clauses, owners, addresses, destinations, hidden markup, duplicate
attributes, foreign content, missing metadata and whitespace changes. Positive
cases cover entities, Unicode, attribute syntax, URLs and the outgoing wrapper.
Manifest tests cover Unicode BMP/supplementary characters, controls, literal
escapes and version preparation without depending on the repository's current
version. Existing signing, source-conflict, metadata-race and publication tests
remain in the release suite.

Read-only owner download verified the AMO file's declared digest. The original
local package fails the strict member comparison at the manifest. A separately
identified formatting-only test copy passes **all 13 original member checks**
against that same AMO file, and passes Firefox 156 package installation, grouping
and naming. That test copy remains version 1.1.2 solely to compare with the
observed file; it was never submitted or substituted for the existing release.

See [verification evidence](../evidence/release/amo-formats.json) for source hashes,
commands, results and the finite budget. No actual 1.1.3 submission, approval,
permanent signed installation or GitHub publication has occurred. These remain
the live acceptance gates for the new release; passing local tests is not a claim
that the whole release has already succeeded.
