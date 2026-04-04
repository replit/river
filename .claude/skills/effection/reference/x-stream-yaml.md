# @effectionx/stream-yaml

Parse streams of strings as YAML documents. Works with `@effectionx/stream-helpers`.

## Installation

```
npm install @effectionx/stream-yaml
```

## Core function

### `yamlDocuments()`

Transforms string chunks into YAML `Document.Parsed` objects. Supports
multi-document YAML streams separated by `---`.

**Signature:**

```ts
yamlDocuments(): (stream: Stream<string, TClose>) => Stream<Document.Parsed, TClose>
```

## Use cases

- Reading and parsing YAML configuration files
- Parsing kubectl output for Kubernetes resources
- Handling stream closure with return values
