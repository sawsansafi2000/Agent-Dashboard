export type KillSwitchStatus = 'ACTIVE' | 'INACTIVE';

export interface KillSwitchState {
    status: KillSwitchStatus;
    lastChecked: Date;
}