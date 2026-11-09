'use strict';

function getStripeProducts() {
    const rawCatalog = process.env.STRIPE_PRODUCT_CATALOG;
    if (!rawCatalog) return [];

    let products;
    try {
        products = JSON.parse(rawCatalog);
    } catch {
        throw new Error('STRIPE_PRODUCT_CATALOG muss gültiges JSON enthalten.');
    }

    if (!Array.isArray(products) || products.length === 0 || products.length > 30) {
        throw new Error('STRIPE_PRODUCT_CATALOG muss 1 bis 30 Produkte enthalten.');
    }

    const ids = new Set();
    return products.map((product) => {
        if (!product || typeof product !== 'object') {
            throw new Error('Jeder Stripe-Katalogeintrag muss ein Produktobjekt sein.');
        }
        const { id, name, description, unitAmountCents, recurringInterval } = product;
        if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{1,39}$/.test(id) || ids.has(id)) {
            throw new Error('Jede Stripe-Produkt-ID muss eindeutig sein und nur Kleinbuchstaben, Zahlen, _ oder - enthalten.');
        }
        if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) {
            throw new Error(`Produkt ${id} benötigt einen Namen mit höchstens 80 Zeichen.`);
        }
        if (description !== undefined && (typeof description !== 'string' || description.length > 300)) {
            throw new Error(`Die Beschreibung für ${id} darf höchstens 300 Zeichen enthalten.`);
        }
        if (!Number.isInteger(unitAmountCents) || unitAmountCents < 9900 || unitAmountCents > 3000000) {
            throw new Error(`Der Preis für ${id} muss zwischen 99 € und 30.000 € liegen (in Cent).`);
        }
        if (recurringInterval !== undefined && !['month', 'year'].includes(recurringInterval)) {
            throw new Error(`Das Abrechnungsintervall für ${id} muss month oder year sein.`);
        }
        ids.add(id);
        return {
            id,
            name: name.trim(),
            description: (description || '').trim(),
            unitAmountCents,
            currency: 'eur',
            recurringInterval: recurringInterval || null,
        };
    });
}

module.exports = { getStripeProducts };
