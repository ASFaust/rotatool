# Dev environment & working preferences

> Originally a working-session memory; copied into the repo so it's available on
> any machine. Adjust the Node setup note to match whichever machine you're on.

## Who / how to work

Andreas describes himself as "a backend guy" with little to no web development
experience — prefer well-trodden, well-documented tooling choices (npm over
pnpm/bun) and explain webdev-specific decisions rather than assuming familiarity.

## Node via nvm

Node is managed by **nvm** (`~/.nvm`). `~/.bashrc` sources nvm and activates the
nvm `default` alias.

**Important:** Vite 6+ requires Node **20.19+ / 22.12+**. The build and dev
server crash on older Node (`ReferenceError: CustomEvent is not defined`), even
though `svelte-check`/`tsc` pass — so a green `npm run check` does **not** mean
the toolchain is healthy; always confirm `npm run build` runs.

### Current laptop (as of 2026-06)

nvm `default` is set to **v22** (v22.22.3). A fresh non-interactive shell may
still resolve to an older pinned version, so every shell that runs `node`/`npm`
should source nvm and select 22 explicitly:

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22
```

If a machine has a new-enough Node on PATH already, this isn't needed — check
with `node --version` first (must be ≥ 20.19).
