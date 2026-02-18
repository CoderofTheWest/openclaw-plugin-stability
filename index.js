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
 *
 * Hook registration uses api.on() (OpenClaw SDK typed hooks).
 * Stability context injected via prependContext (before identity kernel).
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// SOUL.md resolution — metadata preferred, direct file read as fallback
// ---------------------------------------------------------------------------

function resolveSoulMd(event) {
    // Prefer metadata if OpenClaw populates it
    if (event.metadata?.soulMd) return event.metadata.soulMd;

    // Fallback: read SOUL.md directly from workspace
    const workspace = event.metadata?.workspace
        || process.env.OPENCLAW_WORKSPACE
        || path.join(os.homedir(), '.openclaw', 'workspace');
    const soulPath = path.join(workspace, 'SOUL.md');
    try {
        if (fs.existsSync(soulPath)) {
            return fs.readFileSync(soulPath, 'utf8');
        }
    } catch (_) { /* best effort */ }
    return null;
}

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

module.exports = {
    id: 'stability',
    name: 'Agent Stability & Introspection',

    configSchema: {
        jsonSchema: {
            type: 'object',
            properties: {
                entropy: { type: 'object' },
                principles: { type: 'object' },
                heartbeat: { type: 'object' },
                loopDetection: { type: 'object' },
                governance: { type: 'object' },
                growthVectors: { type: 'object' },
                detectors: { type: 'object' }
            }
        }
    },

    register(api) {
        const config = loadConfig(api.pluginConfig || {});

        // Ensure plugin-local data directory exists
        const dataDir = path.join(__dirname, 'data');
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }

        // -------------------------------------------------------------------
        // Shared module instances (accessible to all hooks + gateway methods)
        // -------------------------------------------------------------------

        const Entropy = require('./lib/entropy');
        const Detectors = require('./lib/detectors');
        const Identity = require('./lib/identity');
        const Heartbeat = require('./lib/heartbeat');
        const LoopDetection = require('./lib/loop-detection');
        const VectorStore = require('./lib/vectorStore');

        const entropy = new Entropy(config, dataDir);
        const detectors = new Detectors(config);
        const identity = new Identity(config, dataDir);
        const heartbeat = new Heartbeat(config);
        const loopDetector = new LoopDetection(config);
        const vectorStore = new VectorStore(config, dataDir);

        // -------------------------------------------------------------------
        // HOOK: before_agent_start — Inject stability context via prependContext
        // Priority 5 (runs before continuity plugin at priority 10)
        // -------------------------------------------------------------------

        api.on('before_agent_start', async (event, ctx) => {
            // Load principles from SOUL.md (metadata or direct file read)
            if (identity.usingFallback) {
                const soulContent = resolveSoulMd(event);
                if (soulContent) identity.loadPrinciplesFromSoulMd(soulContent);
            }

            // Build stability context block
            const state = entropy.getCurrentState();
            const principles = identity.getPrincipleNames();

            // Entropy status
            const entropyLabel = state.lastScore > 1.0 ? 'CRITICAL'
                : state.lastScore > 0.8 ? 'elevated'
                : state.lastScore > 0.4 ? 'active'
                : 'nominal';

            const lines = ['[STABILITY CONTEXT]'];
            let entropyLine = `Entropy: ${state.lastScore.toFixed(2)} (${entropyLabel})`;

            if (state.sustainedTurns > 0) {
                entropyLine += ` | Sustained: ${state.sustainedTurns} turns (${state.sustainedMinutes}min)`;
            }
            lines.push(entropyLine);

            // Recent heartbeat decisions
            const recentDecisions = await heartbeat.readRecentDecisions(event.memory);
            if (recentDecisions.length > 0) {
                lines.push('Recent decisions: ' + recentDecisions.map(d =>
                    `${d.decision.split(' — ')[0]}`
                ).join(', '));
            }

            // Principle alignment status
            if (principles.length > 0) {
                let principlesLine = `Principles: ${principles.join(', ')} | Alignment: stable`;
                if (identity.usingFallback) {
                    principlesLine += ' (defaults — add ## Core Principles to SOUL.md to customize)';
                }
                lines.push(principlesLine);
            }

            // Growth vector injection
            if (config.growthVectors?.enabled !== false) {
                try {
                    // Fragmentation check — too many unresolved tensions
                    const activeTensions = identity._activeTensions.filter(t => t.status === 'active').length;
                    if (activeTensions > 5) {
                        const fileVectors = vectorStore.loadVectors().length;
                        const ratio = activeTensions / Math.max(fileVectors, 1);
                        if (ratio > 3) {
                            lines.push(`⚠ Fragmentation: ${activeTensions} unresolved tensions (ratio ${ratio.toFixed(1)}:1)`);
                        }
                    }

                    const userMessage = _extractLastUserMessage(event);
                    const relevantVectors = vectorStore.getRelevantVectors(
                        userMessage, state.lastScore
                    );
                    if (relevantVectors.length > 0) {
                        lines.push('');
                        lines.push(vectorStore.formatForInjection(relevantVectors));
                    }
                } catch (err) {
                    // Growth vector injection is best-effort — never block the hook
                    console.warn('[Stability] Growth vector injection error:', err.message);
                }
            }

            return { prependContext: lines.join('\n') };
        }, { priority: 5 });

        // -------------------------------------------------------------------
        // HOOK: agent_end — Primary observation point (fire-and-forget)
        // -------------------------------------------------------------------

        api.on('agent_end', async (event, ctx) => {
            const messages = event.messages || [];
            const lastAssistant = [...messages].reverse().find(m => m?.role === 'assistant');
            const lastUser = [...messages].reverse().find(m => m?.role === 'user');

            if (!lastAssistant || !lastUser) return;

            const userMessage = _extractText(lastUser);
            const responseText = _extractText(lastAssistant);

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
            if (identity.usingFallback) {
                const soulContent = resolveSoulMd(event);
                if (soulContent) identity.loadPrinciplesFromSoulMd(soulContent);
            }
            await identity.processTurn(userMessage, responseText, score, event.memory, vectorStore);

            // 6. Log heartbeat decision if this was a heartbeat turn
            if (event.metadata?.isHeartbeat) {
                await heartbeat.logDecision(responseText, event.memory);
            }

            // 7. Warn on sustained critical entropy
            if (sustained.sustained) {
                api.logger.warn(
                    `SUSTAINED CRITICAL ENTROPY: ${sustained.turns} turns, ` +
                    `${sustained.minutes} minutes above threshold`
                );
            }
        });

        // -------------------------------------------------------------------
        // HOOK: after_tool_call — Loop detection
        // -------------------------------------------------------------------

        api.on('after_tool_call', (event, ctx) => {
            const toolName = event.toolName || event.name || '';
            const toolResult = event.result || event.toolResult || '';
            const toolParams = event.params || event.toolParams || {};

            const output = typeof toolResult === 'string'
                ? toolResult
                : JSON.stringify(toolResult || '');

            const result = loopDetector.recordAndCheck(toolName, output, toolParams);

            if (result.loopDetected) {
                api.logger.warn(`Loop detected (${result.type}): ${result.message}`);

                return {
                    systemMessage: `[LOOP DETECTED] ${result.message}`
                };
            }

            return {};
        });

        // -------------------------------------------------------------------
        // HOOK: before_compaction — Memory flush
        // -------------------------------------------------------------------

        api.on('before_compaction', async (event, ctx) => {
            const state = entropy.getCurrentState();

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
                    if (event.memory) {
                        await event.memory.store(summary, {
                            type: 'stability_compaction_summary',
                            timestamp: new Date().toISOString()
                        });
                    }
                } catch (err) {
                    // Best effort
                }
            }
        });

        // -------------------------------------------------------------------
        // Service: investigation background service
        // -------------------------------------------------------------------

        const InvestigationService = require('./services/investigation');
        const investigation = new InvestigationService(config, dataDir);

        api.registerService({
            id: 'stability-investigation',
            start: async (serviceCtx) => {
                await investigation.start();
            },
            stop: async () => {
                await investigation.stop();
            }
        });

        // -------------------------------------------------------------------
        // Gateway method: state inspection
        // -------------------------------------------------------------------

        api.registerGatewayMethod('stability.getState', async ({ respond }) => {
            const state = entropy.getCurrentState();
            const fileData = vectorStore.loadFile();
            respond(true, {
                entropy: state.lastScore,
                sustained: state.sustainedTurns,
                principles: identity.getPrincipleNames(),
                growthVectors: {
                    memoryApi: await identity.getVectorCount(),
                    file: fileData.vectors.length,
                    candidates: fileData.candidates.length,
                    sessionTensions: identity._activeTensions.filter(t => t.status === 'active').length
                },
                tensions: await identity.getTensionCount()
            });
        });

        api.registerGatewayMethod('stability.getPrinciples', async ({ respond }) => {
            respond(true, {
                principles: identity.getPrincipleNames(),
                source: identity.usingFallback ? 'config-fallback' : 'soul.md',
                format: '## Core Principles\n- **Name**: description',
                fallback: config.principles.fallback.map(p => p.name)
            });
        });

        // -------------------------------------------------------------------
        // Gateway methods: growth vector management
        // -------------------------------------------------------------------

        api.registerGatewayMethod('stability.getGrowthVectors', async ({ respond }) => {
            const fileData = vectorStore.loadFile();
            respond(true, {
                total: fileData.vectors.length,
                validated: fileData.vectors.filter(v => v.validation_status === 'validated').length,
                candidates: fileData.candidates.length,
                vectors: fileData.vectors.slice(0, 20),
                candidateList: fileData.candidates.slice(0, 10),
                sessionTensions: identity._activeTensions
            });
        });

        api.registerGatewayMethod('stability.validateVector', async ({ params, respond }) => {
            if (!params?.id) {
                respond(false, { error: 'Missing required param: id' });
                return;
            }
            const result = vectorStore.validateVector(params.id, params.note || '');
            respond(result.success, result);
        });

        // Run lifecycle management on startup (prune old candidates, enforce limits)
        try {
            vectorStore.runLifecycle();
        } catch (_) { /* best-effort */ }

        api.logger.info('Stability plugin registered — entropy monitoring, loop detection, heartbeat decisions, growth vectors active');
    }
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function _extractText(msg) {
    if (!msg) return '';
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
        return msg.content.map(c => c.text || c.content || '').join(' ');
    }
    return String(msg.content || '');
}

/**
 * Extract the last user message from an event (for growth vector relevance scoring).
 * Works with both before_agent_start (event.messages) and the raw message.
 */
function _extractLastUserMessage(event) {
    // Try event.messages array (most common)
    const messages = event.messages || [];
    const lastUser = [...messages].reverse().find(m => m?.role === 'user');
    if (lastUser) return _extractText(lastUser);

    // Try event.message (some hook formats)
    if (event.message) {
        return typeof event.message === 'string' ? event.message : _extractText(event.message);
    }

    return '';
}
