import * as fs from 'fs';
import * as path from 'path';

const STOP_FILE_PATH = path.join(__dirname, '../../STOP.txt');

export class CLI {
    static readStopFile(): string {
        try {
            return fs.readFileSync(STOP_FILE_PATH, 'utf-8').trim();
        } catch (error) {
            console.error('Error reading STOP.txt:', error);
            return 'Status: INACTIVE';
        }
    }

    static updateStopFile(status: string): void {
        try {
            fs.writeFileSync(STOP_FILE_PATH, `Status: ${status}`);
            console.log(`STOP.txt updated to: Status: ${status}`);
        } catch (error) {
            console.error('Error updating STOP.txt:', error);
        }
    }

    static displayStatus(): void {
        const status = this.readStopFile();
        console.log(`Current Kill-Switch Status: ${status}`);
    }

    static activateKillSwitch(): void {
        this.updateStopFile('ACTIVE');
    }

    static deactivateKillSwitch(): void {
        this.updateStopFile('INACTIVE');
    }
}

// Command-line interface logic can be added here for user interaction.