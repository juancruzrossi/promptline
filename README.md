# PromptLine

Queue multiple prompts for Claude Code and let them execute automatically, one after another, without manual intervention.

## What is PromptLine?

PromptLine is a prompt queue system for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). It lets you line up a series of prompts that Claude Code will process sequentially. When Claude finishes responding to one prompt, the next one starts automatically.

It consists of two parts:

1. **A bash hook** (`prompt-queue.sh`) that integrates with Claude Code's Stop hook system. After each response, it reads the next pending prompt from the queue and feeds it to Claude.
2. **A React dashboard** to manage your prompt queues visually: add, edit, reorder, and delete prompts per project with real-time status updates.

## How it works

```
You add prompts to a queue via the dashboard
        |
        v
Claude Code finishes responding
        |
        v
Stop hook fires -> reads queue JSON -> finds next pending prompt
        |
        v
Sends prompt via stderr + exit 2 -> Claude Code continues with that prompt
        |
        v
Repeats until no more pending prompts -> exit 0 -> Claude stops
```

### Key details

- Each project gets its own queue file at `~/.promptline/queues/{project}.json`
- The project name is derived from the working directory (`basename $CWD`)
- Session tracking captures the Claude Code session UUID for `claude --resume` support
- The dashboard polls every 2 seconds for real-time updates
- File writes are atomic (write-to-temp + rename) to prevent corruption
- Sessions are auto-detected as idle after 5 minutes of inactivity

## Setup

### Prerequisites

- Node.js 18+
- Python 3 (used by the hook for JSON processing)
- Claude Code CLI installed

### Install

```bash
git clone git@github.com:juancruzrossi/promptline.git
cd promptline
npm install
```

### Install the hook

Copy the hook script and configure Claude Code:

```bash
mkdir -p ~/.claude/hooks
cp prompt-queue.sh ~/.claude/hooks/prompt-queue.sh
chmod +x ~/.claude/hooks/prompt-queue.sh
```

Add the hook to `~/.claude/settings.json` under the `"Stop"` key:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/prompt-queue.sh"
          }
        ]
      }
    ]
  }
}
```

### Run the dashboard

```bash
npm run dev
```

The dashboard opens automatically in your browser on a random port (3000-10000).

## Usage

1. **Create a queue** — Click "+ New Queue" in the sidebar. Enter a project name (must match the directory name where Claude Code runs) and the directory path.

2. **Add prompts** — Click "+ Add Prompt" and type your prompts. They'll execute in order from top to bottom.

3. **Reorder prompts** — Drag and drop cards to change execution order. Only pending prompts can be reordered.

4. **Edit prompts** — Click anywhere on a pending card to edit its text. Press Enter to save, Escape to cancel. Shift+Enter for multi-line.

5. **Delete prompts** — Hover over a card and click the ✕ button. Both pending and completed prompts can be deleted.

6. **Run** — Open Claude Code in the project directory and send any prompt. When Claude finishes, the hook picks up the next queued prompt automatically.

7. **Monitor** — The dashboard shows real-time status:
   - Which prompt is running (green pulse), pending (yellow), or completed (dimmed)
   - Active session info with session ID and last activity timestamp
   - Sessions auto-detect as "idle" after 5 minutes of no hook activity
   - Resume button copies `claude --resume {uuid}` to your clipboard
   - Status bar at the bottom shows totals across all projects

8. **History** — Completed prompts are collapsed under a "History" toggle. Click to expand.

## Hook behavior

The hook (`prompt-queue.sh`) runs after every Claude Code response via the Stop hook system:

| Scenario | What happens | Exit code |
|----------|-------------|-----------|
| Queue has pending prompts | Marks current running prompt as completed, picks next pending, sends it via stderr | `2` (continue) |
| Queue is empty or all completed | Registers the session, does nothing | `0` (stop) |
| No queue file for this project | Does nothing | `0` (stop) |
| No `cwd` in hook input | Does nothing | `0` (stop) |

The hook always registers the active Claude Code session (session ID, timestamp) so the dashboard can show session status even when no prompts are queued.

## API endpoints

The dashboard communicates with a Vite middleware API. All endpoints are under `/api/`:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/queues` | List all queues |
| `GET` | `/api/queues/:project` | Get a single queue |
| `POST` | `/api/queues/:project` | Create a queue (`{ directory }`) |
| `DELETE` | `/api/queues/:project` | Delete a queue |
| `POST` | `/api/queues/:project/prompts` | Add a prompt (`{ text }`) |
| `PUT` | `/api/queues/:project/prompts/:id` | Update a prompt (`{ text?, status? }`) |
| `DELETE` | `/api/queues/:project/prompts/:id` | Delete a prompt |
| `PUT` | `/api/queues/:project/prompts/reorder` | Reorder prompts (`{ order: string[] }`) |

## Queue JSON format

Each queue is stored at `~/.promptline/queues/{project}.json`:

```json
{
  "project": "my-project",
  "directory": "/path/to/project",
  "prompts": [
    {
      "id": "uuid",
      "text": "run the tests",
      "status": "pending",
      "createdAt": "2024-01-01T00:00:00.000Z",
      "completedAt": null
    }
  ],
  "activeSession": {
    "sessionId": "claude-session-uuid",
    "status": "active",
    "startedAt": "2024-01-01T00:00:00.000Z",
    "lastActivity": "2024-01-01T00:05:00.000Z",
    "currentPromptId": "uuid"
  },
  "sessionHistory": []
}
```

Prompt statuses: `pending` -> `running` -> `completed`

Session statuses: `active` (hook fired within 5 min) or `idle` (computed server-side)

## Project structure

```
promptline/
  prompt-queue.sh          # Claude Code Stop hook (bash + embedded Python)
  vite-plugin-api.ts       # Vite middleware — REST API endpoints
  vite.config.ts           # Vite config (random port, auto-open browser)
  src/
    main.tsx               # React entry point
    App.tsx                 # Main layout (sidebar + detail + status bar)
    api/client.ts           # API client (fetch wrapper)
    types/queue.ts          # TypeScript types (Prompt, ProjectQueue, etc.)
    hooks/
      useQueues.ts          # Polling hook for queue list
      useQueue.ts           # Polling hook for single queue
    components/
      Sidebar.tsx           # Project list + "New Queue" button
      QueueDetail.tsx       # Queue view: prompts, drag & drop, session info
      PromptCard.tsx        # Individual prompt card (edit, delete, drag)
      AddPromptForm.tsx     # Collapsible form to add new prompts
      SessionInfo.tsx       # Active session display with resume button
      StatusBar.tsx         # Bottom bar with global totals
      CreateQueueModal.tsx  # Modal for creating new queues
    index.css               # Tailwind CSS + custom theme variables
```

## Tech stack

- React 19 + TypeScript + Vite 7
- Tailwind CSS v4
- File-based JSON storage (`~/.promptline/queues/`)
- No separate backend — API runs as Vite middleware
- Atomic file writes (write-to-temp + rename) in both hook and API
- 2-second polling for real-time dashboard updates

## License

Private.
