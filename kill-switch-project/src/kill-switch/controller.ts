import { exec } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';

export async function stopProcesses() {
    try {
        // Commit current state to Git
        await execPromise('git add .');
        await execPromise('git commit -m "Emergency stop triggered by Kill-Switch"');

        // Shut down agents or processes
        await shutdownAgents();
    } catch (error) {
        console.error('Error stopping processes:', error);
    }
}

async function shutdownAgents() {
    // Logic to shut down agents or processes
    console.log('Shutting down agents...');
    // Example: await execPromise('pkill -f agent_process_name');
}

function execPromise(command: string): Promise<void> {
    return new Promise((resolve, reject) => {
        exec(command, (error) => {
            if (error) {
                return reject(error);
            }
            resolve();
        });
    });
}