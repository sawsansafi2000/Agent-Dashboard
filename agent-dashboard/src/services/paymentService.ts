import Stripe from 'stripe';

const MINIMUM_AMOUNT_CENTS = 100;
const MAXIMUM_AMOUNT_CENTS = 1_000_000;

function getStripeClient(): Stripe {
    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
        throw new Error('STRIPE_SECRET_KEY ist nicht konfiguriert.');
    }
    return new Stripe(secretKey, { apiVersion: '2022-11-15' });
}

export function isStripeConfigured(): boolean {
    return Boolean(process.env.STRIPE_SECRET_KEY);
}

export function parseEuroAmount(value: unknown): number {
    const normalized = String(value ?? '').trim().replace(',', '.');
    if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
        throw new Error('Bitte einen gueltigen Betrag mit maximal zwei Nachkommastellen eingeben.');
    }
    const amountCents = Math.round(Number(normalized) * 100);
    if (amountCents < MINIMUM_AMOUNT_CENTS || amountCents > MAXIMUM_AMOUNT_CENTS) {
        throw new Error('Der Betrag muss zwischen 1,00 EUR und 10.000,00 EUR liegen.');
    }
    return amountCents;
}

export async function createProjectCheckout(input: {
    projectSlug: string;
    projectTitle: string;
    amountCents: number;
    origin: string;
    successPath?: string;
    cancelPath?: string;
}): Promise<string> {
    const session = await getStripeClient().checkout.sessions.create({
        mode: 'payment',
        locale: 'de',
        billing_address_collection: 'auto',
        line_items: [{
            quantity: 1,
            price_data: {
                currency: 'eur',
                unit_amount: input.amountCents,
                product_data: {
                    name: `Pilot-Strategie-Session: ${input.projectTitle}`,
                    description: '45 Minuten Online-Strategiegespraech zur gemeinsamen Pilotvalidierung.',
                },
            },
        }],
        metadata: { projectSlug: input.projectSlug },
        success_url: `${input.origin}${input.successPath ?? '/dashboard/payments/success'}?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${input.origin}${input.cancelPath ?? `/dashboard/projects/${encodeURIComponent(input.projectSlug)}`}?payment=cancelled`,
    });
    if (!session.url) {
        throw new Error('Stripe hat keine Checkout-URL geliefert.');
    }
    return session.url;
}

export async function getCheckoutResult(sessionId: string): Promise<{
    paid: boolean;
    amount: string;
    projectSlug: string | null;
}> {
    const session = await getStripeClient().checkout.sessions.retrieve(sessionId);
    return {
        paid: session.payment_status === 'paid',
        amount: new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' })
            .format((session.amount_total ?? 0) / 100),
        projectSlug: session.metadata?.projectSlug ?? null,
    };
}