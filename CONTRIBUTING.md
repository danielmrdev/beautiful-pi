# Contributing

Thanks for your interest in beautiful-pi! This document outlines the
development workflow and conventions.

## Getting started

1. Fork and clone the repo.
2. The extensions are loaded directly by pi — **no build step needed**.
   Pi loads `.ts` files at runtime.
3. Register the package in your pi settings:
   ```json
   {
     "packages": ["/path/to/beautiful-pi"]
   }
   ```
4. Run `/install ./local` from inside pi, then `/reload` to pick up changes.

## Development workflow

- **Edit → `/reload`** — no compilation, no restart. The `/reload` command
  re-reads all extensions, themes, and settings immediately.
- Write TypeScript using pi's runtime types. Import `ExtensionAPI`,
  `ExtensionContext`, `Theme`, etc. from the pi packages.
- Use `require("node:fs")` for Node built-ins (not `import`).

### Code structure

Each feature lives in its own directory under `extensions/`:

```
extensions/<feature>/
├── index.ts    # default export function (pi: ExtensionAPI) => void
└── *.ts        # additional helpers
```

The entry point `extensions/index.ts` wires all features in order.

### Staying compatible

- Always check `ctx.hasUI` before calling `ctx.ui.*` methods.
- Provide ASCII fallbacks alongside Nerd Fonts icons (see `shared/icons.ts`).
- Test with `/reload` to ensure the extension re-applies state correctly.

## Pre-commit hook

This repo includes a pre-commit hook that runs `gitleaks protect --staged` to
prevent secret leakage. Enable it with:

```bash
git config core.hooksPath .githooks
```

## Coding style

- Prefer minimal diffs and surgical changes.
- No speculative features or abstractions.
- Use the AGENTS.md conventions for commit messages and communication style.

## Pull requests

1. Keep PRs focused on a single change.
2. Write a concise description of what and why.
3. Verify with `/reload` that nothing breaks.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
