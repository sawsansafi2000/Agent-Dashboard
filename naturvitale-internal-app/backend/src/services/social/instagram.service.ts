import axios from 'axios';

const INSTAGRAM_API_URL = 'https://graph.instagram.com';

class InstagramService {
    private accessToken: string;

    constructor(accessToken: string) {
        this.accessToken = accessToken;
    }

    async getUserProfile() {
        try {
            const response = await axios.get(`${INSTAGRAM_API_URL}/me`, {
                params: {
                    fields: 'id,username,name',
                    access_token: this.accessToken,
                },
            });
            return response.data;
        } catch (error) {
            throw new Error('Error fetching user profile from Instagram: ' + error.message);
        }
    }

    async getUserMedia() {
        try {
            const response = await axios.get(`${INSTAGRAM_API_URL}/me/media`, {
                params: {
                    access_token: this.accessToken,
                },
            });
            return response.data;
        } catch (error) {
            throw new Error('Error fetching user media from Instagram: ' + error.message);
        }
    }

    async postMedia(mediaData: any) {
        try {
            const response = await axios.post(`${INSTAGRAM_API_URL}/me/media`, {
                ...mediaData,
                access_token: this.accessToken,
            });
            return response.data;
        } catch (error) {
            throw new Error('Error posting media to Instagram: ' + error.message);
        }
    }
}

export default InstagramService;