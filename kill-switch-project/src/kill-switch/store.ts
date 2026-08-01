import { readFileSync } from 'fs';
import { KillSwitchStatus } from './types';

export class KillSwitchStore {
    private static instance: KillSwitchStore;
    private status: KillSwitchStatus;

    private constructor() {
        this.status = this.readStatus();
    }

    public static getInstance(): KillSwitchStore {
        if (!KillSwitchStore.instance) {
            KillSwitchStore.instance = new KillSwitchStore();
        }
        return KillSwitchStore.instance;
    }

    private readStatus(): KillSwitchStatus {
        try {
            const data = readFileSync('STOP.txt', 'utf8').trim();
            return data === 'ACTIVE' ? KillSwitchStatus.ACTIVE : KillSwitchStatus.INACTIVE;
        } catch (error) {
            console.error('Error reading STOP.txt:', error);
            return KillSwitchStatus.INACTIVE;
        }
    }

    public getStatus(): KillSwitchStatus {
        return this.status;
    }

    public refreshStatus(): void {
        this.status = this.readStatus();
    }
}