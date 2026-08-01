import React, { useEffect, useState } from 'react';
import { fetchActiveAgents } from '../services/api';

const AgentList: React.FC = () => {
    const [agents, setAgents] = useState<any[]>([]);
    const [loading, setLoading] = useState<boolean>(true);

    useEffect(() => {
        const getActiveAgents = async () => {
            try {
                const response = await fetchActiveAgents();
                setAgents(response.data);
            } catch (error) {
                console.error('Error fetching active agents:', error);
            } finally {
                setLoading(false);
            }
        };

        getActiveAgents();
        const interval = setInterval(getActiveAgents, 300000); // Refresh every 5 minutes

        return () => clearInterval(interval); // Cleanup on unmount
    }, []);

    if (loading) {
        return <div>Loading agents...</div>;
    }

    return (
        <div>
            <h2>Active Agents</h2>
            <ul>
                {agents.map(agent => (
                    <li key={agent.id}>{agent.name}</li>
                ))}
            </ul>
        </div>
    );
};

export default AgentList;