import { Agent } from '../models/agent';
import db from '../db/index';

export const getActiveAgents = async (): Promise<Agent[]> => {
    const query = 'SELECT * FROM agents WHERE status = ?';
    const params = ['active'];
    const rows = await db.all(query, params);
    return rows.map(row => new Agent(row.id, row.name, row.status, row.progress));
};

export const updateAgentProgress = async (agentId: number, progress: number): Promise<void> => {
    const query = 'UPDATE agents SET progress = ? WHERE id = ?';
    const params = [progress, agentId];
    await db.run(query, params);
};