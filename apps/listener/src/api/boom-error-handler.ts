import Boom from '@hapi/boom';
import type { NextFunction, Request, Response } from 'express';

export function boomErrorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  const boom = (() => {
    if (Boom.isBoom(error)) return error;
    if (error instanceof Error) return Boom.boomify(error);
    const message = typeof error === 'string' ? error : 'Unexpected non-error throwable';
    return Boom.badImplementation(message);
  })();
  res.status(boom.output.statusCode).json(boom.output.payload);
}
