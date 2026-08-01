import { RequestHandler } from 'express';
import Stripe from 'stripe';
import { OrderConfirmationInput, sendOrderConfirmation } from '../services/emailService';
import { OrderStore } from '../services/orderStore';

export function createStripeWebhookHandler(
    store: OrderStore,
    sendConfirmation: (input: OrderConfirmationInput) => Promise<void> = sendOrderConfirmation,
): RequestHandler {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_webhook_validation', { apiVersion: '2022-11-15' });
    return async (req, res) => {
        const secret = process.env.STRIPE_WEBHOOK_SECRET;
        const signature = req.get('stripe-signature');
        if (!secret || !signature || !Buffer.isBuffer(req.body)) {
            res.status(400).json({ error: 'Stripe-Webhook ist nicht vollständig konfiguriert.' });
            return;
        }

        let event: Stripe.Event;
        try {
            event = stripe.webhooks.constructEvent(req.body, signature, secret);
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : 'Ungültige Stripe-Signatur.' });
            return;
        }

        if (event.type.startsWith('checkout.session.')) {
            const session = event.data.object as Stripe.Checkout.Session;
            const result = await store.recordCheckoutEvent({
                eventId: event.id,
                order: {
                    checkoutSessionId: session.id,
                    projectSlug: session.metadata?.projectSlug || null,
                    paymentStatus: session.payment_status || 'unpaid',
                    amountTotal: session.amount_total || 0,
                    currency: session.currency || 'eur',
                    customerEmail: session.customer_details?.email || null,
                    updatedAt: new Date(event.created * 1_000).toISOString(),
                },
            });
            if (
                !result.duplicate
                && event.type === 'checkout.session.completed'
                && result.order.paymentStatus === 'paid'
                && result.order.customerEmail
            ) {
                try {
                    await sendConfirmation({
                        customerEmail: result.order.customerEmail,
                        amountTotal: result.order.amountTotal,
                        currency: result.order.currency,
                        projectSlug: result.order.projectSlug,
                    });
                } catch (error) {
                    await store.releaseCheckoutEvent(event.id);
                    res.status(500).json({ error: error instanceof Error ? error.message : 'E-Mail-Versand fehlgeschlagen.' });
                    return;
                }
            }
        }
        res.json({ received: true });
    };
}