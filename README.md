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

- Each project gets its own queue file at `~/.promptline/queues/{project}.json`
- The project name is derived from the working directory (`basename $CWD`)
- Session tracking captures the Claude Code session UUID for `claude --resume` support
- The dashboard polls every 2 seconds for real-time updates

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
# Copy hook to Claude's hooks directory
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

1. **Create a queue** - Click "+ New Queue" in the sidebar. Enter a project name (must match the directory name where Claude Code runs) and the directory path.

2. **Add prompts** - Click "+ Add Prompt" and type your prompts. They'll execute in order from top to bottom.

3. **Reorder prompts** - Drag and drop cards to change execution order.

4. **Edit prompts** - Click anywhere on a card to edit. Press Enter to save, Escape to cancel.

5. **Run** - Open Claude Code in the project directory and send any prompt. When Claude finishes, the hook picks up the next queued prompt automatically.

6. **Monitor** - The dashboard shows real-time status: which prompt is running, which are pending, and session info with a Resume button that copies `claude --resume {uuid}` to your clipboard.

## Project structure

```
promptline/
  prompt-queue.sh        # Claude Code Stop hook
  vite-plugin-api.ts     # Vite middleware with REST API endpoints
  vite.config.ts         # Vite config (random port, auto-open)
  src/
    api/client.ts        # API client
    hooks/               # React polling hooks (useQueues, useQueue)
    components/          # React components (Sidebar, QueueDetail, PromptCard, etc.)
    types/queue.ts       # TypeScript types
    index.css            # Tailwind CSS + theme variables
    App.tsx              # Main layout
```

## Tech stack

- React 19 + TypeScript + Vite 7
- Tailwind CSS v4
- File-based JSON storage (`~/.promptline/queues/`)
- No separate backend (API runs as Vite middleware)

## License

Private.
