# PromptLine

A prompt queue system for Claude Code.

Ever been watching Claude Code work and thought of three more things you need it to do next? PromptLine lets you line up those prompts so Claude picks them up automatically — one after another, without missing a single detail.

## Install

```bash
npm install -g @jxtools/promptline
```

If your environment requires an explicit npm registry:

```bash
npm install -g @jxtools/promptline --registry https://registry.npmjs.org/
```

## Usage

```bash
promptline
```

On first run, PromptLine asks to install its hooks into Claude Code. After that, it opens the dashboard.

## How it works

Start your Claude Code sessions as usual. Then open PromptLine in a separate terminal — it detects all running sessions automatically.

While Claude is working, add prompts to the queue from the dashboard. When Claude finishes its current task, it picks up the next queued prompt and keeps going. Each session has its own independent queue, so multiple sessions in the same project don't interfere with each other.

1. **Work with Claude Code** — Start your sessions normally
2. **Open PromptLine** — Run `promptline` in a separate terminal
3. **Queue your prompts** — Add them while Claude works, they execute in order

## Update

```bash
promptline update
```

## Requirements

- Node.js 18+
- Python 3
- Claude Code installed

## License

ISC
