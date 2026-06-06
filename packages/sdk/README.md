# @proagentstore/sdk

TypeScript SDK for ProAgentStore — server-powered AI agents.

## Install

```bash
npm install @proagentstore/sdk
```

## Usage

```typescript
import { initPro } from '@proagentstore/sdk'

const agent = initPro({
  agentId: 'your-agent-id',
  token: 'your-pags-token',
})

// Chat
const { response } = await agent.chat('Hello!')

// Memory
await agent.memory.set('user-pref', 'preference', 'likes concise answers')
const memories = await agent.memory.list()

// Tasks
await agent.tasks.create('Summarize report', 'Analyze Q3 data')
const tasks = await agent.tasks.list()

// Direct AI inference
const result = await agent.ai.run('@cf/meta/llama-3.2-3b-instruct', {
  messages: [{ role: 'user', content: 'Hello' }]
})
```

## API

### `initPro(config)`

| Parameter | Type | Description |
|---|---|---|
| `agentId` | `string` | Agent or instance ID |
| `token` | `string` | PAGS session token (from Console → Profile) |
| `apiBase` | `string?` | API URL (default: `https://api.proagentstore.online`) |

### Returns `ProAgentStore`

| Method | Description |
|---|---|
| `chat(message)` | Send a message, get a response |
| `messages(limit?)` | Get conversation history |
| `memory.list()` | List memory entries |
| `memory.set(key, type, content)` | Store a memory |
| `memory.delete(key)` | Delete a memory |
| `tasks.list()` | List tasks |
| `tasks.create(title, desc?)` | Create a task |
| `tasks.update(id, status)` | Update task status |
| `ai.run(model, input)` | Direct Workers AI inference |
| `ai.embed(model, text)` | Generate embeddings |
| `subscription.status()` | Check subscription |

## License

MIT
