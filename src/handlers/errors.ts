import {
  CannotStartHandError,
  HandInProgressError,
  IllegalSeatError,
  InsufficientChipsError,
  InvalidActionError,
  NoHandInProgressError,
  NotYourTurnError,
} from 'poker-engine';
import type { Socket } from 'socket.io';
import type { Logger } from '../logging.js';
import type { ErrorCode, ServerErrorPayload } from '../protocol/types.js';

export function emitError(
  socket: Socket,
  code: ErrorCode,
  message: string,
): void {
  const payload: ServerErrorPayload = { code, message };
  socket.emit('error', payload);
}

export function mapEngineError(err: unknown): { code: ErrorCode; message: string } {
  if (err instanceof NotYourTurnError) return { code: 'not_your_turn', message: err.message };
  if (err instanceof HandInProgressError) return { code: 'hand_in_progress', message: err.message };
  if (err instanceof NoHandInProgressError)
    return { code: 'no_hand_in_progress', message: err.message };
  if (err instanceof IllegalSeatError) return { code: 'seat_taken', message: err.message };
  if (err instanceof InsufficientChipsError)
    return { code: 'invalid_amount', message: err.message };
  if (err instanceof InvalidActionError) return { code: 'invalid_action', message: err.message };
  if (err instanceof CannotStartHandError)
    return { code: 'invalid_action', message: err.message };
  if (err instanceof Error) return { code: 'internal_error', message: err.message };
  return { code: 'internal_error', message: 'unknown error' };
}

export function handleEngineError(
  socket: Socket,
  logger: Logger,
  err: unknown,
  context: Record<string, unknown> = {},
): void {
  const { code, message } = mapEngineError(err);
  if (code === 'internal_error') {
    logger.error({ err, ...context }, 'internal_error in handler');
  } else {
    logger.debug({ code, message, ...context }, 'engine error mapped');
  }
  emitError(socket, code, message);
}
