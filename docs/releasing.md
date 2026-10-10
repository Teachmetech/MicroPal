# Releasing MicroPal

`production` is the public release branch. Squash a reviewed pull request with a Conventional Commit title after `Release policy` and all three `Check` jobs pass. Every change needs a complete bullet under `## [Unreleased]` in `CHANGELOG.md`, including documentation, dependencies, configuration, and automation. CI checks that an entry was added; reviewers check that it describes everything being delivered.

## What a production merge does

The [CI and Release workflow](../.github/workflows/ci-release.yml) runs typechecking, lint, tests, and a build on Linux, macOS, and Windows with Node.js 22. Only a production push whose checks pass can run the release job. Pull-request jobs have read-only repository access and receive no publishing secrets.

`semantic-release` calculates the next version from all commits since the last release tag: `feat` produces a minor release, `!` or a `BREAKING CHANGE` footer produces a major release, and `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `style`, and `revert` produce patch releases. All supported types appear in generated notes. Squash merging preserves the checked PR title; merge commits and nonconventional titles are not supported by this release policy.

The release promotes the complete human Unreleased section into a dated version section, combines it with generated commit notes, and leaves an empty Unreleased section for the next change. It updates `package.json` and `package-lock.json`, builds one versioned VSIX, and commits the version and changelog with `chore(release): VERSION [skip ci]`. Historical changelog entries are retained. The tag points at this release commit.

GitHub receives a Release containing the VSIX, complete `CHANGELOG.md`, `CHECKSUMS.sha256`, and `release-manifest.json`. The manifest records the triggering production commit, extension identity, version, tag, and VSIX SHA-256. The independent VS Code Marketplace and Open VSX jobs download that GitHub asset and validate its bytes and packaged manifest before publishing. They never rebuild it.

The repository starts with the local-development baseline tag `v0.2.1`. The initial public infrastructure commit uses `feat`, so the first public release is `0.3.0`. Keep the baseline tag: without an existing release tag, semantic-release would normally choose `1.0.0`; MicroPal rejects that uninitialized state instead.

## One-time GitHub configuration

1. Set repository Actions variable `EXTENSION_PUBLISHER` to the exact, case-sensitive registered publisher in `package.json` (currently `teachmetech`). Both registries must use this same identity, `teachmetech.micropal`. A local or mismatched publisher stops the GitHub release.
2. Create the GitHub environment `production`, restrict its deployment branches to `production`, and leave required reviewers disabled for unattended releases. Both publishing jobs use this environment. Environment branch restrictions are particularly important for Open VSX trusted publishing.
3. Allow Actions to create repository contents with its job-scoped `GITHUB_TOKEN`. The release job requests only `contents: write`; publishing jobs request `contents: read` and `id-token: write`. No custom GitHub PAT is needed in the initial configuration.
4. Keep production protected against force pushes and deletion and require linear history. Review PRs and their checks before squashing. The initial rules permit the release bot's version/changelog commit. If stronger rules later require PRs or status checks on every production update, configure a dedicated GitHub App installation token and its explicit ruleset bypass for release commits. Do not temporarily disable protection to release. `GITHUB_TOKEN` cannot bypass a required-PR rule by itself.

This workflow intentionally keeps the GitHub release available if a store has not been configured or fails. A successful GitHub release does not imply either store publication succeeded.

## VS Code Marketplace authentication

Create the Marketplace publisher and ensure the publishing identity has its Contributor permission. Set up Microsoft Entra workload identity using [VS Code's secure publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#secure-automated-publishing-to-visual-studio-marketplace) and [Microsoft's GitHub OIDC instructions](https://learn.microsoft.com/en-us/azure/developer/github/connect-from-azure-openid-connect).

Configure GitHub Actions variables `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, and `AZURE_SUBSCRIPTION_ID`. Setting `AZURE_CLIENT_ID` selects Azure authentication: the pinned `azure/login` action obtains a short-lived credential, and `vsce publish --azure-credential --packagePath ...` uploads the verified VSIX. Bind the Entra federated credential to this repository's `production` environment. Use the repository's actual OIDC subject; newly created repositories can include immutable owner/repository IDs, so do not copy an old `repo:OWNER/REPO:...` example blindly. See [GitHub's immutable subject documentation](https://docs.github.com/en/actions/reference/security/oidc#immutable-subject-claims).

As a bootstrap fallback, leave `AZURE_CLIENT_ID` unset and store an appropriately scoped Marketplace publishing token in the `VSCE_PAT` Actions secret. Never put it in source or command arguments. Global Azure DevOps PATs retire on **December 1, 2026**; prefer Entra authentication and follow the current official guide when provisioning credentials. If neither authentication method is configured, only the Marketplace job fails with an explicit setup message.

## Open VSX and Cursor

Create an Open VSX account, accept the publisher agreement, create the exact-case `teachmetech` namespace, and complete the [namespace ownership process](https://github.com/EclipseFdn/open-vsx.org/wiki/Managing-Namespaces). For the first publication, create an Open VSX access token and save it as the `OVSX_PAT` Actions secret. Leave `OVSX_TRUSTED_PUBLISHING` unset or `false`. The first upload requires a token because trusted publishing needs an active extension version.

After the namespace is verified and the extension has an active version, register this GitHub repository, workflow filename `ci-release.yml`, and environment `production` as an Open VSX trusted publisher. Then set Actions variable `OVSX_TRUSTED_PUBLISHING=true`; the CLI uses `--trusted-publishing` and the job's short-lived OIDC credential. Remove the bootstrap PAT when the new method is verified. Open VSX trust rules do not themselves restrict the Git ref, so retain the GitHub environment's production-only deployment branch rule. Follow the [Open VSX trusted publishing guide](https://github.com/eclipse-openvsx/openvsx/wiki/Trusted-Publishing) and [CLI documentation](https://github.com/eclipse-openvsx/openvsx/tree/main/cli#publish-extensions).

Cursor discovers extensions through its [Open VSX-backed registry](https://prod.cursor.com/help/customization/extensions). Registry publication and editor search availability are distinct: verify the actual Open VSX listing and then Cursor search before claiming that the update is available there. A GitHub VSIX can also be installed manually in VS Code or Cursor.

## Failed jobs and safe retries

Use **Re-run failed jobs** after correcting a failed store's credentials or service problem. The successful other store is independent. A store retry downloads the original GitHub asset and checks its source, identity, version, and checksum again. The workflow does not use duplicate-skipping options because an existing version with unknown bytes must not be silently accepted.

Re-running all jobs after a complete GitHub release reuses the existing tag and its verified assets in the GitHub job. Store jobs that already published successfully will fail on an occupied version, so **Re-run failed jobs** is the intended retry. The recovery check requires that the release tag point to the original source commit or the single release-bot commit directly following it. It never moves a tag, overwrites an asset, or publishes a different VSIX under an existing version.

If the tag exists but the GitHub Release or required assets are missing, the run stops. The release job backs up the prepared VSIX, manifest, checksums, notes, and changelog as an Actions artifact named `release-candidate-RUN_ID-ATTEMPT`, retained for 90 days even when GitHub publication fails. Download this artifact from the original run. Verify it on Linux or macOS with `EXTENSION_PUBLISHER=teachmetech node scripts/release-verify.mjs RECOVERED_DIRECTORY vVERSION ORIGINAL_PRODUCTION_SHA`; confirm that the tag's release commit has that source SHA as its sole parent. If no GitHub Release exists, create it using `gh release create vVERSION --verify-tag --title vVERSION --notes-file RECOVERED_DIRECTORY/release-notes.md` and the recovered VSIX, manifest, checksums, and changelog as assets. For a partially created Release, upload only missing recovered assets with `gh release upload`; never use `--clobber`. Re-run failed jobs after the assets are complete.

Never rebuild a new VSIX with an occupied version or delete/move its tag. If the original artifact cannot be recovered, make a new Conventional Commit and release a new version. If a registry already accepted the version but the publishing job lost its response, verify that registry's actual version and artifact before treating the job as successful; retrying an occupied version fails instead of overwriting it.

If a newer production push arrives before an older release calculates its version, semantic-release can defer the older run; the next checked production run includes all unreleased commits and human notes. Production releases are serialized to avoid concurrent version/tag races.

## Local checks

Run `npm run check` before opening a release-related PR. `npm test -- test/release.test.mjs` exercises title/changelog policy, historical-note preservation, publisher checks, and rejection of mismatched release metadata or bytes. `npm run package` creates a local VSIX using the manifest version; it does not publish or create a release. Public release and store scripts require a production push context in GitHub Actions.

On October 9, 2026, `npm audit --omit=dev` reported no production dependency vulnerabilities. The development toolchain had 17 findings involving release-tool glob matching and npm's bundled dependencies without a compatible patched update. Release patterns are fixed in reviewed configuration, publishing credentials exist only in production jobs, and PR checks execute without those credentials. CI audits production dependencies; maintainers should also review the full development audit when updating release tools. Avoid forced major overrides that change semantic-release or packaging dependencies without testing the complete release flow.
