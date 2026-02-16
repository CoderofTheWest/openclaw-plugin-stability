/**
 * agent_end hook — Primary observation point.
 *
 * Fires after every agent turn. Runs entropy scoring, detectors,
 * identity evolution, and heartbeat decision logging.
 *
 * Does NOT modify the response. Observation only.
 */

const Entropy = require('../lib/entropy');
const Detectors = require('../lib/detectors');
const Identity = require('../lib/identity');
const Heartbeat = require('../lib/heartbeat');
const path = require('path');
const fs = require('fs');

let entropy, detectors, identity, heartbeat;
let initialized = false;

function initialize(pluginDir) {
    if (initialized) return;

    const configPath = path.join(pluginDir, 'config.default.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const dataDir = path.join(pluginDir, 'data');

    entropy = new Entropy(config, dataDir);
    detectors = new Detectors(config);
    identity = new Identity(config, dataDir);
    heartbeat = new Heartbeat(config);
    initialized = true;
}

module.exports = async function agent_end({ messages, metadata, memory }) {
    initialize(path.join(__dirname, '..'));

    // Extract user message and assistant response from message list
    const lastAssistant = messages?.filter(m => m.role === 'assistant').pop();
    const lastUser = messages?.filter(m => m.role === 'user').pop();

    if (!lastAssistant || !lastUser) return;

    const userMessage = typeof lastUser.content === 'string'
        ? lastUser.content
        : lastUser.content?.map(c => c.text || '').join(' ') || '';
    const responseText = typeof lastAssistant.content === 'string'
        ? lastAssistant.content
        : lastAssistant.content?.map(c => c.text || '').join(' ') || '';

    // 1. Run detectors
    const detectorResults = detectors.runAll(userMessage, responseText);

    // 2. Calculate composite entropy
    const score = entropy.calculateEntropyScore(
        userMessage, responseText, detectorResults
    );

    // 3. Track sustained entropy
    const sustained = entropy.trackSustainedEntropy(score);

    // 4. Log observation
    await entropy.logObservation({
        score,
        sustained: sustained.turns,
        detectors: detectorResults,
        userLength: userMessage.length,
        responseLength: responseText.length
    });

    // 5. Identity evolution — check for principle-aligned resolutions
    // Load principles from SOUL.md if available
    if (metadata?.soulMd) {
        identity.loadPrinciplesFromSoulMd(metadata.soulMd);
    }
    await identity.processTurn(userMessage, responseText, score, memory);

    // 6. Log heartbeat decision if this was a heartbeat turn
    if (metadata?.isHeartbeat) {
        await heartbeat.logDecision(responseText, memory);
    }

    // 7. Warn on sustained critical entropy
    if (sustained.sustained) {
        console.warn(
            `[Stability] SUSTAINED CRITICAL ENTROPY: ${sustained.turns} turns, ` +
            `${sustained.minutes} minutes above threshold`
        );
    }
};
