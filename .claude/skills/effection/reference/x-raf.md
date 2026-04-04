# @effectionx/raf

Stream of `requestAnimationFrame` updates for Effection.

## Installation

```
npm install @effectionx/raf
```

## API

```ts
import { raf } from "@effectionx/raf";
```

**`raf`** — A `Stream<number, never>` that yields numeric timestamps
representing animation frames.

## Usage

```ts
import { each, main } from "effection";
import { raf } from "@effectionx/raf";

await main(function* () {
  for (const timestamp of yield* each(raf)) {
    console.log(timestamp);
    yield* each.next();
  }
});
```
