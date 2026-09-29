# Chrome Web Store publishing

**Publish release** submits each release's tested Chrome package to the existing
Chrome Web Store item, next to the Mozilla submission. It uses the
[Chrome Web Store API V2](https://developer.chrome.com/docs/webstore/api) and needs
no stored secret. The job exchanges its GitHub OIDC token, through Google Cloud
Workload Identity Federation, for a short-lived token of the service account
linked to your publisher.

Every procedure below comes from Chrome and Google Cloud documentation, listed in
[Sources](#sources). The Chrome [design and verification record](chrome.md)
covers the package itself.

## Why not the OAuth playground flow

Chrome's [API guide](https://developer.chrome.com/docs/webstore/using-api) also
shows an OAuth client with a refresh token. That flow puts the consent screen in
**External** with test users. Google's
[OAuth documentation](https://developers.google.com/identity/protocols/oauth2#expiration)
says such a project in "Testing" status gets refresh tokens that **expire in 7
days**, which rules them out for unattended releases.

The API [supports service accounts](https://developer.chrome.com/docs/webstore/service-accounts).
Google warns that key files are a risk and
[recommends](https://cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines)
federation because it "eliminates the maintenance and security burden associated
with service account keys". The release job therefore uses federation and creates
no key.

## One-time setup

Only an owner can do these steps; nothing here is automated.

### 1. Developer account and first item

1. [Register](https://developer.chrome.com/docs/webstore/register) the developer
   account and [set it up](https://developer.chrome.com/docs/webstore/set-up-account),
   including the required publisher name and verified contact email. Publishing
   requires [2-step verification](https://developer.chrome.com/docs/webstore/using-api)
   on the Google Account.
2. The API cannot create items, so the first package goes through the
   [Developer Dashboard](https://chrome.google.com/webstore/devconsole):
   **Add new item** → choose the ZIP → **Upload**
   ([Publish in the Chrome Web Store](https://developer.chrome.com/docs/webstore/publish)).
   Use the release's own `tab-gantry-VERSION-chrome.zip`. Download it from that
   run's CI artifacts, or run `npm run build` on the release tag: the build is
   reproducible, with fixed timestamps and file modes, so the SHA-256 matches. New publishers can publish at most two
   extensions at first.
3. Complete the tabs the store requires before publication:
   - [Store listing](https://developer.chrome.com/docs/webstore/cws-dashboard-listing):
     a detailed description, a category, a language, at least one 1280x800
     screenshot and the 440x280 small promo tile
     ([image requirements](https://developer.chrome.com/docs/webstore/images)).
     The 128px icon comes from the package. The
     [branding guidelines](https://developer.chrome.com/docs/webstore/branding)
     require "for Google Chrome™" wording if the listing names Chrome.
   - [Privacy](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy):
     the single purpose, a justification for each permission, remote code, data
     use and a privacy policy. Suggested text is under
     [Privacy tab text](#privacy-tab-text).
   - [Distribution](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution):
     visibility and regions. The API always publishes with the item's current
     visibility; after changing visibility in the dashboard, publish once
     manually before the API can publish again
     ([API guide](https://developer.chrome.com/docs/webstore/using-api)).
4. Press **Submit for Review** for this first version in the dashboard. Later
   versions go through Publish release.
5. Copy the **item ID** from the item's URL or page, and the **publisher ID** from
   **Publisher → Settings** ([API guide](https://developer.chrome.com/docs/webstore/using-api)).

### 2. Google Cloud project and service account

These commands follow
[Configure Workload Identity Federation with deployment pipelines](https://cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines).
The Google guide lists the Workload Identity Pool Admin role (or Owner) and an
active billing account as prerequisites. Replace `PROJECT_ID`, `PROJECT_NUMBER`
and `REPOSITORY_ID`. The repository ID is numeric (`gh api repos/Quince-Pie/tab-gantry --jq .id`);
Google recommends numeric IDs over names, which can be reclaimed.

1. Enable the Chrome Web Store API
   ([Use a service account](https://developer.chrome.com/docs/webstore/service-accounts)).
   Also enable the IAM, Resource Manager, Service Account Credentials and
   Security Token Service APIs, which federation requires. The Chrome Web Store
   service name is taken from its
   [discovery document](https://chromewebstore.googleapis.com/$discovery/rest?version=v2)
   root URL:

   ```sh
   gcloud config set project PROJECT_ID
   gcloud services enable chromewebstore.googleapis.com iam.googleapis.com \
     cloudresourcemanager.googleapis.com iamcredentials.googleapis.com sts.googleapis.com
   ```

2. Create the service account. It needs no project roles:

   ```sh
   gcloud iam service-accounts create chrome-web-store \
     --display-name="Tab Gantry Chrome Web Store publisher"
   ```

3. In the Developer Dashboard, **Account** section, add
   `chrome-web-store@PROJECT_ID.iam.gserviceaccount.com`. A publisher can link one
   service account.
4. Create a pool and a GitHub provider that accepts only this repository's `main`
   runs:

   ```sh
   gcloud iam workload-identity-pools create tab-gantry --location=global \
     --display-name="Tab Gantry releases"
   gcloud iam workload-identity-pools providers create-oidc github --location=global \
     --workload-identity-pool=tab-gantry \
     --issuer-uri="https://token.actions.githubusercontent.com/" \
     --attribute-mapping="google.subject=assertion.sub,attribute.repository_id=assertion.repository_id" \
     --attribute-condition="assertion.repository_id=='REPOSITORY_ID' && assertion.ref=='refs/heads/main'"
   ```

   Keep the provider's default audiences. The job requests a token for the
   provider's own resource name, which a provider without explicit audiences
   [accepts](https://cloud.google.com/iam/docs/reference/rest/v1/projects.locations.workloadIdentityPools.providers).
   The condition admits any job of this repository on `main` that requests an
   OIDC token. A workflow test keeps `id-token: write` on the environment-gated
   Chrome job alone.

5. Allow only identities from that repository to impersonate the service account:

   ```sh
   gcloud iam service-accounts add-iam-policy-binding \
     chrome-web-store@PROJECT_ID.iam.gserviceaccount.com \
     --role=roles/iam.workloadIdentityUser \
     --member="principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/tab-gantry/attribute.repository_id/REPOSITORY_ID"
   ```

### 3. GitHub environment

1. Run `node scripts/release/repository-policy.js --repository=Quince-Pie/tab-gantry --apply`
   with an administrator token. It creates the `release-chrome-web-store`
   environment and limits deployments to `main`.
2. Store the four identifiers as environment **variables**. None is a secret:

   ```sh
   gh variable set CWS_PUBLISHER_ID --env release-chrome-web-store --body PUBLISHER_ID
   gh variable set CWS_ITEM_ID --env release-chrome-web-store --body ITEM_ID
   gh variable set CWS_WORKLOAD_IDENTITY_PROVIDER --env release-chrome-web-store \
     --body projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/tab-gantry/providers/github
   gh variable set CWS_SERVICE_ACCOUNT --env release-chrome-web-store \
     --body chrome-web-store@PROJECT_ID.iam.gserviceaccount.com
   ```

Until the variables exist, the Chrome job reports **not configured** and succeeds.
Firefox releases are unaffected. A partial configuration fails.

## What each release does

The **Submit to the Chrome Web Store** job runs after CI has tested the exact
Chrome ZIP in Chrome 154 and at the declared minimum, Chrome 148. Tagging must
also have succeeded. The job runs in parallel with Mozilla signing and never
gates the GitHub Release. It has read access plus `id-token: write`, runs
reviewed controller code only, and installs no npm packages.

1. It verifies the staged ZIP against the tested digest.
2. It obtains a 30-minute store token through
   [STS](https://cloud.google.com/iam/docs/reference/sts/rest/v1/TopLevel/token) and
   [generateAccessToken](https://cloud.google.com/iam/docs/reference/credentials/rest/v1/projects.serviceAccounts/generateAccessToken).
3. It reads [fetchStatus](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/fetchStatus).
   A version already submitted, staged or published needs no write.
4. Otherwise it [uploads](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/media/upload)
   the ZIP and waits for processing. It then
   [publishes](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/publish)
   with `DEFAULT_PUBLISH`, so the version goes live automatically once approved,
   with the dashboard's visibility and rollout settings.
5. It checks the release tag before each write, and reads the status back to
   confirm the submission.

Store notices are shown as run annotations and in the summary, as they would be
in the dashboard, without blocking submission. These include a policy warning on
the item and any warnings returned by `publish`. The summary credits the tested
SHA-256 only when that run uploaded the package itself.

Review usually takes a few days and can take a few weeks
([review process](https://developer.chrome.com/docs/webstore/review-process)).
A pending review ends the job green: publication then needs nothing further.
Rejections and takedowns arrive by email, which the store sends by default
([check review status](https://developer.chrome.com/docs/webstore/check-review)).

## Recovery

| Result or error | Meaning and action |
| --- | --- |
| `not-applicable` | The release source predates Chrome support. Nothing to submit. |
| `not-configured` | Complete the setup above, then rerun Publish release for the tag. |
| `awaiting-review` / `staged` | Submitted. A staged version was deferred manually; publish it from the dashboard within 30 days ([Publish](https://developer.chrome.com/docs/webstore/publish)). |
| `superseded` | The item already has a newer version, including one that was rejected or cancelled; this one is never submitted after it. |
| `blocked-by-pending-review` | Another version is still in review. Wait and rerun, or dispatch Publish release with `chrome-supersede` set to exactly that version to [cancel its review](https://developer.chrome.com/docs/webstore/cancel-review) first. The store allows six cancellations per day. |
| `needs-attention` | The store rejected this version, or its review was cancelled. The job never resubmits either; read the email or the item's Status tab and release a fixed version. |
| Upload refused | The store's message is shown. If the first version was uploaded in the dashboard, submit it there; the job then reconciles it. Each new version must be higher than the previous one ([Update](https://developer.chrome.com/docs/webstore/update)). |
| `invalid_grant` from STS | The provider name, attribute condition or audience does not match the running workflow. |
| `PERMISSION_DENIED` from generateAccessToken | The `roles/iam.workloadIdentityUser` binding for the repository is missing. |
| HTTP 403 from the store | The service account is not linked in the Developer Dashboard. |

A version already live can be reverted with the dashboard's
[rollback](https://developer.chrome.com/docs/webstore/rollback), which republishes
the previous version under a new version number and discards pending
submissions. The release controller never rolls back automatically.

To submit from a workstation instead, get a one-hour token by
[impersonating the service account](https://developer.chrome.com/docs/webstore/service-accounts).
This requires `roles/iam.serviceAccountTokenCreator`. Then run the controller
against staged inputs:

```sh
nix develop .#release
export CWS_ACCESS_TOKEN=$(gcloud auth print-access-token \
  --impersonate-service-account=chrome-web-store@PROJECT_ID.iam.gserviceaccount.com \
  --scopes=https://www.googleapis.com/auth/chromewebstore)
CWS_PUBLISHER_ID=… CWS_ITEM_ID=… RELEASE_TAG=vX.Y.Z RELEASE_COMMIT=… \
  GITHUB_REPOSITORY=Quince-Pie/tab-gantry GH_TOKEN="$(gh auth token)" \
  node scripts/release/chrome-submit.js
```

## Privacy tab text

Suggested wording, consistent with the package; adjust as you see fit:

- **Single purpose:** Groups tabs opened from links with the tab that opened
  them, in the browser's native tab groups, and gives new groups a readable name.
- **tabGroups:** Create and join native tab groups for related tabs, name new
  groups, and list group names in the toolbar popup.
- **webNavigation:** Identify which tab a link opened a new tab from. No URL or
  page content is read, stored or sent.
- **storage:** Keep a short, session-only list of recently generated group names
  so new names stay distinct. Private windows keep a separate list that is
  removed when the window closes.
- **Remote code:** No.
- **Data usage:** No user data is collected or transmitted.

## Optional hardening not enabled

[Verified CRX uploads](https://developer.chrome.com/docs/webstore/update) require
every package to be a CRX signed with a private key you hold. That would put a
long-lived key back into the release job, so the controller uploads ZIPs. Do not
opt in unless the job is changed to sign packages.

## Sources

Chrome: [API](https://developer.chrome.com/docs/webstore/api),
[using the API](https://developer.chrome.com/docs/webstore/using-api),
[service accounts](https://developer.chrome.com/docs/webstore/service-accounts),
[REST reference](https://developer.chrome.com/docs/webstore/api/reference/rest),
[register](https://developer.chrome.com/docs/webstore/register),
[set up account](https://developer.chrome.com/docs/webstore/set-up-account),
[prepare](https://developer.chrome.com/docs/webstore/prepare),
[publish](https://developer.chrome.com/docs/webstore/publish),
[update](https://developer.chrome.com/docs/webstore/update),
[listing](https://developer.chrome.com/docs/webstore/cws-dashboard-listing),
[privacy](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy),
[distribution](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution),
[images](https://developer.chrome.com/docs/webstore/images),
[branding](https://developer.chrome.com/docs/webstore/branding),
[review process](https://developer.chrome.com/docs/webstore/review-process),
[check review](https://developer.chrome.com/docs/webstore/check-review),
[cancel review](https://developer.chrome.com/docs/webstore/cancel-review),
[rollback](https://developer.chrome.com/docs/webstore/rollback),
[permission warnings](https://developer.chrome.com/docs/extensions/reference/permissions-list).
Google Cloud and Identity:
[federation for deployment pipelines](https://cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines),
[pool providers](https://cloud.google.com/iam/docs/reference/rest/v1/projects.locations.workloadIdentityPools.providers),
[STS token](https://cloud.google.com/iam/docs/reference/sts/rest/v1/TopLevel/token),
[generateAccessToken](https://cloud.google.com/iam/docs/reference/credentials/rest/v1/projects.serviceAccounts/generateAccessToken),
[OAuth 2.0 refresh token expiration](https://developers.google.com/identity/protocols/oauth2#expiration).
Pages were read on 2026-09-29.
