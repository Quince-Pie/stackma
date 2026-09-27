# Tab Gantry rename and release sequence

**Subsequent URL/icon migration:** the owner retained the add-on ID and chose
the `tab-gantry` repository and AMO URL. See [the later migration record](url-and-icon-rename.md).
The source and release observations below describe the original rename sequence.

The owner requested the rename on 2026-09-27, including an unlisted build to
install immediately and then a listed build for Mozilla review. The owner
explicitly approved replacing pending listed **1.1.7** with renamed **1.1.9**.

**Delivered:** [signed personal 1.1.8](https://github.com/Quince-Pie/stackma/releases/download/v1.1.8/tab-gantry-1.1.8.xpi)
is published in an immutable GitHub release. Install it over Stackma using
Firefox's Add-ons Manager → Install Add-on From File. A real Firefox 156 upgrade
from 1.1.6 retained native group IDs, custom title/color/collapse, local storage and the
original installation date. No uninstall or new AMO entry is needed.

The AMO title was changed with a name-only PATCH and verified by readback.
Listed **1.1.9**, AMO version `6518401`, is submitted for review. The explicitly
authorized creation disabled pending **1.1.7**; unlisted 1.1.8 remains installable.
The [hosted submission run](https://github.com/Quince-Pie/stackma/actions/runs/36308260071)
completed successfully in `awaiting-review`, with permanent installation and
GitHub publication correctly skipped. Independent owner downloads matched the
tested source, normalized payload and inherited license. The scheduled resumer
remains active for approval; these checks do not establish listed publication.
The [evidence record](../evidence/release/tab-gantry-rename.json) separates live
publication, source verification, manual upgrade and the remaining review gate.

| Surface | Value |
| --- | --- |
| Firefox extension name and popup | Tab Gantry |
| AMO listing title | Tab Gantry - Automatic Tab Groups |
| First renamed personal build | 1.1.8, unlisted |
| Renamed AMO review submission | 1.1.9, listed |
| Add-on ID | `stackma@extensions.local`, unchanged |
| Existing AMO slug and repository | `stackma`, unchanged |
| New package filenames | `tab-gantry-VERSION.xpi` and `tab-gantry-VERSION-source.zip` |

The title is descriptive and within AMO's deployed 50-character limit. A
name-only authenticated PATCH changes its translated `en-US` name. Readback must
confirm the ID, GUID, slug, locale, summary, description and version-license
metadata remain unchanged. Name changes can trigger Mozilla content review;
there is no promise that a rename accelerates review. See the
[published edit API](https://mozilla.github.io/addons-server/topics/api/addons.html#edit)
and [listing guidance](https://extensionworkshop.com/documentation/develop/create-an-appealing-listing/).
The decisive serializer, slug handling and content-review path were inspected at
AMO production `2026.09.17-1`, commit `c03d3c661bdbe22bb8f4a52fc46d63668bb31751`.

## Identity and compatibility

Product changes are display text only: manifest name/toolbar title, popup labels,
notices and diagnostic prefixes. Grouping/naming behavior, permissions, storage
keys, Firefox 156 minimum, icon and default update service stay unchanged.
Original Stackma copyright attributions and the complete WTFPL/CMU license text
remain intact. Historical documentation and old release assets are not renamed.

The npm package is private; its name now matches `tab-gantry`. No dependencies or
distribution services change. The AMO slug, GitHub repository, update ID, release
ownership markers and Actions concurrency/policy names remain stable technical
identifiers. A browser update recognizes the existing installation by ID.

Release branding is bound to the **frozen source**. New Tab Gantry input records
add the paired `displayName` and `artifactPrefix` fields. Historical records keep
their original schema and `stackma-` filenames. Only the supported pair is
accepted, preventing arbitrary paths or inconsistent labels. Build, stage,
signature verification, assembly and publication use that same identity. The
workflow accepts exactly one XPI from the signed artifact. Neither current main's
name nor a mutable AMO title can relabel an older release.

This is preferable to replacing all historical filename constants: that would
break byte/digest reconciliation of existing immutable releases. No algorithmic
performance change or broad optimality claim is involved. The current controller
was tested against frozen 1.1.7 and reproduced its original input context
byte-for-byte, including source hash
`7335955f2f4baa629afef371696ac8f509c680829d4e52a68e7eab17b450293a`.

## Publication and verification

Land the reviewed branding change first, then prepare unlisted 1.1.8 as a
version-only change against that branded base. Its committed unlisted exception
uses the existing operator command and requires exact merged-source hosted CI.
Verify permanent signing, source/payload/license, immutable assets, attestations
and public downloads before handing over the XPI. A disposable-profile manual
upgrade from signed 1.1.6 checks that the new name, native groups and extension
storage survive. It does not claim default-AMO delivery of an unlisted file.

Then prepare listed 1.1.9 through the normal version PR. If 1.1.7 still awaits
review, the ordinary merge run deliberately refuses to supersede it. After its
tag exists, use the owner's explicit choice:

```sh
gh workflow run release.yml --ref main --repo Quince-Pie/stackma \
  -f tag=v1.1.9 -f supersede=1.1.7
```

The guard rechecks the exact pending version immediately before creation. It does
not authorize replacing a different pending version. Mozilla disables pending
1.1.7 as part of creating listed 1.1.9; no tag, intent or release is deleted.
If 1.1.7 is already approved, it need not be disabled. The existing scheduler
continues publication after Mozilla approval.

Unlisted 1.1.8 is installed from its signed XPI. It will not arrive through the
default AMO updater. A later approved compatible listed 1.1.9 can update it using
the unchanged ID. Actual AMO update delivery remains a separate live acceptance
gate after approval. Provider review time is outside this release controller.

## Reproduce installation continuity

Use the verified signed 1.1.6 and 1.1.8 release assets with Firefox 156 and
geckodriver from the documented toolchain. Keep inputs immutable and reserve
separate scratch report/log paths for the duration of the test:

```sh
node evidence/release/tab-gantry-manual-upgrade.mjs \
  --old-xpi=/path/to/stackma-1.1.6.xpi \
  --new-xpi=/path/to/tab-gantry-1.1.8.xpi \
  --new-sha256=3a17c71723947e179f816706f381d274cc3c1e71c50c40d8f2df33479455e81a \
  --output=artifacts/manual-upgrade-1.1.6-to-1.1.8.json
```

The scoped harness uses a disposable profile, signature enforcement, private
package snapshots and Firefox's actual installed archive bytes. It rejects
observed input/report/log path aliases before writing. Its HTTP(S) proxy blocks
ordinary external requests; this is not a host-wide network sandbox. Browser
lifetime is bounded to 150 seconds, with 30-second driver requests and cleanup.
This test explicitly installs both files. It does not exercise the AMO updater.

After listed 1.1.9 is approved, signed, verified and published, exercise that
separate gate using its verified signed digest:

```sh
node scripts/release/update-test.js \
  --from-xpi=/path/to/tab-gantry-1.1.8.xpi \
  --from-version=1.1.8 --to-version=1.1.9 \
  --to-sha256=VERIFIED_SIGNED_1_1_9_SHA256 \
  --output=artifacts/update-1.1.8-to-1.1.9.json
```

Do not substitute the pending uploaded file's hash for the signed digest.
Until approval, the scheduler has nothing public to complete. For an immediate
post-approval retry, dispatch `release.yml` on `main` with `tag=v1.1.9`; do not
repeat the supersession input or create a new version.

## Observed draft visibility and recovery

GitHub accepted draft creation for both 1.1.6 and 1.1.8 before the following
release-list read exposed the draft. The 1.1.8 run stopped safely; a read-only
query located the matching empty draft, and the same frozen-source command
reused it to finish all four assets, publication and native attestations.
Public unauthenticated downloads were checked against all four expected hashes.

The follow-up controller change allows at most six reconciliation reads with
15 seconds between missing observations, adding at most 75 seconds of waiting.
It never repeats the create. Ownership, duplicate and asset conflicts still
stop immediately, and exhausted visibility waits preserve the draft for a later
run. This extends the existing reconciliation mechanism without changing release
authority or success criteria. Deterministic regression checks cover delayed
visibility and bounded stopping followed by reuse; the new wait itself has not
been claimed as exercised by a later live draft creation. No provider visibility
deadline or quantified latency improvement is inferred from two observations.
