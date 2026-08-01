export interface OrderConfirmationInput {
    customerEmail: string;
    amountTotal: number;
    currency: string;
    projectSlug: string | null;
}

function requireEnvironment(name: 'BREVO_API_KEY' | 'SENDER_EMAIL' | 'SENDER_NAME'): string {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`${name} ist nicht konfiguriert.`);
    return value;
}

function escapeHtml(value: string): string {
    return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export async function sendOrderConfirmation(input: OrderConfirmationInput): Promise<void> {
    const apiKey = requireEnvironment('BREVO_API_KEY');
    const senderEmail = requireEnvironment('SENDER_EMAIL');
    const senderName = requireEnvironment('SENDER_NAME');
    const amount = new Intl.NumberFormat('de-DE', {
        style: 'currency',
        currency: input.currency.toUpperCase(),
    }).format(input.amountTotal / 100);
    const projectReference = input.projectSlug
        ? `<p>Referenz: <strong>${escapeHtml(input.projectSlug)}</strong></p>`
        : '';
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
            accept: 'application/json',
            'api-key': apiKey,
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            sender: { email: senderEmail, name: senderName },
            to: [{ email: input.customerEmail }],
            subject: 'Bestaetigung deiner NaturVitale Strategie-Session',
            htmlContent: [
                '<h1>Vielen Dank fuer deine Buchung.</h1>',
                '<p>Deine Zahlung ist bei uns eingegangen.</p>',
                `<p>Betrag: <strong>${escapeHtml(amount)}</strong></p>`,
                projectReference,
                '<p>Wir melden uns per E-Mail zur Terminabstimmung.</p>',
            ].join(''),
            textContent: [
                'Vielen Dank fuer deine Buchung.',
                'Deine Zahlung ist bei uns eingegangen.',
                `Betrag: ${amount}`,
                input.projectSlug ? `Referenz: ${input.projectSlug}` : '',
                'Wir melden uns per E-Mail zur Terminabstimmung.',
            ].filter(Boolean).join('\n\n'),
        }),
    });
    if (!response.ok) {
        const details = (await response.text()).slice(0, 500);
        throw new Error(`Brevo E-Mail-Versand fehlgeschlagen (HTTP ${response.status}): ${details}`);
    }
}