# CLAUDE.md

## Critical Rules

- **ALWAYS bump the version in `package.json`** after every change merged to main. Don't wait for the user to ask. Use semver: patch for fixes/refactors, minor for features, major for breaking changes.
- **NEVER push directly to `main`** — use PRs with squash & merge.
- When merging PRs with `gh pr merge`, use `--squash --delete-branch`.
- Responses in Spanish, code comments in English.

## Build & Dev Commands

```bash
npm run dev          # Vite dev server
npm run lint         # ESLint
npm run build        # TypeScript + Vite build
```

## Architecture

- **Frontend**: React 19 + Vite 7 + Tailwind 4 + TypeScript
- **Backend**: Vite plugin API (vite-plugin-api.ts) serving REST endpoints
- **Data**: JSON files at `~/.promptline/queues/{project}/{session_id}.json`
- **Hooks**: Shell scripts (session-register, prompt-queue, session-end)

## NPM Distribution

- Package: `@jxtools/promptline` (public, scoped)
- GitHub Actions auto-publishes on version bump to main (OIDC trusted publisher, no token needed)
- `repository` field in package.json is required for provenance verification

## Validation

- Prefer `npm run lint`
- Prefer `npm run build`
