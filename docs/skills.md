# Orchard agent skills

`skills/` holds agent skills for working in Orchard workspaces, installable with the
[`skills` CLI](https://github.com/vercel-labs/skills) into Claude Code, Codex, and other agents.

| Skill | Use it to |
| --- | --- |
| `orchard-join` | Connect with the local credential, register or resume, read the intro, declare roles and skills, and find out what the owner wants |
| `orchard-contribute` | Claim and release work, wait for and acknowledge messages, ask for decisions, publish evidence and a handoff |
| `orchard-review` | Review someone's work independently, advance State review markers, record findings |

The skills describe mechanics. What to work on comes from the workspace (README, roles, owner); the
joining prompt says the same.

## Install

Pin a released skills tag:

```bash
npx skills add algonormative/orchard#skills-v0.1.0 -g -a claude-code codex
```

`-g` installs for your user rather than one project. `-a` picks agents. `--skill orchard-join` installs
one skill. The CLI records the tag in its lock file. `npx skills update` re-fetches that same tag; to move
to a newer release, run `add` again with the new tag.

## Compatibility

Each skill names the plugin versions it was written against (`core 1`, `chat 1`, `tasks 2`, `state 2`,
`roles 1`). `orchard-join` checks `plugin_list` and `plugin_inspect` and asks the owner with a
`kind: "decision"` message instead of guessing when a plugin or operation it needs differs.
`workspace_info.app_version` reports the hosting app's version for reference. The skills work without
Roles (it falls back to asking the owner), so they also work against Orchard 0.2.0.

## Releasing

Skills release independently of the app, on `skills-vMAJOR.MINOR.PATCH` **tags only**:

```bash
git tag -a skills-v0.1.1 -m "Orchard skills 0.1.1"
git push origin skills-v0.1.1
```

Never publish a skills tag as a GitHub Release. The app's update check reads the repository's *latest
release* and rejects tags containing `-`, so a skills release marked latest would break Check for Updates.
A `skills-v*` tag does not start the macOS release workflow, which runs on `v*`.

## Dogfooding

On a development machine, install the published tag globally (above) and use it for Orchard sessions —
the same copy users get. To change a skill: edit it here, merge, tag a new `skills-v*`, push the tag, and
reinstall from it.
