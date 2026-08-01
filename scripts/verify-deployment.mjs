const baseUrl = (process.argv[2] || process.env.PRODUCTION_APP_URL || '').replace(/\/$/, '');
const dashboardUsername = process.env.DASHBOARD_USERNAME;
const dashboardPassword = process.env.DASHBOARD_PASSWORD;

if (!/^https?:\/\//.test(baseUrl)) {
    throw new Error('Aufruf: npm run verify:deployment -- https://agents.example.com');
}

const checks = [
    { path: '/', expectedStatuses: [200], authenticated: false },
    { path: '/health', expectedStatuses: [200], authenticated: false },
    { path: '/dashboard', expectedStatuses: [200], authenticated: true },
    { path: '/dashboard/chat', expectedStatuses: [200], authenticated: true },
    { path: '/api/status', expectedStatuses: [200], authenticated: true },
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
            headers: check.authenticated ? { authorization } : undefined,
            signal: AbortSignal.timeout(10_000),
        });
        const passed = check.expectedStatuses.includes(response.status);
        console.log(`${passed ? 'OK' : 'FEHLER'} ${check.path}: HTTP ${response.status}`);
        failed ||= !passed;
    } catch (error) {
        failed = true;
        console.error(`FEHLER ${check.path}: ${error instanceof Error ? error.message : error}`);
    }
}

if (failed) process.exitCode = 1;