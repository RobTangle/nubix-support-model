#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { main } from './evals/cli.js';
import { publicError } from './errors.js';

// La implementación pertenece al módulo de evals; esta entrada preserva su ruta y exit code.
export { main } from './evals/cli.js';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error: unknown) => {
    process.stderr.write(JSON.stringify(publicError(error)) + '\n');
    process.exitCode = 1;
  });
