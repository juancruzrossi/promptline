# Changelog

## [1.3.8] - 02-03-2026

### Fixed
- Path traversal vulnerability in API endpoints: validate URL segments to reject `..`, `/`, and `\` characters
- Missing confirmation dialog when clearing all prompts in a session
