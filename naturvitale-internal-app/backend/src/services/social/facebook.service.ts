import axios from 'axios';

class FacebookService {
    private accessToken: string;

    constructor(accessToken: string) {
        this.accessToken = accessToken;
    }

    public async getUserProfile(userId: string): Promise<any> {
        try {
            const response = await axios.get(`https://graph.facebook.com/v12.0/${userId}`, {
                params: {
                    access_token: this.accessToken,
                    fields: 'id,name,email,picture'
                }
            });
            return response.data;
        } catch (error) {
            throw new Error(`Failed to fetch user profile: ${error.message}`);
        }
    }

    public async postToFeed(message: string): Promise<any> {
        try {
            const response = await axios.post(`https://graph.facebook.com/v12.0/me/feed`, {
                message: message,
                access_token: this.accessToken
            });
            return response.data;
        } catch (error) {
            throw new Error(`Failed to post to feed: ${error.message}`);
        }
    }

    // Additional methods for interacting with the Facebook API can be added here
}

export default FacebookService;