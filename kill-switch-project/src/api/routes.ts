import express from 'express';
import { checkKillSwitchStatus } from '../kill-switch/controller';

const router = express.Router();

// Route to check the status of the Kill-Switch
router.get('/kill-switch/status', async (req, res) => {
    try {
        const status = await checkKillSwitchStatus();
        res.json({ status });
    } catch (error) {
        res.status(500).json({ error: 'Failed to retrieve Kill-Switch status' });
    }
});

// Additional routes can be defined here

export default router;