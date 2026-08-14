# Working on Facilio Vision 3D

Three of us share this repo. `main` is the release branch — everything arrives
through a pull request.

**New here? Read [ONBOARDING.md](./ONBOARDING.md) first** — it has the full
setup, the platform gotchas and the release procedure. This file is the short
version of the git side.

## One-time setup

```bash
node -v                          # 22.12+ (not 20 — see ONBOARDING §1)
npm install -g @facilio/cli
facilio login
facilio whoami                   # MUST print org #2915 before you do anything

git clone https://github.com/stevegk7/FacilioVibe.git
cd FacilioVibe
npm install
```

You need **write access** to the repo. It belongs to stevegk7 — if `git push`
returns 403, ask him to add you as a collaborator.

## Day-to-day loop

```bash
git switch main && git pull          # always; three people push here
git switch -c <yourname>/<topic>

npm run dev                          # open with ?mock=1

# ...make your change...

npm run verify                       # build + tests + checks + bundle budget
git add -A && git commit -m "..."
git push -u origin <yourname>/<topic>
gh pr create --fill
```

Get one teammate to review, then merge.

Branch naming: `<yourname>/<short-topic>` — e.g. `raj/camera-fov`,
`priya/asset-lookup`. Keeps `git branch -a` readable when three people push.

## Rebase before you open the PR

If your branch was cut before someone else's merge, `git diff main...yours`
shows *their* commits as deletions, and merging it silently reverts their work.
This has happened once already.

```bash
git log <yourbranch>..origin/main    # empty = current
git rebase origin/main               # otherwise
```

## Before you open a PR

- `npm run verify` passes locally (build, 46 test files, both offline checks,
  bundle budget).
- No secrets, API keys or org ids committed.
- You did not invent a connection or action slug — discover them with
  `facilio connections search` / `schemas` / `execute --params` first.
- If you changed an agent's instructions, you ran `node tools/agent-eval/push.mjs
  <agent>` and `node tools/agent-eval/run.mjs <agent>`.

## Deploying — there is no CI

**Merging does not deploy anything.** This repo has no `.github/workflows`; a
release is a person running:

```bash
git switch main && git pull
npm run verify
npm run deploy
```

That publishes to the **preview** URL. Production is a separate manual promote
in Vibe Studio — `facilio vibe deploy --prod` records intent but does not
promote. Production IS live (promoted 2026-08-14), and preview and production
share one database, so a preview write is a production write. See
ONBOARDING.md §5 and §14.
