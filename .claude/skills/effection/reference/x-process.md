# @effectionx/process

Spawn and manage child processes with structured concurrency.

## Installation

```
npm install @effectionx/process
```

## Core functions

### `exec(cmd, options?)`

Execute commands with finite lifetimes. Synchronize on exit status.

- `.join()` — Always returns the result, regardless of exit code.
- `.expect()` — Throws `ExecError` if the process exits with non-zero code.

### `daemon(cmd, options?)`

Manage long-running processes (like servers) that operate perpetually. Raises
`DaemonExitError` if they exit prematurely.

## Features

- Stream-based stdout/stderr access
- Writable stdin for process input
- Signal handling and cleanup across POSIX and Windows
- Shell mode supporting glob expansion

## ExecOptions

- `arguments` — Additional command arguments.
- `env` — Environment variables.
- `shell` — Enable shell interpretation (boolean or shell path).
- `cwd` — Working directory.

## Error types

- **`ExecError`** — Raised when commands fail.
- **`DaemonExitError`** — Raised when daemons exit prematurely.
