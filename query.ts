#!/usr/bin/env bun
/**
 * Non-interactive Dexter query runner.
 * Usage: bun query.ts "What is Apple's revenue growth?"
 *
 * Set DEXTER_VERBOSE=1 to log thinking + tool calls to stderr.
 */
import { config } from 'dotenv';
import { Agent } from './src/agent/index.js';
import { getSetting } from './src/utils/config.js';

config({ quiet: true });

const query = process.argv[2];
if (!query) {
  console.error('Usage: bun query.ts "Your financial question here"');
  process.exit(1);
}

const model = getSetting('modelId', 'claude-sonnet-4-5') as string;
const verbose = !!process.env.DEXTER_VERBOSE;

async function runQuery() {
  const agent = await Agent.create({ model });

  try {
    for await (const event of agent.run(query)) {
      if (verbose) {
        if (event.type === 'thinking') {
          console.error(`[thinking] ${event.message}`);
        } else if (event.type === 'tool_start') {
          console.error(`[tool_start] ${event.tool} ${JSON.stringify(event.args)}`);
        } else if (event.type === 'tool_end') {
          console.error(`[tool_end] ${event.tool} (${event.duration}ms)`);
        } else if (event.type === 'tool_error') {
          console.error(`[tool_error] ${event.tool}: ${event.error}`);
        }
      }
      if (event.type === 'done') {
        process.stdout.write(event.answer);
        if (!event.answer.endsWith('\n')) {
          console.log();
        }
      }
    }
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

runQuery();
