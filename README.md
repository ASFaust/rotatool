# Rotatool 🐢

A free, open-source, **fully client-side** rota (staff schedule) generator. Define
your people, the roles they hold, your shifts and constraints, then let an
integer-linear solver build a fair schedule for you.

**Your data never leaves the browser.** Everything runs locally — nothing is
uploaded, tracked, or stored on a server. No account, no cookies. The flip side:
nothing is saved for you either, so export your work (Save `.json`) regularly.

## How it works

- **People** — who's available, their attributes/roles, and hour targets.
- **Shifts** — recurring or one-time shifts, with staffing requirements (how many
  people, and which attributes they need).
- **Rota** — generate and hand-tune the schedule. A [HiGHS](https://highs.dev/)
  MILP solver (compiled to WebAssembly, run in a Web Worker so the UI stays
  responsive) assigns people to shifts, balancing coverage, fairness, workload and
  other configurable objectives. View it as a **Timeline** or a **Grid**.

Data is saved as a single editable `.json` file you can keep, share, or re-import.

## Tech

Svelte 5 (runes) · Vite · TypeScript · [zod](https://zod.dev/) (validation) ·
[highs](https://www.npmjs.com/package/highs) (HiGHS WASM MILP solver).

## Develop

Requires Node ≥ 20.19 (Vite 8). See
[docs/notes/dev-environment.md](docs/notes/dev-environment.md) for the nvm setup.

```bash
npm install
npm run dev      # dev server with hot reload
npm run build    # production build to dist/ (static, host anywhere)
npm run preview  # serve the production build
npm run check    # svelte-check + tsc type-check
```

The build output in `dist/` is fully static and can be dropped onto any host.

## Status

Pre-release. Planned work and known rough edges are tracked in
[ROADMAP.md](ROADMAP.md).
