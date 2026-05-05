import type { ErrorRequestHandler } from 'express';
import Boom from '@hapi/boom';

export const boomErrorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  if (Boom.isBoom(err)) {
    const { statusCode, payload } = err.output;
    return res.status(statusCode).json(payload);
  }

  console.error('[Worker] Unhandled error:', err);
  const internal = Boom.internal();
  return res.status(internal.output.statusCode).json(internal.output.payload);
};
