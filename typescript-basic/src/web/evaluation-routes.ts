import { Router } from 'express';
import { z } from 'zod';
import { AppError, publicError } from '../errors.js';
import type { LabEvaluationService } from '../lab/evaluations.js';

/** Borde HTTP del laboratorio; no ejecuta comandos de shell ni acepta rutas/modelos del cliente. */
export function evaluationRoutes(service: LabEvaluationService) {
  const router = Router();
  router.post('/', (request, response) => {
    try {
      if (!request.is('application/json')) throw new AppError('invalid_arguments');
      response.status(202).json(service.start(request.body));
    } catch (error) {
      response
        .status(
          error instanceof AppError && error.code === 'rate_limit'
            ? 429
            : error instanceof AppError && error.code === 'report_error'
              ? 503
              : 400,
        )
        .json(publicError(error));
    }
  });
  router.get('/:id', (request, response) => {
    try {
      const id = z.uuid().safeParse(request.params.id);
      const result = id.success ? service.get(id.data) : null;
      if (!result) {
        response
          .status(404)
          .json({ error: { code: 'not_found', message: 'Evaluación no encontrada.' } });
        return;
      }
      response.json(result);
    } catch (error) {
      response.status(503).json(publicError(error));
    }
  });
  router.post('/:id/cancel', (request, response) => {
    try {
      const id = z.uuid().safeParse(request.params.id);
      if (!id.success || !service.cancel(id.data)) {
        response
          .status(404)
          .json({ error: { code: 'not_found', message: 'Evaluación no encontrada.' } });
        return;
      }
      response.status(204).end();
    } catch (error) {
      response.status(503).json(publicError(error));
    }
  });
  router.put('/:id/reports/:reportId/reviews', (request, response) => {
    try {
      const id = z.uuid().parse(request.params.id);
      const reportId = z.uuid().parse(request.params.reportId);
      if (!request.is('application/json')) throw new AppError('invalid_review');
      service.saveReview(id, reportId, request.body);
      response.status(204).end();
    } catch {
      response.status(400).json(publicError(new AppError('invalid_review')));
    }
  });
  return router;
}
