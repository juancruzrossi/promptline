# PromptLine NPM Package Design

## Package

- Name: `@jxtools/promptline`
- Binary: `promptline` → `./bin/promptline.mjs`
- Server: Vite dev server (same as current `npm run dev`)

## Commands

- `promptline` — Check Claude Code → install hooks (first run prompt) → start dashboard
- `promptline update` — Print npm update instruction

## Startup flow

1. Check `~/.claude/` exists → exit with warning if not
2. Check hooks installed (`~/.claude/hooks/promptline-*.sh`) → interactive prompt if missing
3. Start Vite dev server on random port (3000-10000)
4. Print "PromptLine running at http://localhost:XXXX"
5. Auto-open browser

## Hook installation

- Copy 3 `.sh` files from package's `hooks/` dir to `~/.claude/hooks/`
- Merge into `~/.claude/settings.json` (preserve existing hooks)
- chmod +x

## Files

- `bin/promptline.mjs` — CLI entry point
- `hooks/` — shipped hook scripts (already exist at project root as promptline-*.sh)
- `package.json` — updated with bin, files, name, publishConfig
- `README.md` — simplified (approved by user)
