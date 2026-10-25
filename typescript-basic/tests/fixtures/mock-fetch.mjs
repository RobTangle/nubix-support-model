/**
 * Doble HTTP precargado en procesos de prueba antes de importar la CLI/SDKs. Genera respuestas
 * controladas y simula fallos/señales para probar el programa completo sin llamadas reales al LLM.
 */
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

if (process.env.NUBBIX_TEST_MODE === 'report_sigint') {
  const originalWrite = fs.promises.writeFile.bind(fs.promises);
  let signalled = false;
  fs.promises.writeFile = async (path, ...args) => {
    if (String(path).endsWith('.tmp') && !signalled) {
      signalled = true;
      // Simula el efecto predeterminado del SO si la CLI retiró demasiado pronto su handler.
      if (process.listenerCount('SIGINT') === 0) process.exit(130);
      process.emit('SIGINT');
    }
    return originalWrite(path, ...args);
  };
  syncBuiltinESMExports();
}

if (process.env.NUBBIX_TEST_MODE === 'blocked_stderr') {
  const original = process.stderr.write.bind(process.stderr);
  const keepAlive = setInterval(() => {}, 1000);
  let scheduled = false;
  process.stderr.write = (chunk, ...args) => {
    if (String(chunk).includes('"event":')) {
      if (!scheduled) {
        scheduled = true;
        setTimeout(() => process.emit('SIGINT'), 20);
        setTimeout(() => clearInterval(keepAlive), 200);
      }
      return true;
    }
    return original(chunk, ...args);
  };
}
globalThis.fetch = async (url, options) => {
  const outgoing = new Request(url, options);
  const request = await outgoing.json();
  if (process.env.NUBBIX_TEST_MODE === 'failure') {
    return new Response(JSON.stringify({ error: { message: 'secret-test-key ticket privado' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }
  const google = outgoing.url.endsWith('/interactions');
  const content = google
    ? request.input
    : request.input.find((message) => message.role === 'user').content;
  const { ticket } = JSON.parse(content);
  const moderation = google
    ? Boolean(request.response_format.schema.properties.decision)
    : request.text.format.name === 'safety_assessment';
  const response = moderation
    ? { decision: 'allow' }
    : { answer: `Recibido: ${ticket}`, confidence: 0.8, category: 'billing', actions: [] };
  if (google)
    return Response.json({
      id: 'test-interaction',
      status: 'completed',
      steps: [
        { type: 'model_output', content: [{ type: 'text', text: JSON.stringify(response) }] },
      ],
      usage: {
        total_input_tokens: 20,
        total_output_tokens: 10,
        total_thought_tokens: 0,
        total_cached_tokens: 0,
        total_tokens: 30,
      },
    });
  return Response.json({
    id: 'test-response',
    object: 'response',
    status: 'completed',
    model: request.model,
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: JSON.stringify(response) }],
      },
    ],
    usage: {
      input_tokens: 20,
      output_tokens: 10,
      total_tokens: 30,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    },
  });
};
