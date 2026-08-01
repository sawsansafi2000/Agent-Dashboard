import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const YOUTUBE_CLIENT_ID = process.env.YOUTUBE_CLIENT_ID;
const YOUTUBE_CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;
const YOUTUBE_REDIRECT_URI = process.env.YOUTUBE_REDIRECT_URI;

const oauth2Client = new OAuth2Client(
  YOUTUBE_CLIENT_ID,
  YOUTUBE_CLIENT_SECRET,
  YOUTUBE_REDIRECT_URI
);

export const youtubeService = {
  authenticate: async (refreshToken: string) => {
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    return oauth2Client;
  },

  getChannelInfo: async (channelId: string) => {
    const youtube = google.youtube({
      version: 'v3',
      auth: oauth2Client,
    });

    const response = await youtube.channels.list({
      part: 'snippet,contentDetails',
      id: channelId,
    });

    return response.data.items[0];
  },

  searchVideos: async (query: string) => {
    const youtube = google.youtube({
      version: 'v3',
      auth: oauth2Client,
    });

    const response = await youtube.search.list({
      part: 'snippet',
      q: query,
      type: 'video',
      maxResults: 10,
    });

    return response.data.items;
  },

  getVideoDetails: async (videoId: string) => {
    const youtube = google.youtube({
      version: 'v3',
      auth: oauth2Client,
    });

    const response = await youtube.videos.list({
      part: 'snippet,contentDetails,statistics',
      id: videoId,
    });

    return response.data.items[0];
  },
};