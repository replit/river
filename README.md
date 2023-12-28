# river - Streaming Remote Procedure Calls

It's like tRPC but with

- JSON Schema Support
- full-duplex streaming
- support for service multiplexing
- Result types and error handling
- over any transport (WebSockets, stdio, Unix Domain Socket out of the box)

To use River, you must be on least Typescript 5 with `"moduleResolution": "bundler"`.

## Developing

[![Run on Repl.it](https://replit.com/badge/github/replit/river)](https://replit.com/new/github/replit/river)

- `npm i` -- install dependencies
- `npm run check` -- lint
- `npm run format` -- format
- `npm run test` -- run tests
- `npm run publish` -- cut a new release (should bump version in package.json first)
