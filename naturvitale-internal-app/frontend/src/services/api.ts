import axios from 'axios';

const isLocalDevelopment = window.location.port !== '';
const apiBaseUrl = isLocalDevelopment
    ? `${window.location.protocol}//${window.location.hostname}:3000/api`
    : `${window.location.origin}/api`;

const apiClient = axios.create({
    baseURL: apiBaseUrl,
    timeout: 10000, // Set a timeout for requests
    headers: {
        'Content-Type': 'application/json',
    },
});

// Function to handle login
export const login = async (email, password) => {
    try {
        const response = await apiClient.post('/auth/login', { email, password });
        return response.data;
    } catch (error) {
        throw error.response ? error.response.data : error.message;
    }
};

// Function to fetch dashboard data
export const fetchDashboardData = async () => {
    try {
        const response = await apiClient.get('/admin/dashboard');
        return response.data;
    } catch (error) {
        throw error.response ? error.response.data : error.message;
    }
};

// Function to fetch active agents
export const fetchActiveAgents = async () => {
    try {
        const response = await apiClient.get('/admin/agents');
        return response.data;
    } catch (error) {
        throw error.response ? error.response.data : error.message;
    }
};

// Function to fetch social media statistics
export const fetchSocialMediaStats = async () => {
    try {
        const response = await apiClient.get('/admin/social-stats');
        return response.data;
    } catch (error) {
        throw error.response ? error.response.data : error.message;
    }
};