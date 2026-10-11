# MicroPal agent instructions

Every agent working in this repository must read this file before editing. It applies to the entire repository. Read any more specific instructions in the directory you change, and follow the user's current request when it overrides these defaults.

## Changes and changelogs

- Every change intended to go live must have a complete entry under `## [Unreleased]` in `CHANGELOG.md` before it is merged to `production`.
- Record **everything changed** in that delivery: features, fixes, behavior changes, configuration, dependency updates, documentation, release automation, and security changes. Describe the effect on users or maintainers, migration steps, and material limitations. A vague entry such as “miscellaneous fixes” is insufficient.
- Keep entries under Added, Changed, Fixed, Removed, or Security as appropriate. Update an entry when its scope changes; do not leave abandoned approaches in release notes.
- Pull requests must describe their changes and validation and include the changelog update. CI checks changelog coverage; agents must still review completeness because automation cannot infer every user-visible effect.
- Use Conventional Commit PR titles/commits (`feat:`, `fix:`, `docs:`, `chore:`, `ci:`, `test:`, `refactor:`, `perf:`, `build:`, `style:`, `revert:`). Mark breaking changes with `!` and explain migration in the changelog.
- Release automation owns public versions, tags, GitHub Releases, and promotion of Unreleased notes into a dated version section. Do not hand-edit a published version or delete historical release notes. A released correction gets a new version and changelog entry.
- Do not claim a change is live until its release and relevant store publication have actually succeeded. Distinguish GitHub availability, VS Code Marketplace publication, and Open VSX/Cursor availability.

## Development and verification

- Keep serial ownership, cancellation, and state transitions in `DeviceManager`; subprocess argument/lifecycle handling in transport; editor APIs in UI modules. Read `docs/architecture.md` before changing these boundaries.
- Reproduce meaningful behavior changes with tests. Run `npm run check` and the release checks relevant to the change. Record exactly what passed and what was not tested; hardware and OS compatibility require their own evidence.
- After each completed change, run `npm run package:local` and provide a clickable absolute path to the resulting VSIX so the user can test in Cursor/VS Code. Package the final source after validation and inspect the packaged manifest/bundle. Use the unique local version produced by this command; do not bump tracked public versions, replace a published artifact, commit VSIX files, or install into the user's editor without a request.
- Preserve literal executable/argument arrays, session-bound device URIs, staged writes, workspace trust checks, no automatic replay after reconnection, and explicit confirmation for firmware flashing and external-process termination.
- Managed tool installation requires an explicit setup/repair action. Never install globally, download on activation, add telemetry, or silently flash hardware.
- Never commit secrets, local Python environments, firmware dumps, private device data, generated VSIX packages, or serial logs. Review `.gitignore` and the staged diff before pushing.

## Releases

- `production` is the public release branch. Work in short-lived branches and use reviewed pull requests with passing checks. Squash merges must preserve the Conventional Commit PR title.
- Read `docs/releasing.md` before changing workflows, release configuration, publisher identity, authentication, or packaging.
- Preserve one immutable VSIX per release for GitHub and both stores. Never rebuild a different artifact under an existing public version or overwrite a tag.
- Keep workflow permissions and publishing credentials confined to production release jobs. Pull-request checks must not receive publishing secrets or privileged tokens.

## Documentation

- Keep README commands, settings, screenshots/logo, installation steps, and known limits aligned with the implementation.
- Do not invent publisher ownership, store listings, badges, passing CI, or hardware acceptance. Link to the real repository and verified sources.
