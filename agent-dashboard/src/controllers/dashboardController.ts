import { Request, Response } from 'express';
import { AgentService } from '../services/agentService';

export class DashboardController {
    private agentService: AgentService;

    constructor() {
        this.agentService = new AgentService();
    }

    public async getActiveAgents(req: Request, res: Response): Promise<void> {
        try {
            const activeAgents = await this.agentService.fetchActiveAgents();
            res.status(200).json(activeAgents);
        } catch (error) {
            res.status(500).json({ message: 'Error fetching active agents', error });
        }
    }

    public async getAgentProgress(req: Request, res: Response): Promise<void> {
        try {
            const agentId = req.params.id;
            const progress = await this.agentService.fetchAgentProgress(agentId);
            res.status(200).json(progress);
        } catch (error) {
            res.status(500).json({ message: 'Error fetching agent progress', error });
        }
    }
}