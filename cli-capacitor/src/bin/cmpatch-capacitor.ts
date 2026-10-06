#!/usr/bin/env node

import { runCli } from "../runCli";

async function main(): Promise<void> {
  const exitCode = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}

void main();
