# @renseiai/daemon — DEPRECATED

> **This package is deprecated.** The daemon runtime has been ported to Go and now ships inside the `donmai` binary as `donmai daemon run`. See the [migration doc](../../docs/migration-from-legacy-cli.md) for the upgrade path.

## Migration

Replace any usage of the Node binary `rensei-daemon` with the Go subcommand:

```bash
# Before (deprecated)
npm install -g @renseiai/daemon
rensei-daemon start
rensei-daemon status
rensei-daemon setup
rensei-daemon update
rensei-daemon install
rensei-daemon doctor

# After
brew install RenseiAI/tap/rensei   # or download from releases
rensei daemon run                   # long-running entry point
rensei daemon status
rensei daemon setup
rensei daemon update
rensei daemon install
rensei daemon doctor
```

The Go binary owns the same on-disk layout (`~/.rensei/daemon.yaml`, `~/.rensei/daemon.jwt`) and exposes the same HTTP control API on `127.0.0.1:7734`, so existing config files Just Work after the swap.

## Why?

The single-binary OSS UX cardinal rule (`brew install rensei` ships ONE binary that does everything) requires the daemon to live inside the same Go binary as the rest of the `rensei` CLI. The previous Node package required a separate install step (`npm install -g`), a Node 22+ runtime on every machine, and a bespoke launchd / systemd installer that pointed at the Node binary.

## Removal timeline

This package will be removed from the monorepo in **cycle 6** after the smoke harness has passed for 7 consecutive nights against the Go daemon. Until then, the package is preserved at version `0.1.0` so existing installations continue to work without disruption.

| Phase | When | What |
|-------|------|------|
| Deprecation (this commit) | cycle 5 | `package.json` `deprecated` field set, README banner, no behavior change |
| Soak | cycle 5 → 6 | Go daemon runs in CI smokes for 7 consecutive nights |
| Removal | cycle 6 | Package directory deleted from monorepo, npm `deprecate` marker pushed |

If you depend on this package, please migrate before the cycle-6 removal. Open a comment on the [migration doc](../../docs/migration-from-legacy-cli.md) if anything in the migration path is unclear.
