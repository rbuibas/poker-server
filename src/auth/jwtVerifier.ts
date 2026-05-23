import { jwtVerify } from 'jose';

export interface VerifiedClaims {
  userId: string;
}

export class JwtVerifier {
  private readonly key: Uint8Array;

  constructor(secret: string) {
    this.key = new TextEncoder().encode(secret);
  }

  async verify(token: string): Promise<VerifiedClaims> {
    const { payload } = await jwtVerify(token, this.key, {
      algorithms: ['HS256'],
    });
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new Error('jwt missing sub claim');
    }
    return { userId: payload.sub };
  }
}
