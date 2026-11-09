import { closeAgentLoopResources, startApiMonitorLoop, startAutonomousLoop, startTaskWorkerLoop } from './agentLoop.js';
import { TaskQueue } from './taskQueue.js';
import { startTaskApi } from './taskApi.js';
import { ControlPlane } from './controlPlane.js';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = path.resolve(
	process.env.AGENT_WORKSPACE_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
);

void (async () => {
	const controlPlane = new ControlPlane(workspaceRoot);
	await controlPlane.initialize();
	const taskQueue = new TaskQueue(workspaceRoot);
	const taskApi = await startTaskApi(taskQueue, controlPlane);
	try {
		if (process.env.AGENT_EXECUTION_MODE === 'local') {
			console.log('[AgentRuntime] Lokaler Modus: keine Modell- oder API-Schleifen werden gestartet.');
			await startTaskWorkerLoop();
		} else {
			await Promise.all([startAutonomousLoop(), startTaskWorkerLoop(), startApiMonitorLoop()]);
		}
	} finally {
		try {
			await new Promise<void>((resolve, reject) => {
				taskApi.close(error => error ? reject(error) : resolve());
			});
		} finally {
			await Promise.all([taskQueue.close(), closeAgentLoopResources()]);
		}
	}
})().catch(error => {
	console.error('[AgentRuntime] Start fehlgeschlagen:', error);
	process.exitCode = 1;
});