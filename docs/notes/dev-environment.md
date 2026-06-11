# Dev environment & working preferences

> Originally a working-session memory; copied into the repo so it's available on
> any machine. Adjust the Node setup note to match whichever machine you're on.

## Who / how to work

Andreas describes himself as "a backend guy" with little to no web development
experience — prefer well-trodden, well-documented tooling choices (npm over
pnpm/bun) and explain webdev-specific decisions rather than assuming familiarity.

## Node via nvm (this laptop)

Node is **not** preinstalled and **not** on PATH in a fresh non-interactive
shell — it's installed via **nvm** (`~/.nvm`, Node v24 LTS). Every shell that
runs `node`/`npm` must first source nvm:

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
```

If a different machine has Node on PATH already, this step isn't needed there —
check with `node --version` first.
