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

On first run, PromptLine installs the Claude Code hooks automatically (if missing) and then opens the dashboard.

For Codex CLI, install the hooks explicitly:

```bash
promptline install --codex
```

## Update

```bash
promptline update
```

## Requirements

- Node.js 18+
- `jq`
- Claude Code installed

## License

ISC
