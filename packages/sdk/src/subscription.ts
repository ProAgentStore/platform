/** Stripe subscription management. */
export interface SubscriptionClient {
  checkout(): Promise<{ url: string }>;
  portal(): Promise<{ url: string }>;
  status(): Promise<{ active: boolean; tier: string; expiresAt: string }>;
}
