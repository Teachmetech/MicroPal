# Register the MicroPal publishers

Use **`teachmetech`** on both registries. MicroPal's configured extension ID is **`teachmetech.micropal`**; its displayed product name remains **MicroPal**. Registration on one registry does not register the other. These IDs are proposed until the account owner completes registration. If either registry refuses this ID, choose one available in both and update the manifest, repository variable, tests, and documentation before publishing a new release.

## 1. VS Code Marketplace

1. Open [publisher management](https://marketplace.visualstudio.com/manage) and sign in with the Microsoft account that will own MicroPal.
2. Select **Create publisher**. Enter **ID: `teachmetech`**, **Name: Teach Me Tech**, and your contact information. Review the terms and create the publisher. The ID is permanent; the name is its public label.
3. Configure automated publishing using the identity steps below. Publisher registration and publishing authentication are separate tasks.

Microsoft documents these controls in its [publisher guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#create-a-publisher).

### Recommended authentication: Microsoft Entra

Create an Azure user-assigned managed identity and configure a GitHub federated credential for this repository's **production environment**. Give it the required Azure subscription access, then authorize the identity as a **Contributor** on the Marketplace publisher. Follow [Microsoft's Marketplace identity guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#secure-automated-publishing-to-visual-studio-marketplace) and the [GitHub-to-Azure federation instructions](https://learn.microsoft.com/en-us/azure/developer/github/connect-from-azure-openid-connect). Marketplace membership uses the identity returned by the Azure DevOps profile API; do not substitute its client ID.

In [MicroPal's Actions variables](https://github.com/Teachmetech/MicroPal/settings/variables/actions), add `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, and `AZURE_SUBSCRIPTION_ID`. This selects the workflow's Azure authentication. Use the actual GitHub OIDC subject for the new repository when registering federation; [GitHub's subject format](https://docs.github.com/en/actions/reference/security/oidc#immutable-subject-claims) can include immutable IDs.

### Temporary bootstrap option: PAT

If Entra is not set up yet, use the same Microsoft account in [Azure DevOps](https://dev.azure.com/). Create an organization if needed, then go to **User settings → Personal access tokens → New Token**. Select **All accessible organizations** and **Custom defined → Show all scopes → Marketplace → Manage**. Choose a short expiration and save the token as GitHub secret **`VSCE_PAT`**. Leave `AZURE_CLIENT_ID` unset for this mode. Microsoft retires global PATs on **December 1, 2026**; transition to Entra before then. See [Microsoft's PAT instructions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#get-a-personal-access-token).

## 2. Open VSX for Cursor

1. [Create an Eclipse account](https://accounts.eclipse.org/user/register). Set its GitHub username to **Teachmetech**, matching the GitHub account you use below.
2. Sign into [Open VSX](https://open-vsx.org/) with GitHub. Open **avatar → Settings → Profile**, select **Log in with Eclipse**, and link the accounts.
3. Open **Show Publisher Agreement**, read it, and accept it yourself if you agree.
4. Under **Settings → Access Tokens**, select **Generate New Token**. Name it `MicroPal GitHub production` and save its value as GitHub secret **`OVSX_PAT`**. The value is shown once.
5. Create the exact lowercase namespace using the CLI below. Add `OVSX_PAT` to GitHub and retry the prepared Open VSX publishing job for the first upload.
6. After that upload, [request namespace ownership](https://github.com/EclipseFdn/open-vsx.org/wiki/Managing-Namespaces), linking the public MicroPal repository and showing access to the matching Marketplace publisher. The requesting GitHub account must have at least one year of history. If the matching Marketplace extension causes Open VSX to hold the upload under review, request admin review and ownership; do not upload different bytes under that version.

These account and token steps follow the [Open VSX publishing guide](https://github.com/EclipseFdn/open-vsx.org/wiki/Publishing-Extensions). The account owner must personally accept its agreement.

From a checked-out MicroPal repository after `npm ci`, use Bash (including Git Bash on Windows; run `bash` first if your terminal uses another shell):

```bash
read -r -s -p 'Open VSX access token: ' OVSX_PAT
export OVSX_PAT
npx --no-install ovsx create-namespace teachmetech
unset OVSX_PAT
```

The prompt hides the token and keeps it out of command history. Namespace creation does not upload the extension. Leave Actions variable `OVSX_TRUSTED_PUBLISHING` unset for the first upload. After an active version and verified namespace exist, [trusted publishing](https://github.com/eclipse-openvsx/openvsx/wiki/Trusted-Publishing) can replace the token; see [release operations](releasing.md).

## 3. Connect the accounts to the prepared release

Add tokens through **GitHub repository → Settings → Environments → production → Environment secrets → Add secret**. Use the exact names `VSCE_PAT` and `OVSX_PAT`. Azure identifiers belong in Actions variables. `EXTENSION_PUBLISHER=teachmetech` and the production-only environment restriction are already configured. Keep tokens in these settings; do not paste them into issues, chat, commits, or documentation.

When the publisher accounts, namespace, and authentication are ready, open the latest [CI and Release run](https://github.com/Teachmetech/MicroPal/actions/workflows/ci-release.yml) and select **Re-run failed jobs**. The store jobs publish the original GitHub VSIX. Complete Open VSX ownership and any review after its bootstrap upload, before switching to trusted publishing. Later reviewed merges into `production` automatically version, document, package, and publish new releases. Confirm each registry listing and then Cursor search; indexing may follow publication.
