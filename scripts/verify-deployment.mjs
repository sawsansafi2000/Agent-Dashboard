import dotenv from 'dotenv';

dotenv.config();

const baseUrl = (process.argv[2] || process.env.PRODUCTION_APP_URL || '').replace(/\/$/, '');
const dashboardUsername = process.env.DASHBOARD_USERNAME;
const dashboardPassword = process.env.DASHBOARD_PASSWORD;

if (!/^https?:\/\//.test(baseUrl)) {
    throw new Error('Aufruf: npm run verify:deployment -- https://agents.example.com');
}

const checks = [
    { path: '/', kind: 'page' },
    { path: '/health', kind: 'health' },
    { path: '/api/products', kind: 'api' },
    { path: '/api/dashboard-stats', kind: 'api' },
    { path: '/api/missions', kind: 'missions' },
];

if (!dashboardUsername || !dashboardPassword) {
    throw new Error('DASHBOARD_USERNAME und DASHBOARD_PASSWORD müssen für die Prüfung als Umgebungsvariablen gesetzt sein.');
}

const authorization = `Basic ${Buffer.from(`${dashboardUsername}:${dashboardPassword}`).toString('base64')}`;

let failed = false;
for (const check of checks) {
    try {
        const response = await fetch(`${baseUrl}${check.path}`, {
            redirect: 'manual',
            headers: { authorization },
            signal: AbortSignal.timeout(10_000),
        });
        const contentType = response.headers.get('content-type') || '';
        let passed = response.status === 200;
        if (passed && check.kind === 'page') passed = contentType.includes('text/html');
        if (passed && check.kind !== 'page') {
            const body = await response.json();
            if (check.kind === 'health') {
                passed = body.status === 'ok' && body.runnerAvailable === true;
            } else if (check.kind === 'api') {
                passed = body.success === true;
            } else if (check.kind === 'missions') {
                passed = body.success === true && body.runnerAvailable === true;
            }
        }
        console.log(`${passed ? 'OK' : 'FEHLER'} ${check.path}: HTTP ${response.status}${passed ? '' : ' (Inhalt oder Runner-Status ungültig)'}`);
        failed ||= !passed;
    } catch (error) {
        failed = true;
        console.error(`FEHLER ${check.path}: ${error instanceof Error ? error.message : error}`);
    }
}

if (failed) process.exitCode = 1;