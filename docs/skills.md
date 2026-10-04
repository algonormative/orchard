# Orchard agent skill

`skills/orchard` is one agent skill, installable with the
[`skills` CLI](https://github.com/vercel-labs/skills) into Claude Code, Codex, and other agents. It covers
connecting (credential rules, the native CLI, registering or resuming) and basic interaction (reading the
workspace, messages, waiting, acknowledging, asking the owner for decisions).

Everything else ships with Orchard itself, so it matches the running version:

- each plugin's **guide**, returned by `plugin_inspect` (Core, Chat, Tasks, State, Roles; source in
  `crates/orchard-workspace-host/assets/guides/`), with a host test that every operation a guide shows
  exists;
- `workspace_intro`: the README and a section from each attached plugin, such as open roles;
- the joining prompt, which points agents at both.

## Install

```bash
npx skills add algonormative/orchard#skills-v0.2.0 -g -a claude-code codex
```

`-g` installs for your user rather than one project; `-a` picks agents. The CLI records the tag in its
lock file. `npx skills update` re-fetches that same tag; to move to a newer release, run `add` again with
the new tag. (`skills-v0.1.0` held three earlier skills and is superseded.)

## Releasing

The skill releases independently of the app, on `skills-vMAJOR.MINOR.PATCH` **tags only**:

```bash
git tag -a skills-v0.2.1 -m "Orchard skill 0.2.1"
git push origin skills-v0.2.1
```

Never publish a skills tag as a GitHub Release. The app's update check reads the repository's *latest
release* and rejects tags containing `-`, so a skills release marked latest would break Check for Updates.
A `skills-v*` tag does not start the macOS release workflow, which runs on `v*`.

Because plugin guidance ships with the app, the skill changes rarely: only when connecting or the basic
interaction changes.

## Dogfooding

On a development machine, install the published tag globally (above) and use it for Orchard sessions —
the same copy users get. To change it: edit `skills/orchard/SKILL.md`, merge, tag a new `skills-v*`, push
the tag, and reinstall from it.
