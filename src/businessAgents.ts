export interface FeasibilityAssessment {
    score: number;
    verdict: 'go' | 'validate' | 'hold';
    risks: string[];
    missingRequirements: string[];
    technicalApproach: string;
}

export interface SalesPlan {
    channels: string[];
    pricingModel: string;
    firstCustomerProfile: string;
    validationKpis: string[];
}

export interface ProjectPlan {
    slug: string;
    stage: 'discovery' | 'validation' | 'on-hold';
    progress: number;
    ownerAgent: string;
    nextMilestone: string;
    sales: {
        revenue: number;
        orders: number;
        currency: 'EUR';
        source: 'not-connected';
    };
}

export interface AnalyzableIdea {
    title: string;
    summary: string;
    targetMarkets: string[];
    businessModel: string;
    scalability: string;
    nextSteps: string[];
}

export interface EnrichedIdea extends AnalyzableIdea {
    feasibility: FeasibilityAssessment;
    salesPlan: SalesPlan;
    project: ProjectPlan;
}

function includesAny(text: string, terms: string[]): boolean {
    return terms.some(term => text.includes(term));
}

function slugify(value: string): string {
    return value
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '')
        .slice(0, 72);
}

export function runFeasibilityAgent(idea: AnalyzableIdea): FeasibilityAssessment {
    const text = [idea.title, idea.summary, idea.businessModel, idea.scalability, ...idea.nextSteps].join(' ').toLowerCase();
    const isRegulated = includesAny(text, ['gesund', 'ernährung', 'therap', 'heil', 'supplement', 'haut', 'mental']);
    const needsHardware = includesAny(text, ['hardware', 'sensor', 'gerät', 'vr', 'farm', 'verpackungssystem']);
    const isMarketplace = includesAny(text, ['marktplatz', 'marketplace', 'plattform', 'vermittelt', 'buchung']);
    const hasPilot = includesAny(text, ['pilot', 'mvp', 'prototyp', 'beta', 'test']);
    const hasRecurringRevenue = includesAny(text, ['abo', 'abonnement', 'mitglied', 'lizenz', 'monatlich', 'jährlich']);
    let score = 52 + (hasPilot ? 12 : 0) + (hasRecurringRevenue ? 8 : 0) - (isRegulated ? 12 : 0) - (needsHardware ? 10 : 0) - (isMarketplace ? 6 : 0);
    score = Math.max(20, Math.min(90, score));

    const risks: string[] = [];
    const missingRequirements: string[] = [];
    if (isRegulated) {
        risks.push('Regulatorische Einordnung und zulässige Werbeaussagen sind vor dem Vertrieb zu klären.');
        missingRequirements.push('Rechts- und Compliance-Prüfung für die gewählten Zielmärkte');
    }
    if (needsHardware) {
        risks.push('Hardware, Zertifizierung und Lieferkette erhöhen Kapitalbedarf und Vorlaufzeit.');
        missingRequirements.push('Prototypkosten, Fertigungspartner und Zertifizierungsplan');
    }
    if (isMarketplace) {
        risks.push('Angebot und Nachfrage müssen in einem eng begrenzten Startmarkt gleichzeitig aufgebaut werden.');
        missingRequirements.push('Konkrete Startnische mit ersten Anbietern und Käufern');
    }
    if (!hasPilot) missingRequirements.push('Messbarer Pilot mit Zeitplan, Budget und Abbruchkriterien');
    missingRequirements.push('Unit Economics mit CAC, Marge, Retention und Break-even');

    return {
        score,
        verdict: score >= 68 ? 'go' : score >= 45 ? 'validate' : 'hold',
        risks: risks.length ? risks : ['Nachfrage und Zahlungsbereitschaft sind noch nicht durch echte Kundendaten belegt.'],
        missingRequirements,
        technicalApproach: needsHardware
            ? 'Zuerst mit Standardkomponenten und manuellem Backend pilotieren; Eigenentwicklung erst nach Nachfragebeleg.'
            : 'Schlanken Web-MVP mit bestehender Zahlungs-, CRM- und Analytics-Infrastruktur bauen.',
    };
}

export function runSalesAgent(idea: AnalyzableIdea, feasibility: FeasibilityAssessment): SalesPlan {
    const text = [idea.title, idea.summary, idea.businessModel, ...idea.targetMarkets].join(' ').toLowerCase();
    const isB2b = includesAny(text, ['b2b', 'unternehmen', 'kmus', 'hersteller', 'einzelhändler', 'bildungseinrichtung']);
    const recurring = includesAny(text, ['abo', 'abonnement', 'mitglied', 'lizenz', 'monatlich', 'jährlich']);
    return {
        channels: isB2b
            ? ['Founder-led Outbound', 'Branchenpartnerschaften', 'Bezahlter Pilot mit Referenzkunde']
            : ['Landingpage mit Warteliste', 'Creator-Partnerschaften', 'Performance-Marketing erst nach Conversion-Beleg'],
        pricingModel: recurring
            ? 'Dreistufiges Monatsabo; Preis im Pilot über Zahlungsbereitschaftstests bestimmen.'
            : 'Bezahlter Pilot oder Vorverkauf; Zielmarge und Servicekosten vor Skalierung validieren.',
        firstCustomerProfile: isB2b
            ? `Ein klar benannter Entscheider in einem kleinen Segment von ${idea.targetMarkets[0] ?? 'DACH'}.`
            : `Frühe Nutzer mit akutem Bedarf in ${idea.targetMarkets[0] ?? 'DACH'} und bestehendem Kaufverhalten.`,
        validationKpis: feasibility.verdict === 'hold'
            ? ['10 Problem-Interviews', '3 belastbare Kaufabsichten', 'Regulatorische Freigabe']
            : ['Landingpage-Conversion', 'CAC je Kanal', 'Deckungsbeitrag', '30-/90-Tage-Retention'],
    };
}

export function runProjectAgent(idea: AnalyzableIdea, feasibility: FeasibilityAssessment): ProjectPlan {
    const stage = feasibility.verdict === 'go' ? 'validation' : feasibility.verdict === 'validate' ? 'discovery' : 'on-hold';
    return {
        slug: slugify(idea.title),
        stage,
        progress: stage === 'validation' ? 25 : stage === 'discovery' ? 10 : 0,
        ownerAgent: 'project-delivery-agent',
        nextMilestone: feasibility.missingRequirements[0] ?? 'Pilotumfang und Erfolgskriterien festlegen',
        sales: { revenue: 0, orders: 0, currency: 'EUR', source: 'not-connected' },
    };
}

export function runBusinessAgentPipeline(idea: AnalyzableIdea): EnrichedIdea {
    const feasibility = runFeasibilityAgent(idea);
    const salesPlan = runSalesAgent(idea, feasibility);
    const project = runProjectAgent(idea, feasibility);
    return { ...idea, feasibility, salesPlan, project };
}