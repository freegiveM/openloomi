# @openloomi/memory-store

OpenLoomi memory storage + search SDK with optional HTTP and MCP server
entry points. The package is intentionally decoupled from the openloomi
web app's database and env layers — every consumer wires up its own
implementation via `MemoryStoreConfig`.

## Install

```bash
pnpm add @openloomi/memory-store
```

## SDK usage

```ts
import { createMemoryStore } from "@openloomi/memory-store";

const store = await createMemoryStore({
  db: { getDb: () => drizzleDb() },
  env: { isTauriMode: () => false },
  unified: {
    embedQuery: async ({ userId, query }) => myEmbed(query),
  },
});

await store.getRawMessageManager();
const hits = await store.searchUnifiedMemory({ userId, query });
```

## HTTP daemon

```bash
openloomi-memory-http --port 7421
# or
pnpm --filter @openloomi/memory-store exec openloomi-memory-http
```

Endpoints (all POST, JSON in/out):

- `GET  /health` — health check
- `POST /v1/search` — unified search across raw messages + insights + knowledge
- `POST /v1/raw-messages` — upsert raw messages
- `GET  /v1/raw-messages/:id` — fetch a single raw message

## MCP daemon

```bash
openloomi-memory-mcp
```

Tools:

- `memory.health`
- `memory.searchUnified`
- `memory.writeRawMessage`
- `memory.getRawMessage`

## Configuration

| Key | Required | Description |
| --- | --- | --- |
| `db.getDb()` | yes for persistence | Drizzle DB handle factory |
| `env.isTauriMode()` | yes | selects sqlite vs postgres backend |
| `vector.backend` | one of | `sqlite-vec` or `chroma` |
| `unified.embedQuery` | yes for unified search | query embedder |

See `src/config.ts` for the full type surface.
