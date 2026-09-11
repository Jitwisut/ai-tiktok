import { NextRequest, NextResponse } from "next/server";
import { getStripeClient } from "@/lib/billing/stripe";
import { grantCreditsFromEvent } from "@/services/billing.service";

export async function POST(request: NextRequest) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return NextResponse.json({ error: "Webhook not configured" }, { status: 503 });
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  const payload = await request.text();

  let event;
  try {
    const stripe = getStripeClient();
    event = stripe.webhooks.constructEvent(payload, signature, webhookSecret);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid signature";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    const result = await grantCreditsFromEvent(event);
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    // A permanently-unprocessable event (e.g. the user was deleted after
    // checkout) must not 500 — Stripe retries 5xx responses for days.
    // Acknowledge receipt so Stripe stops retrying; log for manual follow-up.
    console.error("billing webhook: failed to process event", event.id, err);
    return NextResponse.json({ ok: true, error: "processing_failed" }, { status: 200 });
  }
}
