# @effectionx/fs

File system operations wrapped as Effection operations. Wraps Node.js
`fs/promises` APIs with structured concurrency.

## Installation

```
npm install @effectionx/fs
```

## File operations

- `stat(path)` / `lstat(path)` — Retrieve file/directory metadata.
- `exists(path)` — Check file existence.
- `readTextFile(path)` / `writeTextFile(path, data)` — Text file I/O.
- `ensureFile(path)` — Create file with parent directories.
- `copyFile(src, dest)` — Duplicate files.
- `rm(path, options?)` — Remove files or directories recursively.

## Directory operations

- `ensureDir(path)` — Create directories recursively.
- `readdir(path)` — List directory contents.
- `emptyDir(path)` — Clear directory contents.
- `walk(path, options?)` — Traverse directory trees as `Stream<WalkEntry>`.
- `expandGlob(pattern, options?)` — Expand glob patterns as
  `Stream<WalkEntry>`.

## Utilities

- `toPath(pathOrUrl)` — Convert paths or URLs to strings.
- `globToRegExp(glob)` — Transform glob patterns to RegExp.
- `fromFileUrl(url)` / `toFileUrl(path)` — URL conversion helpers.

## Path support

All operations accept either string paths or URL objects (e.g.,
`import.meta.url`-based paths).
