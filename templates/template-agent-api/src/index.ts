/**
 * AGENTNAME — a stateless ProAgentStore API tool.
 *
 * Receives input, processes with Workers AI, returns result.
 * No state, no memory, no conversation — pure transform/generate/analyze.
 */
import { Hono } from 'hono';

interface Env {
  AI: Ai;
}

const app = new Hono<{ Bindings: Env }>();

app.get('/', (c) => c.json({ agent: 'AGENTNAME', type: 'api', status: 'ok' }));

app.post('/run', async (c) => {
  const { input } = await c.req.json<{ input: string }>();
  if (!input) return c.json({ error: 'input required' }, 400);

  const result = await c.env.AI.run(
    '@cf/meta/llama-3.2-3b-instruct' as Parameters<Ai['run']>[0],
    {
      messages: [
        { role: 'system', content: 'You are a helpful tool. Process the input and return a result.' },
        { role: 'user', content: input },
      ],
    },
  ) as { response?: string };

  return c.json({ result: result.response || '' });
});

export default app;
