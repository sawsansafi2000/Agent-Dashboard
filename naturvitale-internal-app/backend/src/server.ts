import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { config } from './config';
import { setupRoutes } from './routes';
import { connectToDatabase } from './db';

const app = express();
const server = createServer(app);
const io = new Server(server);

// Middleware setup
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Connect to the database
connectToDatabase();

// Setup routes
setupRoutes(app);

// Real-time updates
io.on('connection', (socket) => {
    console.log('A user connected');

    // Handle real-time events here

    socket.on('disconnect', () => {
        console.log('User disconnected');
    });
});

// Start the server
const PORT = config.port;
const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, () => {
    console.log(`Server is running on http://${HOST}:${PORT}`);
});