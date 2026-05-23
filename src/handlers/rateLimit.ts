/** Simple per-socket token bucket. 10 tokens/sec, capacity 10. */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number = 10,
    private readonly refillPerSec: number = 10,
  ) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  tryConsume(cost: number = 1): boolean {
    this.refill();
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }

  private refill(): void {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefill) / 1000;
    if (elapsedSec <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec);
    this.lastRefill = now;
  }
}
