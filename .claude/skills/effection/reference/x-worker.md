# @effectionx/worker

Web Worker integration with two-way messaging and graceful shutdown.

## Installation

```
npm install @effectionx/worker
```

## Overview

Provides Effection-native Web Worker management. Workers are treated as
resources — they start when the operation is interpreted and terminate
gracefully when the enclosing scope exits.

Features:

- Two-way messaging between main thread and worker
- Stream-based message reception
- Automatic cleanup on scope exit
