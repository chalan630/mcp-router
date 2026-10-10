# Changelog

This file records fork-specific changes after upstream v0.6.4, the final desktop release.

## Unreleased

### Fixed

- Create a fresh stateless Streamable HTTP transport for each request, isolate SSE connections, and send heartbeats to preserve idle streams.
- Reconnect stale MCP server connections after system resume and failed ping checks.
- Load `argon2` only when needed and fetch Electron-compatible `better-sqlite3` prebuilds when `electron-rebuild` cannot build from source.

### Changed

- Remove the retirement notice while preserving local features.
- Remove unused renderer components, state utilities, exports, translations, and dependencies.
- Keep the CLI independent of the private shared workspace package and declare its test loader as a development dependency.
- Replace the query-keyword Emoji with the existing search icon and correct the Tailwind CSS package import.
- Update Knip configuration and documentation to match current behavior.
