import axios from 'axios';

const XING_API_BASE_URL = 'https://api.xing.com/v1';

class XingService {
    private accessToken: string;

    constructor(accessToken: string) {
        this.accessToken = accessToken;
    }

    private async makeRequest(endpoint: string, method: 'GET' | 'POST' = 'GET', data?: any) {
        const url = `${XING_API_BASE_URL}${endpoint}`;
        const headers = {
            Authorization: `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json',
        };

        try {
            const response = await axios({
                url,
                method,
                headers,
                data,
            });
            return response.data;
        } catch (error) {
            throw new Error(`Xing API request failed: ${error.message}`);
        }
    }

    public async getUserProfile() {
        return this.makeRequest('/users/me');
    }

    public async searchContacts(query: string) {
        return this.makeRequest(`/search/contacts?query=${encodeURIComponent(query)}`);
    }

    public async postStatusUpdate(message: string) {
        return this.makeRequest('/statuses', 'POST', { message });
    }
}

export default XingService;