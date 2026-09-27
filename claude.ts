/** Runs one assistant turn against the Claude API, streaming text and handling tool calls. */
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

export interface TurnRequest {
  model: string;
  system: Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
}
export type ToolRunner = (name: string, input: Record<string, any>) => Promise<string>;
export interface TurnResult { text: string; usage: { input: number; output: number; cacheRead: number } }

const MAX_TOOL_ROUNDS = 4;
let client: Anthropic | null = null;

function anthropic(): Anthropic {
  if (!client) {
    if (!config().anthropicKey) throw new Error('ANTHROPIC_API_KEY is not set.');
    const workspace = config().anthropicWorkspaceId;
    client = new Anthropic({
      apiKey: config().anthropicKey,
      maxRetries: 2,
      timeout: 60_000,
      // Needed only for API keys that aren't scoped to a single workspace.
      defaultHeaders: workspace ? { 'anthropic-workspace-id': workspace } : undefined,
    });
  }
  return client;
}

export async function runTurn(req: TurnRequest, onText: (delta: string) => void, runTool: ToolRunner, signal?: AbortSignal): Promise<TurnResult> {
  if (config().aiMock) return mockTurn(req, onText, runTool);

  const messages = [...req.messages];
  let text = '';
  let needsGap = false;
  const usage = { input: 0, output: 0, cacheRead: 0 };

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const stream = anthropic().messages.stream(
      { model: req.model, max_tokens: config().maxTokens, system: req.system, messages, tools: req.tools },
      { signal },
    );
    stream.on('text', (delta) => {
      if (needsGap && text) {
        text += '\n\n';
        onText('\n\n');
      }
      needsGap = false;
      text += delta;
      onText(delta);
    });
    const final = await stream.finalMessage();
    usage.input += final.usage.input_tokens;
    usage.output += final.usage.output_tokens;
    usage.cacheRead += final.usage.cache_read_input_tokens || 0;

    if (final.stop_reason !== 'tool_use') break;

    const calls = final.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    messages.push({ role: 'assistant', content: final.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const call of calls) {
      let out: string;
      let isError = false;
      try {
        out = await runTool(call.name, (call.input || {}) as Record<string, any>);
      } catch (e) {
        out = `Error: ${(e as Error).message}`;
        isError = true;
      }
      results.push({ type: 'tool_result', tool_use_id: call.id, content: out, is_error: isError });
    }
    messages.push({ role: 'user', content: results });
    needsGap = true;
  }
  return { text: text.trim(), usage };
}

/**
 * Offline stand-in for Claude (AI_MOCK=1). Lets you test the widget, handoff and
 * webhooks end to end without an API key or spending credits.
 */
async function mockTurn(req: TurnRequest, onText: (d: string) => void, runTool: ToolRunner): Promise<TurnResult> {
  const last = [...req.messages].reverse().find((m) => m.role === 'user');
  const said = typeof last?.content === 'string' ? last.content.split('\n\n').pop()!.toLowerCase() : '';
  let reply: string;

  if (/\b(person|human|agent|someone|representative)\b/.test(said) && req.tools.some((t) => t.name === 'request_human')) {
    const r = await runTool('request_human', { reason: 'Visitor asked for a person (mock).' });
    reply = r.startsWith('Handoff started') ? "I'm bringing in someone from the team now." : "Nobody from the team is available right now. What's the best email to reach you?";
  } else if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(said)) {
    const email = said.match(/[^\s@]+@[^\s@]+\.[^\s@]+/)![0];
    await runTool('capture_lead', { email, interest: 'Follow-up requested in chat (mock).' });
    reply = `Thanks! I've passed ${email} to the team and they'll be in touch.`;
  } else {
    const found = await runTool('search_knowledge', { query: said });
    const first = /title="([^"]+)" url="([^"]+)"/.exec(found);
    reply = first
      ? `(Test mode) The best match on the site is **${first[1]}**. See [${first[1]}](${first[2]}) for details.`
      : '(Test mode) I could not find that on the site yet. Try "Sync now" in WordPress, or ask for a person.';
  }

  for (const chunk of reply.match(/.{1,14}/gs) || []) {
    onText(chunk);
    await new Promise((r) => setTimeout(r, 25));
  }
  return { text: reply, usage: { input: 0, output: 0, cacheRead: 0 } };
}
