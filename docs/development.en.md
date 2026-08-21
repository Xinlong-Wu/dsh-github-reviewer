# Development and Known Limitations

English | [中文](development.md)

## Development

```sh
npm install
npm run typecheck
npm test
npm run coverage
npm run build
```

Both `typecheck` and `build` first run `scripts/generate-typert.mjs`, which creates a temporary synthetic workspace and emits the Host Remote artifacts under `lib/typert.host.*` and `lib/typert.remote-client.*`. Do not edit those generated files by hand.

## Known Limitations and Deferred Work

- The cursor lives in the harness storage domain; with a single-host JSON-file backend, two hosts running the same account would still poll twice. PR sessions are durable through the harness, but review *triggers* are not (LingoBridge keeps both in its per-account store).
- The plugin requires a full agent-loop deployment (`agents` + `sessions`); it no longer activates in bare compositions without them. Without a `sessionPersistence` provider, PR sessions are memory-only across restarts.
- PR sessions share the session store with interactive sessions; they are visible and replayable there, but nothing labels them as reviewer sessions beyond the session id.
- GitHub API rate limits are surfaced as errors and the poll continues on the next tick; there is no backoff beyond the poll interval.
- Comment polling uses the cursor timestamps as the `since` bound, so comments deleted before the next poll are not seen.
