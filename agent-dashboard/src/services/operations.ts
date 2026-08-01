import { BusinessIdea } from './ideaStore';

export interface AgentDefinition {
    id: string;
    name: string;
    role: string;
    description: string;
    input: string;
    output: string;
    link: string;
}

export const agentCatalog: AgentDefinition[] = [
    {
        id: 'innovation-agent',
        name: 'Innovation Agent',
        role: 'Ideenentwicklung',
        description: 'Erzeugt differenzierte Geschäftsideen unter den Natur-Vitale-Guardrails.',
        input: 'Bestehende Ideen und manuelle Impulse',
        output: 'Neue strukturierte Geschäftsideen',
        link: '/dashboard/agents/innovation-agent',
    },
    {
        id: 'feasibility-agent',
        name: 'Feasibility Agent',
        role: 'Machbarkeit und Risiko',
        description: 'Bewertet Regulierung, Technik, Kapitalbedarf und offene Voraussetzungen.',
        input: 'Strukturierte Geschäftsidee',
        output: 'Score, Entscheidung, Risiken und fehlende Nachweise',
        link: '/dashboard/agents/feasibility-agent',
    },
    {
        id: 'sales-agent',
        name: 'Sales Agent',
        role: 'Vertrieb und Monetarisierung',
        description: 'Definiert Startkundschaft, Kanäle, Preislogik und messbare Vertriebs-KPIs.',
        input: 'Idee und Machbarkeitsbewertung',
        output: 'Go-to-Market- und Validierungsplan',
        link: '/dashboard/agents/sales-agent',
    },
    {
        id: 'project-delivery-agent',
        name: 'Project Delivery Agent',
        role: 'Umsetzung und Fortschritt',
        description: 'Überführt bewertete Ideen in Discovery, Validierung oder Wartestatus.',
        input: 'Bewertete Idee und Vertriebsplan',
        output: 'Projektstufe, Fortschritt und nächster Meilenstein',
        link: '/dashboard/agents/project-delivery-agent',
    },
];

export interface PortfolioProject {
    slug: string;
    title: string;
    stage: string;
    progress: number;
    score: number | null;
    verdict: string;
    nextMilestone: string;
    revenue: number;
    orders: number;
    currency: string;
    salesSource: string;
    link: string;
    idea: BusinessIdea;
}

export function getPortfolioProjects(ideas: BusinessIdea[]): PortfolioProject[] {
    return ideas
        .filter(idea => Boolean(idea.project))
        .map(idea => {
            const slug = `${idea.project!.slug}-${idea.id.slice(0, 8)}`;
            return ({
            slug,
            title: idea.title,
            stage: idea.project!.stage,
            progress: idea.project!.progress,
            score: idea.feasibility?.score ?? null,
            verdict: idea.feasibility?.verdict ?? 'pending',
            nextMilestone: idea.project!.nextMilestone,
            revenue: idea.project!.sales.revenue,
            orders: idea.project!.sales.orders,
            currency: idea.project!.sales.currency,
            salesSource: idea.project!.sales.source,
            link: `/dashboard/projects/${slug}`,
            idea,
        });
        })
        .sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
}