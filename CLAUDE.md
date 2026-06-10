# Claude Code Guidelines

## Additional Instructions

If an `AGENTS.md` file exists in the repo root, read it at session start and follow any
instructions it contains — it is the detailed architecture/context document for this project.
Keep it (and the README) up to date when you change behavior it describes.

## Branching

Always create new branches off the default branch (`main`) unless explicitly told otherwise.

## Commits & CI

- The pre-commit hook (`.githooks/pre-commit`) auto-bumps the patch version, but skips the bump
  for docs-only commits (changes confined to `*.md`, `docs/`, `.github/`, `.githooks/`).
- Pushes to `main` build and publish a Docker image (`.github/workflows/docker.yml`); docs-only
  pushes are excluded via `paths-ignore`. Don't trigger an image build for changes that don't
  affect the software.
- Run `npm run build` (backend tsc + frontend vite) before committing frontend or backend changes
  to catch type/template errors.
