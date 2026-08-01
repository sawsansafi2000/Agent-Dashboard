import React, { useEffect, useState } from 'react';
import { fetchDashboardData } from '../services/api';
import AgentList from '../components/AgentList';
import LiveStatus from '../components/LiveStatus';

const Dashboard: React.FC = () => {
    const [dashboardData, setDashboardData] = useState(null);
    const [loading, setLoading] = useState(true);

    const updateDashboardData = async () => {
        setLoading(true);
        const data = await fetchDashboardData();
        setDashboardData(data);
        setLoading(false);
    };

    useEffect(() => {
        updateDashboardData();
        const interval = setInterval(updateDashboardData, 300000); // Update every 5 minutes
        return () => clearInterval(interval);
    }, []);

    if (loading) {
        return <div>Loading...</div>;
    }

    return (
        <div>
            <h1>Dashboard</h1>
            <LiveStatus data={dashboardData?.liveStatus} />
            <AgentList agents={dashboardData?.agents} />
        </div>
    );
};

export default Dashboard;