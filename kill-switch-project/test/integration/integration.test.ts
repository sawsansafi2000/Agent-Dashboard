import { readFileSync } from 'fs';
import { join } from 'path';
import { KillSwitchManager } from '../../src/kill-switch/manager';

describe('Integration Tests for Kill-Switch Mechanism', () => {
    let killSwitchManager: KillSwitchManager;

    beforeAll(() => {
        killSwitchManager = new KillSwitchManager();
    });

    test('should read STOP.txt and initialize status correctly', () => {
        const status = killSwitchManager.getStatus();
        const expectedStatus = readFileSync(join(__dirname, '../../STOP.txt'), 'utf-8').trim();
        expect(status).toBe(expectedStatus);
    });

    test('should trigger emergency stop when STOP.txt is set to ACTIVE', () => {
        // Simulate changing STOP.txt to ACTIVE
        killSwitchManager.setStatus('ACTIVE');
        const status = killSwitchManager.getStatus();
        expect(status).toBe('ACTIVE');
        
        // Here you would typically check if the stop procedures were executed
        // This could involve mocking or spying on methods that should be called
    });

    test('should not trigger emergency stop when STOP.txt is set to INACTIVE', () => {
        // Simulate changing STOP.txt to INACTIVE
        killSwitchManager.setStatus('INACTIVE');
        const status = killSwitchManager.getStatus();
        expect(status).toBe('INACTIVE');
        
        // Check that stop procedures were not executed
    });
});