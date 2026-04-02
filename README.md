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

## Hook setup

Install PromptLine hooks explicitly after installing the package:

```bash
promptline install
```

For Codex CLI:

```bash
promptline install --codex
```

## Usage

```bash
promptline
```

PromptLine validates that hooks are installed and warns if they are missing or outdated before opening the dashboard.

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
