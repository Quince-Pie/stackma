# Tab Gantry repository, listing URL and icon

On 2026-09-27 the owner chose to **keep the existing add-on ID** and rename only
the AMO URL and GitHub repository, after considering a new add-on identity.
The supplied `extension/icon.svg` is the new artwork. Existing installed-user
update continuity, product logic, browser support and license terms remain the
constraints. No new AMO add-on is created for this migration.

**Completed:** [PR #16](https://github.com/Quince-Pie/tab-gantry/pull/16) merged as
`34431e1550a44851ec0e8a8e1646ad1718a9c1dc`. The repository and listing URL were
renamed, the description/support links updated, and the processed AMO icon
verified. Listed 1.1.9 remains pending with its original package and source.
The [machine-readable evidence](../evidence/release/url-and-icon-rename.json)
records the separate local, hosted and live-provider checks.

| Item | Verified value |
| --- | --- |
| Firefox ID | `stackma@extensions.local`, retained |
| AMO numeric ID | `3078021`, retained |
| AMO title | Tab Gantry - Automatic Tab Groups |
| AMO URL | `https://addons.mozilla.org/firefox/addon/tab-gantry/` |
| Repository | `Quince-Pie/tab-gantry`, same repository ID `1384275718` |
| Pending version | Listed 1.1.9, AMO version `6518401`, retained |

The add-on ID is an internal identity, independent of the product name and URL.
Changing it would create a separate installation, data namespace and update
history. Renaming the URL preserves those relationships. A new listing has no
established review-speed benefit and no longer matches the owner's selected
continuity requirement. See Mozilla's [ID documentation](https://extensionworkshop.com/documentation/develop/extensions-and-the-add-on-id/).

## Provider boundaries and migration

Mozilla's [edit API](https://mozilla.github.io/addons-server/topics/api/addons.html#edit)
allows a slug-only change using the stable numeric ID. The migration also updates
the repository links in the owner's existing description and support website,
retaining the description prose. The deployed server was inspected at production `2026.09.17-1`, commit
`c03d3c661bdbe22bb8f4a52fc46d63668bb31751`, observed 2026-09-27.
`AddonSerializer.validate_slug`, `Addon.clean_slug` and the exact object lookup
establish the uniqueness/30-character limit and current-slug lookup. Old AMO
slug URLs have no guaranteed redirect and the old slug becomes reusable.

The release controller already addresses AMO by immutable GUID and verifies
the returned GUID. The obsolete equality check against the old slug is removed:
a renamed URL is not a different add-on. Regression checks accept the renamed
listing without writes and reject a different GUID even with the expected slug.
New release notes link to the new listing. Existing immutable release records,
archives, tags and ownership markers retain their original values.

GitHub's [repository rename contract](https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository)
preserves the repository and redirects ordinary old web/git URLs. It does not
redirect references to an action hosted under the old name. These workflows use
relative reusable CI and `github.repository`, not a published self-hosted action.
Local operator defaults now use the canonical repository name; authenticated
HTTP calls continue rejecting redirects. Rename the same repository object with
a name-only PATCH, then verify its ID, refs, release assets, policies and secret
names. Update the local `origin` URL without touching working files.
Do not reuse the old GitHub repository name: that would break its redirects.

Native release-attestation verification was inspected in installed `gh` 2.101.0,
upstream commit `0cf1092493af067646fc5f3db9421c6a6ec9c938`. It verifies the GitHub
release signer, tag identity and asset digest; signed historical repository-name
claims are not rewritten. Read-only verification against the new canonical name
is a migration acceptance gate. Compare attached `*-source.zip` assets: GitHub's
automatically generated source archives can change their root directory on rename.

Before renaming, finish active publication/preparation/resumption runs and record
the repository ID, refs, immutable releases and asset digests. Afterward verify
old public download redirects and new URLs against the same hashes, all existing
native release attestations, and repository/environment policies. Do not recreate
the repository, release or tag to repair a failed check. Preserve state, inspect
the provider result and stop release writes until resolved. Rename-back is only
an option after confirming the original name is still available for the same ID.

## Icon and release contents

The owner's SVG is copied unchanged. Its light palette renders the AMO icon:

```sh
node scripts/render-listing-icon.js
```

This uses the existing Firefox 156/geckodriver toolchain, a disposable profile,
blocked ordinary HTTP(S), and an explicit light-color preference. It writes a
transparent 128×128 `listing/icon.png`; no image-generation service or new build
dependency is involved. The extension continues packaging the SVG itself, with
its supplied light/dark palettes.

Mozilla's [icon API](https://mozilla.github.io/addons-server/topics/api/addons.html#addon-icon)
accepts a square PNG in multipart field `icon`. Production `resize_icon` produces
32/64/128 PNGs, recompresses them, and publishes `MD5(upload)[:8]` in the icon URL's
`modified` query after its delayed storage update. Confirm that marker and compare
decoded 128px RGBA pixels; recompression can change PNG bytes without changing
the artwork. Icon and slug edits do not create a version or replace an uploaded
XPI. Read back the same GUID and 1.1.9 payload/source/license afterward; the
license's derived URL is expected to change with the slug.

The new SVG is a source change for the **next package**. Already signed 1.1.8 and
pending listed 1.1.9 retain their frozen contents, including their previous
packaged icon. Updating the listing icon does not rewrite those files. Publishing
the SVG in a higher version uses the normal reviewed version PR; replacing a
still-pending listed version requires an explicit supersession choice.

## Verification status

Local release checks: 214 passed, including slug/identity regression coverage.
TypeScript, extension tests, strict AMO lint, the build and real Firefox package
installation passed. The supplied SVG's SHA-256 is
`300207737806d6e5e037ed2932b137f60b73c99b4fb07991cd4f50069f3f09b7`;
its rendered listing PNG's SHA-256 is
`8d11e66fc9bdde6f46047c85315f66e39ce9b0ca8e41a0e0bf969e5332a4eb3a`.
Those are local implementation checks. [PR CI](https://github.com/Quince-Pie/tab-gantry/actions/runs/36312638439)
passed before migration, and fresh [main CI](https://github.com/Quince-Pie/tab-gantry/actions/runs/36312922478)
passed in the renamed repository. Live checks established:

- The same repository ID/node ID, all 26 captured refs, three release objects,
  eight attached asset identities/digests and secret metadata survived rename;
  all seven repository-policy checks passed.
- All eight assets matched at both old redirected and new canonical public
  URLs. `gh release verify` passed for 1.1.6 and 1.1.8, and `verify-asset` passed
  for all eight assets using the new repository name. The historical empty
  immutable v1.1.1 release was preserved.
- Mozilla served the expected icon marker `d0feffd9`. Its recompressed 128px
  PNG differs in bytes but has identical decoded RGBA pixels. Add-on identity,
  name, summary, categories, and versions 1.1.6–1.1.9 source/file/license metadata
  were unchanged, apart from URLs derived from the new slug.
- The new controller recovered the original digest-verified hosted inputs for
  1.1.9 and verified its existing payload/source/license with **five GETs and no
  provider writes**. It returned `awaiting-review`.
- A fresh [hosted resumer](https://github.com/Quince-Pie/tab-gantry/actions/runs/36313215736)
  passed in the renamed repository and correctly dispatched no publisher while
  no approved version needed completion.

The main checkout's existing tracked and untracked edits, including the owner's
SVG, were preserved. Only its shared `origin` configuration changed to
`git@github.com:Quince-Pie/tab-gantry.git`; implementation used an isolated worktree.
Qualification is scoped to this URL/icon migration with retained identities.
Mozilla review remains independent; the migration does not establish listed
approval/publication, default-AMO update delivery or universal optimality.
