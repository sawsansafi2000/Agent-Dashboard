document.addEventListener('DOMContentLoaded', () => {
    const socket = io();
    const agentList = document.getElementById('agent-list');
    const ideaList = document.getElementById('idea-list');
    const projectList = document.getElementById('project-list');
    const form = document.getElementById('idea-form');
    const formStatus = document.getElementById('form-status');
    const apiBanner = document.getElementById('api-budget-banner');
    let snapshot = { agents: [], ideas: [], metrics: {} };
    let activeFilter = 'all';

    function setText(id, value) {
        document.getElementById(id).textContent = String(value);
    }

    function renderAgents(agents) {
        agentList.replaceChildren(...agents.map(agent => {
            const card = document.createElement('article');
            card.className = 'agent-card';
            const status = agent.status === 'working' ? 'Arbeitet' : 'Startet neu';
            card.innerHTML = `
                <div class="agent-identity"><span class="pulse"></span><div><h3></h3><p></p></div></div>
                <dl>
                    <div><dt>PID</dt><dd></dd></div>
                    <div><dt>Neustarts</dt><dd></dd></div>
                    <div><dt>Gestartet</dt><dd></dd></div>
                </dl>
                <div class="agent-log"><span>Letzte Aktivität</span><p></p><a class="detail-link">Agent öffnen</a></div>`;
            const heading = card.querySelector('h3');
            const agentLink = document.createElement('a');
            agentLink.href = agent.link;
            agentLink.textContent = agent.name;
            heading.appendChild(agentLink);
            card.querySelector('.agent-identity p').textContent = status;
            const values = card.querySelectorAll('dd');
            values[0].textContent = agent.pid || '-';
            values[1].textContent = agent.restartCount;
            values[2].textContent = agent.startedAt ? new Date(agent.startedAt).toLocaleTimeString('de-DE') : '-';
            card.querySelector('.agent-log p').textContent = agent.lastError || agent.lastMessage;
            card.querySelector('.detail-link').href = agent.link;
            card.classList.toggle('restarting', agent.status !== 'working');
            return card;
        }));
    }

    function renderProjects(projects) {
        if (!projects.length) {
            const empty = document.createElement('p');
            empty.className = 'empty-state';
            empty.textContent = 'Die Bestandsanalyse läuft. Projekte erscheinen nach dem nächsten Agentenzyklus.';
            projectList.replaceChildren(empty);
            return;
        }
        projectList.replaceChildren(...projects.map(project => {
            const card = document.createElement('article');
            card.className = 'project-card';
            card.innerHTML = `
                <div class="project-head"><span class="stage"></span><strong class="score"></strong></div>
                <h3><a></a></h3>
                <p class="milestone"></p>
                <div class="progress-track"><span></span></div>
                <dl><div><dt>Fortschritt</dt><dd class="progress"></dd></div><div><dt>Bestellungen</dt><dd class="orders"></dd></div><div><dt>Umsatz</dt><dd class="revenue"></dd></div></dl>`;
            card.querySelector('.stage').textContent = project.stage;
            card.querySelector('.score').textContent = project.score === null ? 'Ausstehend' : `${project.score}/100`;
            const link = card.querySelector('h3 a');
            link.href = project.link;
            link.textContent = project.title;
            card.querySelector('.milestone').textContent = project.nextMilestone;
            card.querySelector('.progress-track span').style.width = `${project.progress}%`;
            card.querySelector('.progress').textContent = `${project.progress}%`;
            card.querySelector('.orders').textContent = project.orders;
            card.querySelector('.revenue').textContent = `${project.revenue} ${project.currency}`;
            return card;
        }));
    }

    function renderIdeas() {
        const ideas = snapshot.ideas
            .filter(idea => activeFilter === 'all' || idea.source === activeFilter)
            .slice()
            .reverse();
        if (!ideas.length) {
            const empty = document.createElement('p');
            empty.className = 'empty-state';
            empty.textContent = 'Noch keine Ideen in diesem Bereich.';
            ideaList.replaceChildren(empty);
            return;
        }
        ideaList.replaceChildren(...ideas.map(idea => {
            const card = document.createElement('article');
            card.className = 'idea-card';
            const source = idea.source === 'agent' ? 'Agent' : 'Manuell';
            card.innerHTML = `
                <div class="idea-meta"><span class="source"></span><time></time></div>
                <h3></h3><p class="idea-summary"></p>
                <div class="markets"></div>
                <details><summary>Geschäftsmodell & nächste Schritte</summary><p class="model"></p><ol></ol></details>`;
            card.querySelector('.source').textContent = source;
            card.querySelector('time').textContent = new Date(idea.createdAt).toLocaleString('de-DE');
            card.querySelector('h3').textContent = idea.title;
            card.querySelector('.idea-summary').textContent = idea.summary;
            card.querySelector('.model').textContent = idea.businessModel;
            const markets = card.querySelector('.markets');
            (idea.targetMarkets || []).forEach(market => {
                const tag = document.createElement('span');
                tag.textContent = market;
                markets.appendChild(tag);
            });
            const steps = card.querySelector('ol');
            (idea.nextSteps || []).forEach(step => {
                const item = document.createElement('li');
                item.textContent = step;
                steps.appendChild(item);
            });
            return card;
        }));
    }

    function render(nextSnapshot) {
        snapshot = nextSnapshot;
        apiBanner.hidden = !snapshot.apiAlert?.active;
        apiBanner.textContent = snapshot.apiAlert?.active ? snapshot.apiAlert.message : '';
        const working = snapshot.agents.filter(agent => agent.status === 'working').length;
        setText('metric-agents', snapshot.agents.length);
        setText('metric-projects', snapshot.metrics.activeProjects);
        setText('metric-orders', snapshot.metrics.orders);
        setText('metric-revenue', `${snapshot.metrics.revenue} EUR`);
        setText('last-update', new Date(snapshot.timestamp).toLocaleTimeString('de-DE'));
        setText('system-state', working === snapshot.agents.length ? 'System aktiv' : 'Neustart läuft');
        renderAgents(snapshot.agents);
        renderProjects(snapshot.projects || []);
        renderIdeas();
    }

    async function refresh() {
        const response = await fetch('/api/status');
        if (!response.ok) throw new Error('Status nicht erreichbar');
        render(await response.json());
    }

    socket.on('connect', () => {
        document.getElementById('connection-dot').classList.add('online');
        setText('connection-label', 'Live verbunden');
    });
    socket.on('disconnect', () => {
        document.getElementById('connection-dot').classList.remove('online');
        setText('connection-label', 'Verbindung wird erneuert');
    });
    socket.on('system:update', render);

    document.querySelectorAll('.filter').forEach(button => {
        button.addEventListener('click', () => {
            document.querySelectorAll('.filter').forEach(item => item.classList.remove('active'));
            button.classList.add('active');
            activeFilter = button.dataset.filter;
            renderIdeas();
        });
    });

    form.addEventListener('submit', async event => {
        event.preventDefault();
        formStatus.textContent = 'Wird gespeichert ...';
        const values = Object.fromEntries(new FormData(form).entries());
        const response = await fetch('/api/ideas', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(values),
        });
        if (!response.ok) {
            formStatus.textContent = 'Die Idee konnte nicht gespeichert werden.';
            return;
        }
        form.reset();
        formStatus.textContent = 'Gespeichert. Der Agent nimmt den Impuls in den nächsten Zyklus auf.';
        await refresh();
    });

    refresh().catch(error => {
        formStatus.textContent = error.message;
    });
});