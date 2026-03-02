# PromptLine - Design Document

**Date**: 2026-03-01
**Status**: Approved

## Overview

PromptLine is a local developer tool that manages prompt queues for Claude Code sessions. It provides a terminal-style React dashboard for creating, managing, and monitoring prompt queues across multiple projects, with a shell hook that auto-feeds prompts to Claude Code when it finishes responding.

## Problem

When working with Claude Code, you often want to queue multiple prompts and walk away. Currently, you must wait for Claude to finish each response before submitting the next prompt. PromptLine automates this by maintaining a queue of prompts per project and feeding them to Claude Code via a Stop hook.

## Architecture

### Stack
- **Frontend**: React 19 + Vite + TypeScript + Tailwind CSS v4
- **API**: Vite plugin middleware (no separate backend)
- **Storage**: JSON files in `~/.promptline/`
- **Hook**: Bash script configured as Claude Code Stop hook
- **Repo**: GitHub repo `promptline`

### Storage Structure

```
~/.promptline/
├── queues/
│   ├── {project-slug}.json   # Queue + sessions per project
│   └── ...
└── config.json               # Global config
```

### Queue File Schema

```json
{
  "project": "clinex",
  "directory": "/Users/.../clinex",
  "prompts": [
    {
      "id": "uuid",
      "text": "prompt text",
      "status": "pending|running|completed",
      "createdAt": "ISO-8601",
      "completedAt": "ISO-8601|null"
    }
  ],
  "activeSession": {
    "sessionId": "claude-session-uuid",
    "status": "active|idle",
    "startedAt": "ISO-8601",
    "lastActivity": "ISO-8601",
    "currentPromptId": "uuid|null"
  },
  "sessionHistory": [
    {
      "sessionId": "uuid",
      "startedAt": "ISO-8601",
      "endedAt": "ISO-8601",
      "promptsExecuted": 5
    }
  ]
}
```

## Hook Design

The `prompt-queue.sh` hook:

1. Reads Claude Code input JSON from stdin (extracts `session_id`, `cwd`)
2. Derives project name from `cwd`
3. Finds matching queue file in `~/.promptline/queues/`
4. If pending prompts exist: marks first as `running`, updates `activeSession`, writes prompt to stderr, exits with code 2
5. If no pending prompts: marks session as `idle`, exits with code 0

### StopHookError

Exit code 2 is the documented mechanism for Claude Code Stop hooks to inject follow-up prompts. Claude Code displays a "StopHookError" visually, but the hook functions correctly. This is cosmetic and cannot be suppressed.

## API Endpoints (Vite Middleware)

| Endpoint | Method | Description |
|---|---|---|
| `/api/queues` | GET | List all project queues |
| `/api/queues/:project` | GET | Get specific queue |
| `/api/queues/:project` | POST | Create new queue |
| `/api/queues/:project` | DELETE | Delete queue |
| `/api/queues/:project/prompts` | POST | Add prompt |
| `/api/queues/:project/prompts/:id` | PUT | Edit prompt |
| `/api/queues/:project/prompts/:id` | DELETE | Delete prompt |
| `/api/queues/:project/prompts/reorder` | PUT | Reorder prompts |

## Frontend Design

### Aesthetic
- Terminal/developer style
- Dark mode default
- Monospace typography (JetBrains Mono / Fira Code)
- Pastel radiant colors: mint green (active), violet (running), blue (pending), pink (idle)
- Glassmorphism card borders
- Pulsing indicator for active sessions
- Designed using `/frontend-design` skill

### Layout
- Left sidebar: project list with status indicators
- Main area: selected project's queue as draggable cards
- Cards show prompt text + status badge
- Completed prompts in a collapsible history section
- Bottom status bar with aggregate stats

### Interactions
- Full CRUD: add, edit, delete prompts from the browser
- Drag & drop to reorder prompts
- Create new queues pointing to any directory
- Resume button copies `claude --resume <uuid>` to clipboard
- 2-second polling interval for real-time updates

## End-to-End Flow

1. Open PromptLine dashboard (`npm run dev`)
2. Create a queue for a project directory
3. Add prompts as cards
4. Work in Claude Code normally
5. Claude finishes → hook reads queue → feeds next prompt → `exit 2`
6. Dashboard updates in real-time via polling
7. When queue is empty → `exit 0` → session goes idle
8. Resume session later with `claude --resume <uuid>`
