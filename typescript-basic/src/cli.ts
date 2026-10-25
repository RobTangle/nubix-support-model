#!/usr/bin/env node
import { main } from './support/cli.js';
import { publicError } from './errors.js';

// Entrada pública estable: mover la implementación no cambia comandos ni el binario npm.
main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify(publicError(error))}\n`);
  process.exitCode = 2;
});
