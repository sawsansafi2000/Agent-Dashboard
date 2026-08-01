import { useEffect, useState } from 'react';

const useRealtime = (endpoint: string) => {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    useEffect(() => {
        const fetchData = async () => {
            try {
                const response = await fetch(endpoint);
                if (!response.ok) {
                    throw new Error('Network response was not ok');
                }
                const result = await response.json();
                setData(result);
            } catch (err) {
                setError(err);
            } finally {
                setLoading(false);
            }
        };

        fetchData();

        const interval = setInterval(() => {
            fetchData();
        }, 300000); // Fetch data every 5 minutes

        return () => clearInterval(interval);
    }, [endpoint]);

    return { data, loading, error };
};

export default useRealtime;