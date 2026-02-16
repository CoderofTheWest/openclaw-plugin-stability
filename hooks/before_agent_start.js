/**
 * before_agent_start hook — Awareness injection.
 *
 * Fires before each agent turn. Injects a small stability context block
 * (<500 chars) into the system prompt, giving the agent proprioceptive
 * awareness of its entropy state and recent heartbeat decisions.
 */

const Entropy = require('../lib/entropy');
const Heartbeat = require('../lib/heartbeat');
const Identity = require('../lib/identity');
const path = require('path');
const fs = require('fs');

let entropy, heartbeat, identity;
let initialized = false;

function initialize(pluginDir) {
    if (initialized) return;

    const configPath = path.join(pluginDir, 'config.default.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const dataDir = path.join(pluginDir, 'data');

    entropy = new Entropy(config, dataDir);
    heartbeat = new Heartbeat(config);
    identity = new Identity(config, dataDir);
    initialized = true;
}

module.exports = async function before_agent_start({ systemPrompt, metadata, memory }) {
    initialize(path.join(__dirname, '..'));

    // Load principles from SOUL.md if available in system prompt context
    if (metadata?.soulMd) {
        identity.loadPrinciplesFromSoulMd(metadata.soulMd);
    }

    // Build stability context block
    const state = entropy.getCurrentState();
    const principles = identity.getPrincipleNames();

    // Entropy status
    const entropyLabel = state.lastScore > 1.0 ? 'CRITICAL'
        : state.lastScore > 0.8 ? 'elevated'
        : state.lastScore > 0.4 ? 'active'
        : 'nominal';

    let block = `[STABILITY CONTEXT]\n`;
    block += `Entropy: ${state.lastScore.toFixed(2)} (${entropyLabel})`;

    if (state.sustainedTurns > 0) {
        block += ` | Sustained: ${state.sustainedTurns} turns (${state.sustainedMinutes}min)`;
    }
    block += '\n';

    // Recent heartbeat decisions
    const recentDecisions = await heartbeat.readRecentDecisions(memory);
    if (recentDecisions.length > 0) {
        block += 'Recent decisions: ' + recentDecisions.map(d =>
            `${d.decision.split(' — ')[0]}`
        ).join(', ') + '\n';
    }

    // Principle alignment status
    if (principles.length > 0) {
        block += `Principles: ${principles.join(', ')} | Alignment: stable\n`;
    }

    // Inject into system prompt (append to end)
    return {
        systemPrompt: systemPrompt + '\n\n' + block
    };
};
