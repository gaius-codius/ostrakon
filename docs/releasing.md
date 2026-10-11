# Releasing

A checklist for each release. Ostrakon is built on Claude Code mods, which are still changing, so
most of this is about re-checking what the platform does now rather than trusting what it did last
time. The steps that actually cut the release are at the end, and in [`CONTRIBUTING.md`](../CONTRIBUTING.md#releases).

## 1. Re-test with the current Claude Code

- Update Claude Code, then run `tools/check.sh`. It validates the mod and runs the type-check and
  every test against the `claude` you have, so a change in the mods interface usually shows up here
  first.
- Use it for real in a session: capture with `/jot` and `//`, open the pane with `ctrl+x s`,
  pull a note in from the pocket, and let harvest run once. The tests can't see everything the
  terminal draws.
- Run `ostrakon doctor` and fix anything it marks. Its "the mod in a session" part should name the
  Claude Code version you just used, with no problems listed.

## 2. Check what changed in mods

- Read the Claude Code changelog and the [mods docs](https://code.claude.com/docs/en/plugins/mods/overview)
  since the last release, looking for anything ostrakon uses: hooks, the pane and band, keybinding
  actions, `userConfig`, the test kit.
- [`docs/SPEC.md`](SPEC.md) §2 lists the platform facts the design depends on. If one of them has
  changed, update §2 and the code that relies on it (comments cite it as `SPEC §2.n`).
- The keybindings in the README borrow existing Claude Code actions. Check those action names
  still exist.

## 3. Update what names versions or requirements

- [`bin/tested-with`](../bin/tested-with): the Claude Code and Bun versions you just tested with.
  `ostrakon doctor` compares people's versions to these.
- The README's **Requirements** section: the same versions, and anything newly needed or no longer
  needed. `tools/release.sh prepare` refuses to continue if the README and `bin/tested-with` name
  different versions.
- `ostrakon doctor` ([`bin/doctor`](../bin/doctor)): if this release adds a setting, a dependency,
  or a new way for setup to go wrong, add a check for it.

## 4. Update the docs

- [`CHANGELOG.md`](../CHANGELOG.md): everything a user would notice is under **Unreleased**,
  in plain words.
- The README, [`docs/phone.md`](phone.md) and `docs/SPEC.md` describe what the release does, not
  what the last one did.
- Screenshots in the README, if the pane, the band or the phone app look different:
  `tools/screens/readme.sh` takes both again, on the same fixture notes.
- [`ROADMAP.md`](../ROADMAP.md): take out anything this release built.

## 5. Cut it

1. On an up-to-date `main`: `tools/release.sh prepare <x.y.z>`, then push the branch and merge its
   pull request once CI passes.
2. Back on `main`: `tools/release.sh tag`, then `git push origin v<x.y.z>`. The release workflow
   publishes the GitHub release from the changelog.
3. On a machine with a release install, run `ostrakon update` and `ostrakon doctor` to see it land.

People who installed the mod with `claude plugin install` get the new version once `prepare`'s
version change reaches `main`: Claude Code only copies a plugin again when `plugin.json`'s version
changes.
