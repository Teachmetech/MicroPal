# Public release preparation

Goal: publish MicroPal's source in `Teachmetech/MicroPal`, provide complete user documentation and a repeatable production release to GitHub, VS Code Marketplace, and Open VSX (Cursor).

The authenticated GitHub owner is Teachmetech. `production` is the release branch; pull requests must have Conventional Commit titles, complete Unreleased changelog entries, and passing checks. Release automation promotes those detailed notes, calculates the next semantic version, builds one VSIX, and distributes that same artifact. Publishing identities and account agreements must be configured by the account owner; documentation must accurately distinguish prepared automation from a live store listing.

## Work

- [x] Create the public GitHub repository and initialize local Git without committing generated files or private data.
- [x] Add repository metadata, public publisher configuration, a comprehensive logo-bearing README, contribution/security instructions, `.gitignore`, and root `AGENTS.md` changelog requirements.
- [x] Add cross-platform CI, PR/changelog validation, and production release automation with immutable release artifacts and recovery instructions.
- [x] Run local checks, release simulations, package inspection, and independent review.
- [ ] Push and inspect GitHub CI.
- [ ] Configure available repository settings, branch protection, and security reporting; create a GitHub release with the reviewed VSIX.
- [ ] Publish to both stores when their account setup/authentication is available. Report remaining owner-only registration/credential steps precisely.

## Review focus

- Detailed manual changelog notes must be included in the actual public version and not lost during automatic generation.
- Fork PRs must never obtain publishing permissions; only production code can enter publishing jobs.
- A partial store failure must be recoverable using the same GitHub release asset, without changing the version or republishing a different binary.
- The local `micropal-local.micropal` identity must have an explicit migration path to the final public publisher.
- Store availability, Cursor indexing, OS support, and hardware verification must not be claimed before evidence exists.
