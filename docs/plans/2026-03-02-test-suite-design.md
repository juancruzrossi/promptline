# Test Suite Design — PromptLine

## Scope

Backend API (vite-plugin-api.ts) and shell hooks (prompt-queue.sh, session-register.sh).

## Stack

- **Framework:** Vitest (native Vite integration)
- **Strategy:** Integration tests against real filesystem in tmpdir
- **Shell hooks:** Executed via child_process.exec with JSON stdin

## Structure

```
tests/
├── backend/
│   ├── helpers.ts              # tmpdir setup/teardown, session factories
│   ├── api-crud.test.ts        # CRUD: projects, sessions, prompts
│   ├── api-status.test.ts      # Status computation (active/idle/completed)
│   ├── api-reorder.test.ts     # Prompt reordering
│   └── api-errors.test.ts      # Error responses (400, 404, 405)
├── hooks/
│   ├── session-register.test.ts
│   └── prompt-queue.test.ts
```

## Backend refactor

Extract core functions from vite-plugin-api.ts into `src/backend/queue-store.ts`:
- `readSession`, `writeSession`, `loadProjectView`, `listProjects`, `getProject`
- `withComputedStatus`
- Accept `queuesDir` parameter instead of hardcoded `QUEUES_DIR`

vite-plugin-api.ts imports from queue-store.ts and passes the real QUEUES_DIR.

## Backend test cases

### CRUD (api-crud.test.ts)
- writeSession creates file, readSession reads it back
- listProjects returns all projects with sessions
- getProject returns single project or null
- Adding a prompt appends to session.prompts
- Updating prompt text and status
- Deleting a prompt removes it from array
- Deleting a session removes the file
- Deleting a project removes the directory

### Status (api-status.test.ts)
- Session with running prompt = active
- Session with recent activity (< 60s) = active
- Session with stale activity (> 60s) and no running prompt = idle
- Project with all completed prompts = completed queueStatus
- Project with pending prompts = active queueStatus
- Project with no prompts = empty queueStatus

### Reorder (api-reorder.test.ts)
- Reorder pending prompts by new order array
- Prompts not in order array are appended at end
- Invalid prompt ID returns error

### Errors (api-errors.test.ts)
- Read non-existent session returns null
- loadProjectView on empty directory returns null
- writeSession creates parent directory if missing

## Shell hook test cases

### session-register.test.ts
- Creates queue JSON file with correct structure
- Derives project name from cwd basename
- Sets sessionName from transcript (if available)
- Handles missing transcript gracefully

### prompt-queue.test.ts
- No pending prompts: exits 0, no JSON output (Claude stops)
- Pending prompts exist: exits 0, outputs decision JSON (Claude continues)
- stop_hook_active=true: marks current prompt completed, advances to next
- All prompts completed: exits 0, no output
- Missing session file: exits 0 (never block Claude)

## Out of scope

- React components
- SSE/EventSource
- API client (client.ts)
- E2E tests
