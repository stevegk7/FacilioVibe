# Working on Facilio Vision

Three of us share this repo. `main` is the release branch — anything merged there
gets built and pushed to the Vibe app automatically, so `main` stays protected and
all work arrives through pull requests.

## One-time machine setup

```bash
# Node 20+ required
node -v

# Facilio CLI (binary is `facilio`)
npm install -g @facilio/cli

# Sign in — opens a browser, approve once.
# Use the vibeathon account so you land in org "Facilio Vetri Kazhagam" (#2915).
facilio login
facilio whoami          # confirm the org before you do anything else

git clone https://github.com/RajkumarSenthil02/facilio-vision.git
cd facilio-vision
npm install
```

`facilio whoami` must print org **#2915**. If it prints a different org you are signed
in as the wrong account — `facilio logout`, then `facilio login` again with the
vibeathon credentials. Deploying from the wrong org ships the app somewhere else.

## Day-to-day loop

```bash
git switch main && git pull
git switch -c <yourname>/<short-topic>

npm run dev          # local dev server with hot reload

# ...make your change...

git add -A && git commit -m "..."
git push -u origin <yourname>/<short-topic>
gh pr create --fill      # or open the PR in the browser
```

Get one teammate to review, then merge. The merge triggers the deploy.

Branch naming: `<yourname>/<short-topic>` — e.g. `raj/camera-capture`,
`priya/asset-lookup`. Keeps `git branch -a` readable when three people are pushing.

## Before you open a PR

- `npm run build` succeeds locally.
- No secrets, API keys, or org ids committed.
- You did not invent a connection or action slug — see below.

## Calling Facilio data

`vibe.executeAction(connectionSlug, actionSlug, payload)` is the only supported way
to read Facilio data. Never guess the slugs or the payload shape — discover them:

```bash
facilio connections search "work orders"
facilio connections schemas <slug> --with-output
facilio connections execute <slug> <action> --payload '{...}'   # verify for real
```

Wire it into the app only after the CLI call returns what you expect.

## Deploying by hand

You normally don't need to — merging to `main` does it. If you need a one-off deploy
from your machine:

```bash
npm run build && facilio vibe deploy
```

## How releases actually work

The CI deploy publishes to the app's **preview** environment. That is a platform
rule, not a CI shortcut: `facilio vibe deploy --prod` records intent but does not
bypass preview. Promoting a version to the production URL
(https://facilio-vision.vibe.facilio.com/) is a manual action in the Facilio
platform UI, done by a human on the deployed version.

So: merge to `main` → new preview build, automatically. Production cutover → someone
clicks promote.
