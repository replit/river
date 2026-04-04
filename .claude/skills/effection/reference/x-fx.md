# @effectionx/fx

Utility functions for async workflows, adapted from the starfx project.

## Installation

```
npm install @effectionx/fx
```

## Core functions

### `parallel(operations)`

Coordinates multiple async operations. Returns two channels:

- `immediate` — results in completion order
- `sequence` — results in original order

### `safe(operation)`

Wraps operations to return `Result` objects instead of throwing exceptions. All
tasks wrapped in fx never throw.

### `raceMap(named)`

Races multiple named operations against each other.

### `request(url, init?)`

Makes HTTP requests returning a `Response` object.

> If you need an Effection-native HTTP client with streaming response support,
> use `@effectionx/fetch` instead.

### `json(response)`

Parses JSON from a `Response` object.
