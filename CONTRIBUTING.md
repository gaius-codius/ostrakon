# Contributing

Ostrakon is a small, one-person project, so issues and pull requests are welcome but may take a while to get a reply. For anything bigger than a fix, open an issue first so we can agree on the shape before you write it. Ideas already on the list are in [`ROADMAP.md`](ROADMAP.md).

Security problems go through [private vulnerability reporting](https://github.com/gaius-codius/ostrakon/security/advisories/new), not an issue (see [`SECURITY.md`](SECURITY.md)).

## Setting up

You need Claude Code with mods support and [Bun](https://bun.sh). Clone the repo and load the mod from your checkout for one session:

```sh
claude --plugin-dir plugin
```

Or run `./install.sh` (without `--release`) to load it in every session from this checkout. The design, and the platform facts it depends on, are in [`docs/SPEC.md`](docs/SPEC.md); code comments cite it as `SPEC §n`.

## Before a pull request

- `tools/check.sh` runs everything: `claude plugin validate`, the type-check, the mod's tests and the hub's tests. CI runs only the hub's tests, shellcheck and the security scans, because the mod's tests need the `claude` CLI, so run `tools/check.sh` yourself.
- Add a line under **Unreleased** in [`CHANGELOG.md`](CHANGELOG.md) for anything a user would notice.
- Keep to the style around you: short comments that say why, the same naming, and docs in plain, short sentences.
- `main` takes changes only through pull requests, and CI has to pass.

## Releases

Before each release, go through the checklist in [`docs/releasing.md`](docs/releasing.md): mods keep changing, so it re-tests against the current Claude Code and updates the requirements, `ostrakon doctor` and the docs.

Versions follow [Semantic Versioning](https://semver.org/); before 1.0 a minor version may break things. `plugin/.claude-plugin/plugin.json` holds the one version for the whole repo (the mod, the hub and the `ostrakon` command).

1. On an up-to-date `main`: `tools/release.sh prepare 0.2.0`. It makes a `release-v0.2.0` branch with one commit that sets the version and moves the Unreleased notes under 0.2.0.
2. Push the branch, open its pull request and merge it once CI passes.
3. Back on `main`: `tools/release.sh tag`, then `git push origin v0.2.0`. The tag triggers [`.github/workflows/release.yml`](.github/workflows/release.yml), which publishes a GitHub release with that version's changelog notes. `ostrakon update` then moves release installs to it.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
