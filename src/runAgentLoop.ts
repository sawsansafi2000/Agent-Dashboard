import { startApiMonitorLoop, startAutonomousLoop, startTaskWorkerLoop } from './agentLoop.js';
import { TaskQueue } from './taskQueue.js';
import { startTaskApi } from './taskApi.js';
import { ControlPlane } from './controlPlane.js';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

void (async () => {
	const taskApi = await startTaskApi(new TaskQueue(workspaceRoot), new ControlPlane(workspaceRoot));
	try {
		await Promise.all([startAutonomousLoop(), startTaskWorkerLoop(), startApiMonitorLoop()]);
	} finally {
		taskApi.close();
	}
})().catch(error => {
	console.error('[AgentRuntime] Start fehlgeschlagen:', error);
	process.exitCode = 1;
});