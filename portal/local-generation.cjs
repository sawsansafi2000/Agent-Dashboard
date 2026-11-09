'use strict';

function text(value, limit) {
    return String(value || '').trim().slice(0, limit);
}

function generateLocalContent(name, input) {
    if (name === 'portal_business_idea') {
        const topic = text(input.topic, 100);
        const audience = text(input.audience, 120);
        return {
            title: `Pilot: ${topic}`,
            summary: `Prüfe mit einem begrenzten Pilot, ob ${audience} Bedarf an ${topic} hat. Dies ist eine Vorlage, keine Marktanalyse.`,
            businessModel: 'Ein klar begrenztes Angebot manuell mit potenziellen Kunden testen.',
            customerProfile: audience,
            valueProposition: `Den Bedarf an ${topic} mit der Zielgruppe konkretisieren und überprüfen.`,
            validationMetric: 'Anzahl qualifizierter Gespräche und bestätigter Pilotbuchungen.',
            offerTitle: `Pilot: ${topic}`,
            offerDescription: `Ein begrenztes Pilotangebot zu ${topic}; Umfang und Ergebnis vorab mit der Zielgruppe abstimmen.`,
            offerDeliverables: ['Bedarf und Ziel gemeinsam festhalten', 'Ergebnis des Piloten dokumentieren'],
            firstSteps: input.validationSteps,
        };
    }
    if (name === 'portal_business_workflow') {
        const goal = text(input.goal, 100);
        return {
            title: `Ablauf: ${goal}`,
            summary: `Manueller Ablauf für ${text(input.goal, 300)}. Zielgruppe: ${text(input.audience, 120)}.`,
            steps: ['Ausgangslage und gewünschtes Ergebnis festhalten.', 'Zuständigkeiten und Rahmenbedingungen prüfen.', 'Den nächsten Schritt manuell ausführen und Ergebnis dokumentieren.'],
            successMetric: 'Anteil der Vorgänge mit dokumentiertem Ergebnis.',
            approvalBoundary: 'Externe Aktionen und Ausgaben nur nach ausdrücklicher Freigabe.',
        };
    }
    if (name === 'portal_social_drafts') {
        const title = text(input.idea.title, 100);
        return {
            drafts: input.platforms.map(platform => ({
                platform: platform.id,
                post: `Thema: ${title}\n\n[Zielgruppe und belegbaren Nutzen ergänzen.]\n\n[Handlungsaufforderung ergänzen.]`.slice(0, platform.maximumPostLength),
                adHeadline: title,
                adCopy: `Entwurf zu ${title}. Bitte Nutzen, Zielgruppe und Werbeaussagen vor Verwendung ergänzen und prüfen.`,
                callToAction: 'Weitere Informationen anfragen',
            })),
        };
    }
    throw new Error(`Lokaler Generator für ${name} ist nicht verfügbar.`);
}

module.exports = { generateLocalContent };
