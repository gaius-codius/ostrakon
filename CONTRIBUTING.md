# Contributing

Ostrakon is a small, one-person project. Issues and pull requests are welcome, but a reply may take a while. For anything bigger than a fix, please open an issue first, so we can agree on the approach before you write the code. Ideas already on the list are in [`ROADMAP.md`](ROADMAP.md).

Security problems go through [private vulnerability reporting](https://github.com/gaius-codius/ostrakon/security/advisories/new), not an issue (see [`SECURITY.md`](SECURITY.md)).

## Setting up

You need a Claude Code version with mods support, and [Bun](https://bun.sh). Clone the repo, then load the mod from your checkout for one session:

```sh
claude --plugin-dir plugin
```

Or run `./install.sh` (without `--release`) to load it from this checkout in every session.

How it all works, and the Claude Code behaviour it relies on, is written up in [`docs/SPEC.md`](docs/SPEC.md). Code comments point into it as `SPEC §n`.

## Before you open a pull request

- Run `tools/check.sh`. It runs everything: `claude plugin validate`, the design check, the type-check, the mod's tests, the hub's tests, the phone tests in WebKit ([`tools/phone`](tools/phone/README.md), which want Docker) and the code-quality checks. CI doesn't run the mod's tests (they need the `claude` CLI), or type-check the files that use the engine's types (`plugin/hooks`, `plugin/tests`, `plugin/src/ui/*.tsx`, `plugin/src/focus.ts`): those declarations are written only when a logged-in Claude Code session loads the mod. So this step is on you. CI runs the rest, including the type-check of the hub and the rest of the mod (`cd server && bun install && bun run typecheck`).
- The code-quality checks are `tools/lint.sh` on their own, in about a second: [Biome](https://biomejs.dev) formats and lints the TypeScript, JavaScript, JSON and CSS, shellcheck the shell scripts, actionlint the workflows, typos the spelling, and lychee the links between the docs. The tools and their versions are in `mise.toml`: install [mise](https://mise.jdx.dev), then `mise install`. `tools/lint.sh --fix` lets Biome format your changes and fix what it safely can.
- To run them before every commit: `git config core.hooksPath tools/hooks` (skip once with `git commit --no-verify`).
- `git blame` skips the one big reformat if you run `git config blame.ignoreRevsFile .git-blame-ignore-revs` once (GitHub does it already).
- Add a line under **Unreleased** in [`CHANGELOG.md`](CHANGELOG.md) for anything a user would notice.
- Match the style around you: short comments that explain why, the same naming, and docs in plain, short sentences.
- Changes reach `main` only through pull requests, and CI has to pass first.

## Changing the design

[`docs/DESIGN.md`](docs/DESIGN.md) is what the pane and the phone agree on: colours, symbols, fixed copy, motion. To change any of it:

1. Change the code and the doc's tables in the same commit.
2. Bump `Version:` at the top (major when a meaning changes or something goes, minor when something is added, patch for a tweak).
3. Add an entry at the top of its changelog with `- Change:` and `- Why:` lines, and `Fingerprint:` set to what `bun tools/check-design.ts --fingerprint` prints.

`tools/check.sh` and CI fail until the doc matches the code and the change is logged.

## Releases

Before each release, go through the checklist in [`docs/releasing.md`](docs/releasing.md): mods keep changing, so it re-tests against the current Claude Code and updates the requirements, `ostrakon doctor` and the docs.

Versions follow [Semantic Versioning](https://semver.org/); before 1.0, a minor version may break things. There is one version for the whole repo (the mod, the hub and the `ostrakon` command), kept in `plugin/.claude-plugin/plugin.json`.

1. On an up-to-date `main`, run `tools/release.sh prepare 0.2.0`. It makes a `release-v0.2.0` branch with one commit that sets the version and moves the Unreleased notes under 0.2.0.
2. Push the branch, open a pull request for it, and merge once CI passes.
3. Back on `main`, run `tools/release.sh tag`, then `git push origin v0.2.0`. Pushing the tag runs [`.github/workflows/release.yml`](.github/workflows/release.yml), which publishes a GitHub release with that version's changelog notes. From then on, `ostrakon update` moves release installs to it.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
