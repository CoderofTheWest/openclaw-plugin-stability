/**
 * openclaw-plugin-stability
 *
 * Agent stability, introspection, and anti-drift framework.
 * Ported from Clint's production architecture (Oct 2025 - Feb 2026).
 *
 * Provides:
 * - Shannon entropy monitoring with empirically calibrated thresholds
 * - Confabulation detection (temporal mismatch, quality decay, recursive meta)
 * - Principle-aligned growth vector tracking (configurable principles)
 * - Structured heartbeat decisions (GROUND/TEND/SURFACE/INTEGRATE)
 * - Loop detection (consecutive-tool, file re-read, output hash)
 * - Rate limiting, deduplication, quiet hours governance
 */

const path = require('path');
const fs = require('fs');

// Load default config, merge with user overrides
function loadConfig(userConfig = {}) {
    const defaultConfig = JSON.parse(
        fs.readFileSync(path.join(__dirname, 'config.default.json'), 'utf8')
    );
    return deepMerge(defaultConfig, userConfig);
}

function deepMerge(target, source) {
    const result = { ...target };
    for (const key of Object.keys(source)) {
        if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
            result[key] = deepMerge(target[key] || {}, source[key]);
        } else {
            result[key] = source[key];
        }
    }
    return result;
}

module.exports = {
    id: 'stability',
    name: 'Agent Stability & Introspection',

    configSchema: {
        type: 'object',
        properties: {
            entropy: { type: 'object' },
            principles: { type: 'object' },
            heartbeat: { type: 'object' },
            loopDetection: { type: 'object' },
            governance: { type: 'object' },
            detectors: { type: 'object' }
        }
    },

    register(api) {
        const config = loadConfig(api.getConfig?.() || {});

        // Ensure plugin-local data directory exists
        const dataDir = path.join(__dirname, 'data');
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }

        // Store config and dataDir on module for hooks to access
        this._config = config;
        this._dataDir = dataDir;

        // Register lifecycle hooks
        api.registerPluginHooksFromDir(path.join(__dirname, 'hooks'));

        // Register investigation as background service
        const InvestigationService = require('./services/investigation');
        api.registerService('stability-investigation', new InvestigationService(config, dataDir));

        // Register gateway method for state inspection (dashboards, debugging)
        const Entropy = require('./lib/entropy');
        const Identity = require('./lib/identity');
        const entropyModule = new Entropy(config, dataDir);
        const identityModule = new Identity(config, dataDir);

        api.registerGatewayMethod('stability.getState', async () => {
            const state = entropyModule.getCurrentState();
            return {
                entropy: state.lastScore,
                sustained: state.sustainedTurns,
                principles: identityModule.getPrincipleNames(),
                growthVectors: await identityModule.getVectorCount(),
                tensions: await identityModule.getTensionCount()
            };
        });

        console.log('[Stability] Plugin registered — entropy monitoring, loop detection, heartbeat decisions active');
    }
};
