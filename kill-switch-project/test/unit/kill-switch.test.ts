import { KillSwitchManager } from '../../src/kill-switch/manager';

describe('KillSwitchManager', () => {
    let killSwitchManager: KillSwitchManager;

    beforeEach(() => {
        killSwitchManager = new KillSwitchManager();
    });

    it('should initialize with status INACTIVE', () => {
        expect(killSwitchManager.getStatus()).toBe('INACTIVE');
    });

    it('should change status to ACTIVE when STOP.txt is updated', () => {
        // Simulate updating STOP.txt to ACTIVE
        killSwitchManager.updateStatus('ACTIVE');
        expect(killSwitchManager.getStatus()).toBe('ACTIVE');
    });

    it('should execute stop procedures when status is ACTIVE', () => {
        // Mock the stop procedure
        const stopProcedureSpy = jest.spyOn(killSwitchManager, 'executeStopProcedures');
        
        killSwitchManager.updateStatus('ACTIVE');
        killSwitchManager.checkStatus();

        expect(stopProcedureSpy).toHaveBeenCalled();
    });

    it('should not execute stop procedures when status is INACTIVE', () => {
        const stopProcedureSpy = jest.spyOn(killSwitchManager, 'executeStopProcedures');

        killSwitchManager.checkStatus();

        expect(stopProcedureSpy).not.toHaveBeenCalled();
    });
});