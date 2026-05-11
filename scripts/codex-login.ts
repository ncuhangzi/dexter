#!/usr/bin/env bun
/**
 * Codex OAuth login — opens a browser, logs in with your ChatGPT account,
 * and stores the bearer token at .dexter/codex-auth.json so the `codex`
 * provider can use your subscription quota for model calls.
 *
 * Usage: bun run scripts/codex-login.ts
 *
 * UNOFFICIAL — see src/auth/codex-oauth.ts for caveats.
 */
import { loginCodex } from '../src/auth/codex-oauth.js';

async function main() {
  console.log('Starting Codex OAuth login...');
  console.log('A browser window will open. Sign in with your ChatGPT account.');
  console.log('After approval you will be redirected to localhost; return here for confirmation.\n');
  try {
    await loginCodex();
    console.log('\n✓ Login successful. Set your model to e.g. "codex:gpt-5" in .dexter/settings.json.');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`\n✗ Login failed: ${msg}`);
    process.exit(1);
  }
}

void main();
