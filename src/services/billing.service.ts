import type Stripe from "stripe";
import { prisma } from "@/lib/db/prisma";
import { getStripeClient } from "@/lib/billing/stripe";
import { getCreditPackage } from "@/lib/billing/packages";

export async function createCheckoutSession(
  userId: string,
  packageId: string,
  origin: string,
) {
  const pkg = getCreditPackage(packageId);
  if (!pkg) return { error: "unknown_package" as const };

  const stripe = getStripeClient();
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    client_reference_id: userId,
    metadata: { userId, packageId },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "thb",
          unit_amount: pkg.priceThb * 100,
          product_data: { name: `${pkg.label} — ${pkg.credits} เครดิต` },
        },
      },
    ],
    success_url: `${origin}/settings?billing=success`,
    cancel_url: `${origin}/settings?billing=cancelled`,
  });

  return { url: session.url };
}

/**
 * The real, testable part of billing: given a verified checkout.session.completed
 * event, grant the purchased credits exactly once. Deliberately takes a plain
 * event shape (not a live Stripe call) so it can be tested with a constructed
 * event object, no Stripe account required.
 */
export async function grantCreditsFromEvent(event: Stripe.Event) {
  if (event.type !== "checkout.session.completed") {
    return { skipped: true as const };
  }

  const session = event.data.object as Stripe.Checkout.Session;
  const userId = session.client_reference_id ?? session.metadata?.userId;
  const packageId = session.metadata?.packageId;

  if (!userId || !packageId) {
    return { error: "missing_metadata" as const };
  }

  const pkg = getCreditPackage(packageId);
  if (!pkg) {
    return { error: "unknown_package" as const };
  }

  // Idempotency: Stripe retries webhook delivery, so re-processing the same
  // event must not double-credit the user.
  const existing = await prisma.creditTransaction.findFirst({
    where: { referenceId: event.id, type: "purchase" },
  });
  if (existing) {
    return { skipped: true as const, reason: "already_processed" as const };
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: { credits: { increment: pkg.credits } },
    }),
    prisma.creditTransaction.create({
      data: {
        userId,
        type: "purchase",
        amount: pkg.credits,
        referenceId: event.id,
        description: `Purchased ${pkg.label} package (${pkg.credits} credits)`,
      },
    }),
  ]);

  return { granted: pkg.credits };
}
