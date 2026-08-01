import express from 'express';
import { checkKillSwitchStatus } from './kill-switch';

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// Middleware to check Kill-Switch status
app.use((req, res, next) => {
    if (checkKillSwitchStatus()) {
        return res.status(503).send('Service is temporarily unavailable due to Kill-Switch activation.');
    }
    next();
});

// Define routes
app.get('/', (req, res) => {
    res.send('Welcome to the Kill-Switch Project!');
});

// Start the server
app.listen(PORT, HOST, () => {
    console.log(`Server is running on http://${HOST}:${PORT}`);
});