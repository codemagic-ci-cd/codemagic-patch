#!/usr/bin/env node

import { runCli } from "../runCli";
import { detachedUpdateCheck } from "../updateNotice";

async function main(): Promise<void> {
  const exitCode = await runCli(process.argv.slice(2), {
    startUpdateCheck: detachedUpdateCheck(),
  });
  process.exitCode = exitCode;
}

void main();
