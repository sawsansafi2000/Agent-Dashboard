import express from 'express';
import fs from 'fs';
import path from 'path';
import { KillSwitchManager } from './kill-switch/manager';

const app = express();
const port = process.env.PORT || 3000;
const host = process.env.HOST || '0.0.0.0';
const killSwitchManager = new KillSwitchManager();

const checkKillSwitch = async (req, res, next) => {
    const isActive = await killSwitchManager.isActive();
    if (isActive) {
        return res.status(503).send('Service is temporarily unavailable due to Kill-Switch activation.');
    }
    next();
};

app.use(checkKillSwitch);

app.get('/', (req, res) => {
    res.send('Welcome to the Kill-Switch Project!');
});

// Additional routes can be defined here

app.listen(port, host, () => {
    console.log(`Server is running on http://${host}:${port}`);
});