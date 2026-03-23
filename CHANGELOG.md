# Changelog

## [1.3.20] - 23-03-2026

### Fixed
- Hardened Claude hook installation to require `python3`, preserve backups, and write `settings.json` atomically
- Replaced the queue file lock busy-spin with a blocking wait that no longer burns CPU on retries
- Surfaced API error messages in the UI and refreshed project data after prompt and project mutations
- Simplified session rendering by trusting backend visibility and sharing status indicator rendering
- Moved build-only packages to `devDependencies`, removed the redundant UUID types package, and dropped the automated test suite/tooling

## [1.3.8] - 02-03-2026

### Fixed
- Path traversal vulnerability in API endpoints: validate URL segments to reject `..`, `/`, and `\` characters
- Missing confirmation dialog when clearing all prompts in a session
