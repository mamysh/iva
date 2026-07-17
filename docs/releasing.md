# Developer release runbook

A release is evidence attached to one immutable commit. A version number or a working personal VPS is
not enough.

## Prepare

1. Work on a normal branch and finish `npm run verify:pr` plus every change-routed replica gate.
2. Review the capability manifest diff and the `Unreleased` changelog.
3. Resolve P0/P1 defects in install, update, recovery or data safety.
4. Only after technical gates pass, set the candidate version in `package.json`, lockfile, changelog
   and public version surfaces to `X.Y.Z-rc.N`.
5. Commit, then create an annotated immutable tag matching that version: `vX.Y.Z-rc.N`.

`npm run release:check` fails when the tree is dirty, the tag does not point at `HEAD`, or the tag and
package version differ.

## Automated matrix

Run the GitHub `Release candidate matrix` workflow for the candidate tag. It covers:

- PR verification and both build profiles;
- clean Ubuntu local install and reinstall;
- local and PostgreSQL restart/resume;
- local and PostgreSQL update/rollback;
- local and PostgreSQL portable backup/restore;
- PostgreSQL clean bootstrap;
- capability manifest comparison.

The workflow uploads a sanitized JSON report named after the tag. It intentionally leaves live
provider and soak scenarios missing; the final report cannot become complete until their evidence is
added.

## Live provider and vision evidence

On an isolated authenticated host configured for one provider, and only with owner authorization:

```bash
RELEASE_LIVE_CANARY=1 npm run release:provider -- --json
```

Run it for every provider route claimed by the release. It fetches the authenticated model inventory
where available and sends a generated one-pixel PNG through the real vision path. Store only its
sanitized JSON output with the release evidence. Never put API keys or Codex OAuth files in CI
artifacts.

## Seven-day soak

Deploy the exact candidate commit to a production-like single-owner replica. The hourly observability
collector records the commit with every private health sample. Maintain a reviewed JSON incident list,
using `[]` when there were none, then run:

```bash
RELEASE_SOAK_SAMPLES=/private/path/health-metrics.jsonl \
RELEASE_SOAK_INCIDENTS=/private/path/incidents.json \
RELEASE_CANDIDATE_COMMIT=<full-sha> \
npm run release:soak -- --json
```

The gate requires at least seven continuous days, no gap over two hours, one unchanged candidate
commit, healthy samples and zero P0/P1 incidents. Thirty days are required before considering a
different default Workflow backend.

## Fresh-owner acceptance

Before stable, a person who did not build Iva follows [the owner runbook](owner-runbook.md) on a fresh
supported host without oral help from the author. Record only the candidate commit, OS, outcome and
any documentation defect; never collect their credentials or personal data. This scenario cannot be
replaced by the automated clean-install fixture.

## Stable cut

After all required scenarios pass, replace the prerelease version with `X.Y.Z`, update changelog and
public surfaces, rerun the complete matrix on `vX.Y.Z`, then fast-forward the protected `stable`
branch to that exact tag. Publish the release notes plus the stable-channel install command, supported
versions and known limitations. Keep the RC and final JSON reports as release artifacts. Never point
`stable` at an RC or an untagged `main` commit.
