# Listed 1.1.10: new icon and current AMO filename

The owner requested listed **1.1.10** after being told it would replace pending
listed **1.1.9** and include the new SVG icon. Keep add-on ID
`stackma@extensions.local`, AMO ID `3078021`, the `tab-gantry` listing/repository,
Firefox 156 minimum, permissions, grouping logic and license terms.

[Version PR #18](https://github.com/Quince-Pie/tab-gantry/pull/18) was prepared from
`60ffe1b4b8b96225ae888bb21cc1ca2e5106d556`. Its complete tree matched the generated
four-file version update: four version fields plus `release-intents/v1.1.10.json`.
The merged release source is `436d5507313b897d006221c2c7694ca66bf07cdd`.
Compared with submitted 1.1.9, the only extension changes are its version and
`icon.svg`; product code, naming data and licenses are identical.

The exact owner-supplied SVG has SHA-256
`300207737806d6e5e037ed2932b137f60b73c99b4fb07991cd4f50069f3f09b7`.
Its AMO listing rendering was already verified during the
[URL/icon migration](url-and-icon-rename.md). This version includes that SVG in
the actual extension package.

## Verification and authority

[Version CI](https://github.com/Quince-Pie/tab-gantry/actions/runs/36314243816)
passed on the unchanged reviewed source. Its first executing attempt stopped
with Firefox's `Document was unloaded` between the native-ID test's completed
`afterUpdate` phase and its popup result. The diagnostics were retained. One
bounded retry passed every check without changing the source or weakening any
assertion. A popup-navigation timing race is the likely mechanism; that precise
cause is not established, and the intermittent test-harness interruption remains
a limitation of this run's evidence.

The ordinary merge-triggered publisher retains the pending-review guard. The
owner-authorized continuation uses the existing workflow inputs:

```sh
gh workflow run release.yml --ref main --repo Quince-Pie/tab-gantry \
  -f tag=v1.1.10 -f pull-request=18 -f supersede=1.1.9
```

The override applies only to pending 1.1.9; another pending version still blocks
creation. Mozilla disables the older pending file when it accepts the new listed
version. No tag, intent, source archive or release is deleted or overwritten.

## Provider handoff

**Submitted and independently verified at 2026-09-27 11:18 UTC:** Mozilla accepted
listed version **6518667 / 1.1.10**, file **5062814**, with filename
**`tab_gantry-1.1.10.zip`** and status `unreviewed`. Pending 1.1.9 was disabled as
authorized. The listing remains `nominated`; permanent signing/publication and
actual automatic-update delivery remain separate gates.

The [authorized workflow](https://github.com/Quince-Pie/tab-gantry/actions/runs/36314832552)
passed source verification and created/reconciled the exact tag. Its signing job
continues the bounded approval wait in the background. Submission success here
comes from the accepted version and independent byte/source/license readback;
the workflow's terminal conclusion is not yet claimed.

The remote package matches the tested unsigned payload, including the exact new
SVG, and source archive SHA-256
`8bd8490941f24514130123e0279ddae339371c8aa3f5988a447437e048833022`.
Mozilla inherited license `10390` with the complete matching WTFPL/CMU terms.
The [evidence record](../evidence/release/listed-1.1.10.json) includes the immutable
input-artifact digest, source revision, actual filename, CI retry and guard results.

After an accepted pending submission, the existing resumer checks every six hours.
For immediate recovery after approval, use the existing tag without another
supersession input:

```sh
gh workflow run release.yml --ref main --repo Quince-Pie/tab-gantry \
  -f tag=v1.1.10
```

An approved signed XPI and complete verified GitHub assets remain prerequisites
for actual installed-user update acceptance. Use the verified signed 1.1.8
personal build and the final 1.1.10 signed digest in a disposable Firefox profile:

```sh
node scripts/release/update-test.js \
  --from-xpi=/path/to/tab-gantry-1.1.8.xpi \
  --from-version=1.1.8 --to-version=1.1.10 \
  --to-sha256=VERIFIED_SIGNED_1_1_10_SHA256 \
  --output=artifacts/update-1.1.8-to-1.1.10.json
```

The pending ZIP hash must not stand in for the signed digest. Submission is not
publication or automatic-update delivery. This release reuses the qualified
controller and changes no release architecture; it makes no universal-optimality
or faster-review claim.
