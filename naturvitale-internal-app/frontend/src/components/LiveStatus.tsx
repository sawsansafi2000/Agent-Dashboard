import React, { useEffect, useState } from 'react';
import { fetchLiveStatus } from '../services/api';

const LiveStatus: React.FC = () => {
    const [status, setStatus] = useState([]);
    const [loading, setLoading] = useState(true);

    const updateStatus = async () => {
        setLoading(true);
        const liveStatusData = await fetchLiveStatus();
        setStatus(liveStatusData);
        setLoading(false);
    };

    useEffect(() => {
        updateStatus();
        const interval = setInterval(updateStatus, 300000); // Update every 5 minutes
        return () => clearInterval(interval);
    }, []);

    return (
        <div>
            <h2>Live Status</h2>
            {loading ? (
                <p>Loading...</p>
            ) : (
                <ul>
                    {status.map((agent, index) => (
                        <li key={index}>
                            {agent.name}: {agent.active ? 'Active' : 'Inactive'}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
};

export default LiveStatus;