document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('social-form');
    const status = document.getElementById('social-status');
    const connection = document.getElementById('social-connection');
    const publications = document.getElementById('social-publications');
    const platformStatus = document.getElementById('platform-status');

    async function request(url, init = {}) {
        const response = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...init.headers } });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Anfrage fehlgeschlagen.');
        return body;
    }

    function actionButton(label, publication, action) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'filter';
        button.textContent = label;
        button.addEventListener('click', async () => {
            button.disabled = true;
            status.textContent = `${label} läuft ...`;
            try {
                await request(`/dashboard/social/publications/${publication.id}/${action}`, {
                    method: 'POST', body: JSON.stringify({ revision: publication.revision }),
                });
                status.textContent = `${label} abgeschlossen.`;
                await refresh();
            } catch (error) {
                status.textContent = error.message;
            } finally {
                button.disabled = false;
            }
        });
        return button;
    }

    function render(body) {
        platformStatus.replaceChildren(...body.platforms.map(platform => {
            const badge = document.createElement('span');
            badge.className = 'state-badge';
            badge.textContent = `${platform.platform}: ${platform.publishingEnabled ? 'bereit' : platform.reason}`;
            return badge;
        }));
        publications.replaceChildren(...body.publications.slice().reverse().map(publication => {
            const card = document.createElement('article');
            card.className = 'agent-card';
            const title = document.createElement('h3');
            title.textContent = `${publication.platform.toUpperCase()} · ${(publication.kind || 'post').toUpperCase()} · ${publication.status}`;
            const text = document.createElement('p');
            text.textContent = publication.content;
            const meta = document.createElement('small');
            const schedule = publication.scheduledAt ? ` · geplant ${new Date(publication.scheduledAt).toLocaleString('de-DE')}` : '';
            meta.textContent = `Revision ${publication.revision} · ${new Date(publication.updatedAt).toLocaleString('de-DE')}${schedule}`;
            const actions = document.createElement('div');
            actions.className = 'filters';
            if (publication.status === 'draft') actions.append(actionButton('Freigeben', publication, 'approve'));
            if (publication.status === 'draft' || publication.status === 'approved') actions.append(actionButton('Ablehnen', publication, 'reject'));
            if (publication.status === 'approved') actions.append(actionButton('Veröffentlichen', publication, 'publish'));
            card.append(title, text, meta, actions);
            if (publication.error) {
                const error = document.createElement('p');
                error.className = 'payment-notice payment-error';
                error.textContent = publication.error;
                card.append(error);
            }
            return card;
        }));
    }

    async function refresh() {
        try {
            render(await request('/dashboard/social/publications'));
            connection.textContent = 'Verbunden';
        } catch (error) {
            connection.textContent = 'Nicht erreichbar';
            status.textContent = error.message;
        }
    }

    form.addEventListener('submit', async event => {
        event.preventDefault();
        const button = form.querySelector('button[type="submit"]');
        button.disabled = true;
        try {
            await request('/dashboard/social/publications', { method: 'POST', body: JSON.stringify({
                platform: document.getElementById('social-platform').value,
                content: document.getElementById('social-content').value,
                mediaUrl: document.getElementById('social-media-url').value,
                kind: document.getElementById('social-kind').value,
                scheduledAt: document.getElementById('social-scheduled-at').value
                    ? new Date(document.getElementById('social-scheduled-at').value).toISOString()
                    : null,
            }) });
            form.reset();
            status.textContent = 'Entwurf gespeichert. Noch nicht veröffentlicht.';
            await refresh();
        } catch (error) {
            status.textContent = error.message;
        } finally {
            button.disabled = false;
        }
    });

    void refresh();
});