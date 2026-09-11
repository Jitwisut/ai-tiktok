import Stripe from "stripe";

let client: Stripe | undefined;

/** Throws until STRIPE_SECRET_KEY is set — no Stripe account exists for this project yet. */
export function getStripeClient(): Stripe {
  if (client) return client;

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error("STRIPE_SECRET_KEY is not set — billing is not configured yet");
  }

  client = new Stripe(key);
  return client;
}
