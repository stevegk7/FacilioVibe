# Facilio Vision — team setup

Vibeathon 2026. Three of us, one repo, one deployed app.

| | |
|---|---|
| Repo | https://github.com/RajkumarSenthil02/facilio-vision |
| App | https://facilio-vision.vibe.facilio.com/ |
| Org | Facilio Vetri Kazhagam (**#2915**), region US |
| Stack | React 18 + Vite + `@facilio/vibe-sdk` |

## 1. Set up your machine (once)

```bash
node -v                          # must be 20+
npm install -g @facilio/cli      # binary is `facilio`
facilio login                    # opens a browser — approve once
facilio whoami
```

**Stop and check the output of `facilio whoami`.** It must say:

```
Organization: Facilio Vetri Kazhagam (#2915)
```

If it names any other org, you're signed in with your personal Facilio account.
Run `facilio logout`, then `facilio login` again using the **vibeathon account**.
This matters — the CLI takes the org from whoever you signed in as, there is no
`--org` flag, and a deploy from the wrong session ships our app into someone
else's org.

## 2. Get the code

```bash
git clone https://github.com/RajkumarSenthil02/facilio-vision.git
cd facilio-vision
npm install
npm run dev          # http://localhost:5173
```

## 3. How we work

`main` is the release branch — nothing gets pushed to it directly. Every change
goes through a branch and a PR.

```bash
git switch main && git pull
git switch -c <yourname>/<topic>     # e.g. priya/asset-lookup

# ...work...

npm run build                        # must pass before you open the PR
git add -A && git commit -m "..."
git push -u origin <yourname>/<topic>
gh pr create --fill
```

One teammate reviews, then merge. Merging to `main` kicks off the build + deploy.

## 4. What "release" actually means

Merging to `main` publishes to the app's **preview** environment. It does not put
your code on the production URL. That's a platform rule, not something our CI is
skipping — `facilio vibe deploy --prod` only records intent; the cutover to
https://facilio-vision.vibe.facilio.com/ is a manual promote done by a human in
the Facilio platform UI.

So: **merge → preview, automatically. Production → someone clicks promote.** Plan
demo timing around that; don't assume a merge is live.

## 5. Reading Facilio data

`vibe.executeAction(connectionSlug, actionSlug, payload)` is the only supported
route to Facilio data. **Do not guess slugs or payload shapes** — the single most
common way to lose an hour here. Discover them from the CLI first:

```bash
facilio connections search "work orders"
facilio connections schemas <slug> --with-output
facilio connections execute <slug> <action> --payload '{...}'
```

Only wire it into `App.jsx` once the CLI call returns what you expect.

Two SDK details that bite:
- `getCurrentUser()` nests its fields — use `me.user.email` and `me.org.orgId`.
  There is no `me.email`.
- Only the `getCurrentUser()` path should trigger `vibe.login()`. A 401 from
  `executeAction` is just an error — show `err.message`, don't redirect.

## 6. Where to put your code

`src/App.jsx` has the auth bootstrap done and a marked placeholder section. Build
features there or in new files under `src/`. `src/vibe.js` exports the shared
`vibe` client — import it, don't call `createVibe()` again.

## 7. Known snags

- **`facilio vibe app create` needs a real terminal.** Its prompts abort if stdin
  is piped or the command is backgrounded. Run it interactively. (Already done for
  this app — you won't need it.)
- **`@facilio/vibe-sdk` is at 0.3.x, not 1.x.** Don't "fix" the version range.
- **Pushing `.github/workflows/` needs the `workflow` OAuth scope.** If your push
  is rejected with that message: `gh auth refresh -h github.com -s workflow`.
