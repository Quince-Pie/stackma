# Tab Gantry rename and release sequence

The owner requested the rename on 2026-09-27, including an unlisted build to
install immediately and then a listed build for Mozilla review. The owner
explicitly approved replacing pending listed **1.1.7** with renamed **1.1.9**.

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
