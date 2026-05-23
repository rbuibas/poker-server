import { z } from 'zod';

const UUID = z.string().uuid();
const PositiveInt = z.number().int().positive();
const NonNegativeInt = z.number().int().nonnegative();

export const PlayerActionSchema = z
  .object({
    type: z.enum(['fold', 'check', 'call', 'bet', 'raise', 'all_in']),
    amount: PositiveInt.optional(),
  })
  .refine(
    (a) => {
      // bet and raise require an amount; the others must not have one
      if (a.type === 'bet' || a.type === 'raise') return a.amount !== undefined;
      return a.amount === undefined;
    },
    { message: 'invalid amount for action type' },
  );

export const SessionStartSchema = z.object({ loungeId: UUID });
export const SessionJoinRoomSchema = z.object({ loungeId: UUID });
export const SessionSitDownSchema = z.object({
  loungeId: UUID,
  seat: NonNegativeInt,
  buyIn: PositiveInt,
});
export const SessionStandUpSchema = z.object({ loungeId: UUID });
export const SessionRebuySchema = z.object({
  loungeId: UUID,
  amount: PositiveInt,
});
export const SessionSitOutSchema = z.object({
  loungeId: UUID,
  sitOut: z.boolean(),
});
export const SessionKickSchema = z.object({
  loungeId: UUID,
  targetUserId: UUID,
});
export const SessionLeaveRoomSchema = z.object({ loungeId: UUID });
export const HandStartSchema = z.object({ loungeId: UUID });
export const HandActionSchema = z.object({
  loungeId: UUID,
  action: PlayerActionSchema,
});
