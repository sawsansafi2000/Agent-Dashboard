export interface Agent {
    id: number;
    name: string;
    status: string;
    progress: number;
}

export class AgentModel {
    private agents: Agent[] = [];

    constructor() {
        // Initialize with some dummy data or fetch from the database
    }

    public getAllAgents(): Agent[] {
        return this.agents;
    }

    public getAgentById(id: number): Agent | undefined {
        return this.agents.find(agent => agent.id === id);
    }

    public addAgent(agent: Agent): void {
        this.agents.push(agent);
    }

    public updateAgentStatus(id: number, status: string, progress: number): void {
        const agent = this.getAgentById(id);
        if (agent) {
            agent.status = status;
            agent.progress = progress;
        }
    }
}