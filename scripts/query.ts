#!/usr/bin/env bun
/**
 * Headless dexter query — bypasses the TUI so logger output is visible.
 *
 * Usage:
 *   bun run scripts/query.ts "your question here"
 *   bun run scripts/query.ts --model codex:gpt-5.4 "your question"
 *   bun run scripts/query.ts --model openai:gpt-4o "your question"
 *   DEXTER_CODEX_DEBUG=1 bun run scripts/query.ts "your question"
 *
 * Every logger.warn / logger.error (including the new Codex stream watchdog
 * messages) is mirrored to stderr in real time. Use this when the CLI looks
 * like it's spinning forever — you'll see exactly where it hangs.
 */
import { Agent } from '../src/agent/agent.js';
import { logger } from '../src/utils/logger.js';
import { getSetting } from '../src/utils/config.js';
import { DEFAULT_MODEL } from '../src/model/llm.js';
import type { LogEntry } from '../src/utils/logger.js';

function parseArgs(argv: string[]): { model: string | null; query: string } {
  const args = [...argv];
  let model: string | null = null;
  const rest: string[] = [];
  while (args.length > 0) {
    const a = args.shift()!;
    if (a === '--model' || a === '-m') {
      model = args.shift() ?? null;
    } else {
      rest.push(a);
    }
  }
  return { model, query: rest.join(' ').trim() };
}

function fmtTime(d: Date): string {
  return d.toISOString().slice(11, 23);
}

function colorLevel(level: string, text: string): string {
  const code =
    level === 'error' ? '31' :
    level === 'warn' ? '33' :
    level === 'info' ? '36' :
    '90';
  return process.stderr.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text;
}

async function main() {
  const { model: modelArg, query } = parseArgs(process.argv.slice(2));
  if (!query) {
    console.error('Usage: bun run scripts/query.ts [--model <model>] "your question"');
    process.exit(2);
  }

  // Mirror every NEW log entry to stderr. logger keeps a 50-entry ring buffer
  // and fires the subscriber with the full buffer on every change — track the
  // last-seen id so we only print incremental entries.
  let lastSeenId: string | null = null;
  logger.subscribe((logs: LogEntry[]) => {
    const startIdx = lastSeenId
      ? logs.findIndex((e) => e.id === lastSeenId) + 1
      : 0;
    for (let i = Math.max(0, startIdx); i < logs.length; i++) {
      const e = logs[i];
      const line = `[${fmtTime(e.timestamp)}] ${e.level.toUpperCase().padEnd(5)} ${e.message}`;
      process.stderr.write(colorLevel(e.level, line) + '\n');
    }
    if (logs.length > 0) lastSeenId = logs[logs.length - 1].id;
  });

  const model =
    modelArg ?? (getSetting('modelId', null) as string | null) ?? DEFAULT_MODEL;
  process.stderr.write(colorLevel('info', `[query] model: ${model}`) + '\n');
  process.stderr.write(colorLevel('info', `[query] query: ${query}`) + '\n');

  const startedAt = Date.now();
  const agent = await Agent.create({ model, maxIterations: 10 });

  for await (const event of agent.run(query)) {
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    switch (event.type) {
      case 'thinking':
        process.stderr.write(colorLevel('info', `[${elapsed}s] THINKING: ${event.message.slice(0, 200)}`) + '\n');
        break;
      case 'tool_start':
        process.stderr.write(colorLevel('info', `[${elapsed}s] TOOL_START: ${event.tool} ${JSON.stringify(event.args).slice(0, 200)}`) + '\n');
        break;
      case 'tool_end':
        process.stderr.write(colorLevel('info', `[${elapsed}s] TOOL_END: ${event.tool} (${event.duration}ms)`) + '\n');
        break;
      case 'tool_error':
        process.stderr.write(colorLevel('error', `[${elapsed}s] TOOL_ERROR: ${event.tool}: ${event.error}`) + '\n');
        break;
      case 'stream_progress':
        // Noisy — only show on mode change, suppress charDelta-only ticks
        if (event.charDelta === 0) {
          process.stderr.write(colorLevel('debug', `[${elapsed}s] STREAM_MODE: ${event.mode}`) + '\n');
        }
        break;
      case 'done':
        process.stderr.write(colorLevel('info', `[${elapsed}s] DONE (iters=${event.iterations}, ${event.totalTime}ms)`) + '\n');
        process.stdout.write('\n' + event.answer + '\n');
        break;
    }
  }

  process.exit(0);
}

void main().catch((err) => {
  console.error('\n[query] fatal:', err);
  process.exit(1);
});
