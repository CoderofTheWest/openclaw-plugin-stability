/**
 * before_compaction hook — Memory flush.
 *
 * Fires before context compaction. Ensures entropy-significant events
 * are persisted to memory before the context window is compressed.
 *
 * This follows OpenClaw's existing pre-compaction memory flush pattern.
 */

const Entropy = require('../lib/entropy');
const path = require('path');
const fs = require('fs');

let entropy;
let initialized = false;

function initialize(pluginDir) {
    if (initialized) return;

    const configPath = path.join(pluginDir, 'config.default.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const dataDir = path.join(pluginDir, 'data');

    entropy = new Entropy(config, dataDir);
    initialized = true;
}

module.exports = async function before_compaction({ memory }) {
    initialize(path.join(__dirname, '..'));

    const state = entropy.getCurrentState();

    // If there's been significant entropy activity, store a summary
    if (state.lastScore > 0.6 || state.sustainedTurns > 0) {
        const summary = [
            `[Stability Pre-Compaction Summary]`,
            `Last entropy: ${state.lastScore.toFixed(2)}`,
            state.sustainedTurns > 0
                ? `Sustained high entropy: ${state.sustainedTurns} turns (${state.sustainedMinutes}min)`
                : null,
            state.recentHistory.length > 0
                ? `Recent pattern: ${state.recentHistory.map(h => h.entropy.toFixed(2)).join(' → ')}`
                : null
        ].filter(Boolean).join('\n');

        try {
            if (memory) {
                await memory.store(summary, {
                    type: 'stability_compaction_summary',
                    timestamp: new Date().toISOString()
                });
            }
        } catch (err) {
            console.warn('[Stability] Failed to store compaction summary:', err.message);
        }
    }

    return {};
};
