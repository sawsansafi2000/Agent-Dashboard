document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('chat-form');
    const messageInput = document.getElementById('chat-message');
    const targetInput = document.getElementById('target-agent');
    const messages = document.getElementById('chat-messages');
    const status = document.getElementById('chat-status');
    const connection = document.getElementById('chat-connection');
    const apiBanner = document.getElementById('api-budget-banner');
    let lastSignature = '';

    const labels = { queued: 'Wartet', running: 'In Arbeit', completed: 'Erledigt', failed: 'Fehlgeschlagen' };
    const text = value => typeof value === 'string' ? value : '';

    function render(tasks, apiAlert) {
        const signature = `${apiAlert?.active}:${apiAlert?.message}|${tasks.map(task => `${task.id}:${task.updatedAt}`).join('|')}`;
        if (signature === lastSignature) return;
        lastSignature = signature;
        apiBanner.hidden = !apiAlert?.active;
        apiBanner.textContent = apiAlert?.active ? apiAlert.message : '';
        const systemMessages = [];
        if (apiAlert?.active) {
            const systemBubble = document.createElement('article');
            systemBubble.className = 'message-bubble agent-message failed api-system-message';
            const systemMeta = document.createElement('span');
            systemMeta.textContent = 'API-Überwachung';
            const systemText = document.createElement('p');
            systemText.textContent = apiAlert.message;
            systemBubble.append(systemMeta, systemText);
            systemMessages.push(systemBubble);
        }
        if (!tasks.length) {
            const empty = document.createElement('p');
            empty.className = 'chat-empty';
            empty.textContent = 'Noch keine Aufträge. Sende unten die erste Aufgabe.';
            messages.replaceChildren(...systemMessages, empty);
            return;
        }
        const fragments = tasks.slice().reverse().flatMap(task => {
            const userBubble = document.createElement('article');
            userBubble.className = 'message-bubble user-message';
            const userMeta = document.createElement('span');
            userMeta.textContent = `${text(task.payload?.targetAgent) || 'Master-Orchestrator'} · ${new Date(task.createdAt).toLocaleString('de-DE')}`;
            const userText = document.createElement('p');
            userText.textContent = text(task.payload?.message);
            userBubble.append(userMeta, userText);

            const agentBubble = document.createElement('article');
            agentBubble.className = `message-bubble agent-message ${task.status}`;
            const agentMeta = document.createElement('span');
            agentMeta.textContent = labels[task.status] || task.status;
            const agentText = document.createElement('p');
            agentText.textContent = text(task.result?.message) || text(task.error)
                || (task.status === 'queued' ? 'Auftrag wurde gespeichert und wartet auf die automatische Verarbeitung.' : 'Agent verarbeitet den Auftrag.');
            agentBubble.append(agentMeta, agentText);
            return [userBubble, agentBubble];
        });
        messages.replaceChildren(...systemMessages, ...fragments);
        messages.scrollTop = messages.scrollHeight;
    }

    async function refresh() {
        try {
            const response = await fetch('/dashboard/chat/tasks', { cache: 'no-store' });
            const body = await response.json();
            if (!response.ok) throw new Error(body.error || 'Agentenstatus nicht erreichbar.');
            render(body.tasks || [], body.apiAlert);
            connection.textContent = 'Verbunden';
            connection.classList.remove('warning');
        } catch (error) {
            connection.textContent = 'Nicht erreichbar';
            connection.classList.add('warning');
            status.textContent = error.message;
        } finally {
            messages.setAttribute('aria-busy', 'false');
        }
    }

    form.addEventListener('submit', async event => {
        event.preventDefault();
        const button = form.querySelector('button[type="submit"]');
        button.disabled = true;
        status.textContent = 'Wird sicher übermittelt ...';
        try {
            const response = await fetch('/dashboard/chat/tasks', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ message: messageInput.value, targetAgent: targetInput.value }),
            });
            const body = await response.json();
            if (!response.ok) throw new Error(body.error || 'Auftrag konnte nicht gespeichert werden.');
            messageInput.value = '';
            status.textContent = 'Auftrag gespeichert.';
            await refresh();
        } catch (error) {
            status.textContent = error.message;
        } finally {
            button.disabled = false;
            messageInput.focus();
        }
    });

    void refresh();
    setInterval(refresh, 3_000);
});