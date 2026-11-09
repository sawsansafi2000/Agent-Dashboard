const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const db = new sqlite3.Database(process.env.DATABASE_PATH || path.join(__dirname, '../database.sqlite'));

function logAudit(action, details) {
    db.run(`INSERT INTO audit_log (action, details) VALUES (?, ?)`, [action, details], (err) => {
        if (err) console.error('[AUDIT ERROR]', err.message);
    });
}

function generateMarketingDraft(options, callback) {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }

    const settings = options || {};
    const platform = typeof settings.platform === 'string' ? settings.platform : 'LinkedIn';
    const industry = typeof settings.industry === 'string' && settings.industry.trim()
        ? settings.industry.trim()
        : 'branchenübergreifend';
    const offer = typeof settings.offer === 'string' && settings.offer.trim()
        ? settings.offer.trim()
        : 'digitale Produkte, Services und Coaching';
    const audience = typeof settings.audience === 'string' && settings.audience.trim()
        ? settings.audience.trim()
        : 'Selbstständige und kleine Teams';
    const openers = [
        `Mehr Zeit für das Wesentliche: ${offer} können wiederkehrende Aufgaben einfacher machen.`,
        `Eine gute Idee verdient einen klaren nächsten Schritt. Entdecke neue Möglichkeiten mit ${offer}.`,
        `Weniger manuelle Routine, mehr Raum für gute Arbeit: Lerne ${offer} kennen.`
    ];
    const opener = openers[Math.floor(Math.random() * openers.length)];
    const callToAction = 'Prüfe, ob es zu deinem Bedarf passt, und erfahre mehr.';
    const copy = platform === 'Instagram' || platform === 'TikTok'
        ? `${opener}\n\nFür ${audience} in den Bereichen ${industry}.\n\n${callToAction}\n\n#Selbstständig #Business #Automatisierung`
        : platform === 'X'
            ? `${opener} Für ${audience} in ${industry}. ${callToAction}`
            : `${opener}\n\nFür ${audience}, die in ${industry} arbeiten und ihre Abläufe weiterentwickeln möchten.\n\n${callToAction}`;

    db.run(`INSERT INTO pending_marketing_queue (platform, content, status) VALUES (?, ?, ?)`,
        [platform, copy, 'draft'],
        function(err) {
            if (err) {
                console.error('[KERNEL ERROR]', err.message);
                if (callback) callback(err, null);
                return;
            }
            console.log(`[KERNEL] Neuer Marketing-Entwurf in Warteschlange hinterlegt (ID: ${this.lastID})`);
            logAudit('MARKETING_DRAFT_CREATED', `Draft ID ${this.lastID} für ${platform} erstellt.`);
            if (callback) callback(null, this.lastID);
        }
    );
}

module.exports = { logAudit, generateMarketingDraft };
