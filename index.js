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
 *
 * Multi-agent: All state (entropy logs, growth vectors, feedback, tensions)
 * is scoped per agent via ctx.agentId. Each agent gets its own data
 * subdirectory under data/agents/{agentId}/. The default/main agent uses
 * the legacy data/ path for backward compatibility.
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

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
    return dirPath;
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

/**
 * Resolve the workspace directory for an agent from event metadata.
 * Falls back to the default workspace if not available.
 */
function resolveWorkspace(event) {
    return event.metadata?.workspace
        || process.env.OPENCLAW_WORKSPACE
        || path.join(os.homedir(), '.openclaw', 'workspace');
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

        // Base data directory for the plugin
        const baseDataDir = ensureDir(path.join(__dirname, 'data'));

        // -------------------------------------------------------------------
        // Per-agent state management
        //
        // Each agent gets its own isolated set of:
        //   - Entropy (log files, history, sustained tracking)
        //   - Detectors (stateless, but instantiated per-agent for isolation)
        //   - Identity (principles, tensions, evolution tracking)
        //   - Heartbeat (decision tracking)
        //   - LoopDetection (consecutive-tool, file re-read, output hash)
        //   - VectorStore (growth vectors, feedback)
        //   - Cross-hook state (injected vectors, pre-injection entropy)
        //
        // Data directory layout:
        //   data/                    <- default/main agent (backward compat)
        //   data/agents/{agentId}/   <- all other agents
        // -------------------------------------------------------------------

        const Entropy = require('./lib/entropy');
        const Detectors = require('./lib/detectors');
        const Identity = require('./lib/identity');
        const Heartbeat = require('./lib/heartbeat');
        const LoopDetection = require('./lib/loop-detection');
        const VectorStore = require('./lib/vectorStore');
        const InvestigationService = require('./services/investigation');

        /**
         * Per-agent state container.
         * Created lazily on first hook invocation for each agent.
         */
        class AgentState {
            constructor(agentId, workspacePath) {
                this.agentId = agentId;

                // Data directory: legacy path for default/main, scoped for others
                if (!agentId || agentId === 'main') {
                    this.dataDir = baseDataDir;
                } else {
                    this.dataDir = ensureDir(path.join(baseDataDir, 'agents', agentId));
                }

                // Workspace path (for growth vectors file resolution)
                this.workspacePath = workspacePath
                    || path.join(os.homedir(), '.openclaw', 'workspace');

                // Per-agent module instances
                this.entropy = new Entropy(config, this.dataDir);
                this.detectors = new Detectors(config);
                this.identity = new Identity(config, this.dataDir);
                this.heartbeat = new Heartbeat(config);
                this.loopDetector = new LoopDetection(config);
                this.vectorStore = new VectorStore(config, this.dataDir, this.workspacePath);

                // Cross-hook state: growth vector feedback tracking
                this.lastInjectedVectors = [];   // [{ id, relevanceScore }]
                this.preInjectionEntropy = null;
            }
        }

        /** @type {Map<string, AgentState>} */
        const agentStates = new Map();

        /**
         * Get or create per-agent state.
         * @param {string} [agentId] - Agent ID from hook context
         * @param {string} [workspacePath] - Agent's workspace directory
         * @returns {AgentState}
         */
        function getAgentState(agentId, workspacePath) {
            const id = agentId || 'main';
            if (!agentStates.has(id)) {
                agentStates.set(id, new AgentState(id, workspacePath));
                api.logger.info(`Initialized stability state for agent "${id}" (data: ${agentStates.get(id).dataDir})`);
            }
            return agentStates.get(id);
        }

        // -------------------------------------------------------------------
        // HOOK: before_agent_start — Inject stability context via prependContext
        // Priority 5 (runs before continuity plugin at priority 10)
        // -------------------------------------------------------------------

        api.on('before_agent_start', async (event, ctx) => {
            const workspace = resolveWorkspace(event);
            const state = getAgentState(ctx.agentId, workspace);

            // Load principles from SOUL.md (metadata or direct file read)
            if (state.identity.usingFallback) {
                const soulContent = resolveSoulMd(event);
                if (soulContent) state.identity.loadPrinciplesFromSoulMd(soulContent);
            }

            // Build stability context block
            const entropyState = state.entropy.getCurrentState();
            const principles = state.identity.getPrincipleNames();

            // Entropy status
            const entropyLabel = entropyState.lastScore > 1.0 ? 'CRITICAL'
                : entropyState.lastScore > 0.8 ? 'elevated'
                : entropyState.lastScore > 0.4 ? 'active'
                : 'nominal';

            const lines = ['[STABILITY CONTEXT]'];
            let entropyLine = `Entropy: ${entropyState.lastScore.toFixed(2)} (${entropyLabel})`;

            if (entropyState.sustainedTurns > 0) {
                entropyLine += ` | Sustained: ${entropyState.sustainedTurns} turns (${entropyState.sustainedMinutes}min)`;
            }
            lines.push(entropyLine);

            // Tiered injection: nominal = entropy only, active+ = add context
            const isElevated = entropyState.lastScore > 0.4;

            if (isElevated) {
                // Recent heartbeat decisions (only when active/elevated)
                const recentDecisions = await state.heartbeat.readRecentDecisions(event.memory);
                if (recentDecisions.length > 0) {
                    lines.push('Recent decisions: ' + recentDecisions.map(d =>
                        `${d.decision.split(' — ')[0]}`
                    ).join(', '));
                }

                // Principle alignment status (only when active/elevated)
                if (principles.length > 0) {
                    let principlesLine = `Principles: ${principles.join(', ')} | Alignment: stable`;
                    if (state.identity.usingFallback) {
                        principlesLine += ' (defaults — add ## Core Principles to SOUL.md to customize)';
                    }
                    lines.push(principlesLine);
                }
            }

            // Growth vector injection (only when elevated, or high-relevance match)
            if (config.growthVectors?.enabled !== false) {
                try {
                    // Fragmentation check — only when elevated
                    if (isElevated) {
                        const activeTensions = state.identity._activeTensions.filter(t => t.status === 'active').length;
                        if (activeTensions > 5) {
                            const fileVectors = state.vectorStore.loadVectors().length;
                            const ratio = activeTensions / Math.max(fileVectors, 1);
                            if (ratio > 3) {
                                lines.push(`⚠ Fragmentation: ${activeTensions} unresolved tensions (ratio ${ratio.toFixed(1)}:1)`);
                            }
                        }
                    }

                    const userMessage = _extractLastUserMessage(event);
                    const scoredResults = state.vectorStore.getRelevantVectors(
                        userMessage, entropyState.lastScore, { returnScores: true }
                    );
                    const relevantVectors = scoredResults.map(sr => sr.vector);

                    // Capture injection state for feedback loop
                    if (config.growthVectors?.feedbackEnabled !== false && scoredResults.length > 0) {
                        state.preInjectionEntropy = entropyState.lastScore;
                        state.lastInjectedVectors = scoredResults.map(sr => ({
                            id: sr.vector.id,
                            relevanceScore: sr.score
                        }));
                    } else {
                        state.lastInjectedVectors = [];
                        state.preInjectionEntropy = null;
                    }

                    // Only inject vectors when elevated OR top match is highly relevant
                    const topScore = scoredResults.length > 0 ? scoredResults[0].score : 0;
                    if (relevantVectors.length > 0 && (isElevated || topScore > 0.8)) {
                        lines.push('');
                        lines.push(state.vectorStore.formatForInjection(relevantVectors));
                    }
                } catch (err) {
                    state.lastInjectedVectors = [];
                    state.preInjectionEntropy = null;
                    // Growth vector injection is best-effort — never block the hook
                    console.warn(`[Stability:${state.agentId}] Growth vector injection error:`, err.message);
                }
            }

            return { prependContext: lines.join('\n') };
        }, { priority: 5 });

        // -------------------------------------------------------------------
        // HOOK: agent_end — Primary observation point (fire-and-forget)
        // -------------------------------------------------------------------

        api.on('agent_end', async (event, ctx) => {
            const state = getAgentState(ctx.agentId);

            const messages = event.messages || [];
            const lastAssistant = [...messages].reverse().find(m => m?.role === 'assistant');
            const lastUser = [...messages].reverse().find(m => m?.role === 'user');

            if (!lastAssistant || !lastUser) return;

            const userMessage = _stripContextBlocks(_extractText(lastUser));
            const responseText = _extractText(lastAssistant);

            // 1. Run detectors
            const detectorResults = state.detectors.runAll(userMessage, responseText);

            // 2. Calculate composite entropy
            const score = state.entropy.calculateEntropyScore(
                userMessage, responseText, detectorResults
            );

            // 3. Track sustained entropy
            const sustained = state.entropy.trackSustainedEntropy(score);

            // 4. Log observation
            await state.entropy.logObservation({
                score,
                sustained: sustained.turns,
                detectors: detectorResults,
                userLength: userMessage.length,
                responseLength: responseText.length
            });

            // 5. Identity evolution — check for principle-aligned resolutions
            if (state.identity.usingFallback) {
                const soulContent = resolveSoulMd(event);
                if (soulContent) state.identity.loadPrinciplesFromSoulMd(soulContent);
            }
            await state.identity.processTurn(userMessage, responseText, score, event.memory, state.vectorStore);

            // 5.5. Growth vector feedback loop — close the loop
            if (config.growthVectors?.feedbackEnabled !== false
                && state.lastInjectedVectors.length > 0
                && state.preInjectionEntropy !== null) {
                try {
                    const entropyDelta = score - state.preInjectionEntropy;
                    const tensionDetected = !!(
                        detectorResults.temporalMismatch
                        || detectorResults.qualityDecay
                        || (detectorResults.recursiveMetaBonus > 0)
                    );

                    for (const injected of state.lastInjectedVectors) {
                        state.vectorStore.recordFeedback(injected.id, {
                            preEntropy: state.preInjectionEntropy,
                            postEntropy: score,
                            entropyDelta,
                            relevanceScore: injected.relevanceScore,
                            tensionDetected,
                            timestamp: new Date().toISOString()
                        });
                    }
                } catch (err) {
                    console.warn(`[Stability:${state.agentId}] Growth vector feedback error:`, err.message);
                } finally {
                    // Reset for next turn — prevent stale state leaking
                    state.lastInjectedVectors = [];
                    state.preInjectionEntropy = null;
                }
            }

            // 6. Log heartbeat decision if this was a heartbeat turn
            if (event.metadata?.isHeartbeat) {
                await state.heartbeat.logDecision(responseText, event.memory);
            }

            // 7. Warn on sustained critical entropy
            if (sustained.sustained) {
                api.logger.warn(
                    `[${state.agentId}] SUSTAINED CRITICAL ENTROPY: ${sustained.turns} turns, ` +
                    `${sustained.minutes} minutes above threshold`
                );
            }
        });

        // -------------------------------------------------------------------
        // HOOK: after_tool_call — Loop detection
        // -------------------------------------------------------------------

        api.on('after_tool_call', (event, ctx) => {
            const state = getAgentState(ctx.agentId);

            const toolName = event.toolName || event.name || '';
            const toolResult = event.result || event.toolResult || '';
            const toolParams = event.params || event.toolParams || {};

            const output = typeof toolResult === 'string'
                ? toolResult
                : JSON.stringify(toolResult || '');

            const result = state.loopDetector.recordAndCheck(toolName, output, toolParams);

            if (result.loopDetected) {
                api.logger.warn(`[${state.agentId}] Loop detected (${result.type}): ${result.message}`);

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
            const state = getAgentState(ctx.agentId);
            const entropyState = state.entropy.getCurrentState();

            if (entropyState.lastScore > 0.6 || entropyState.sustainedTurns > 0) {
                const summary = [
                    `[Stability Pre-Compaction Summary]`,
                    `Last entropy: ${entropyState.lastScore.toFixed(2)}`,
                    entropyState.sustainedTurns > 0
                        ? `Sustained high entropy: ${entropyState.sustainedTurns} turns (${entropyState.sustainedMinutes}min)`
                        : null,
                    entropyState.recentHistory.length > 0
                        ? `Recent pattern: ${entropyState.recentHistory.map(h => h.entropy.toFixed(2)).join(' → ')}`
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
        // Uses main agent's data dir (investigation is system-wide, not per-agent)
        // -------------------------------------------------------------------

        const investigation = new InvestigationService(config, baseDataDir);

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
        // Gateway methods: state inspection
        // Accept optional agentId param; default to 'main'.
        // -------------------------------------------------------------------

        api.registerGatewayMethod('stability.getState', async ({ params, respond }) => {
            const state = getAgentState(params?.agentId);
            const entropyState = state.entropy.getCurrentState();
            const fileData = state.vectorStore.loadFile();
            respond(true, {
                agentId: state.agentId,
                entropy: entropyState.lastScore,
                sustained: entropyState.sustainedTurns,
                principles: state.identity.getPrincipleNames(),
                growthVectors: {
                    memoryApi: await state.identity.getVectorCount(),
                    file: fileData.vectors.length,
                    candidates: fileData.candidates.length,
                    sessionTensions: state.identity._activeTensions.filter(t => t.status === 'active').length
                },
                tensions: await state.identity.getTensionCount()
            });
        });

        // Expose entropy for inter-plugin communication (metabolism plugin)
        api.stability = {
            getEntropy: (agentId) => {
                const state = getAgentState(agentId);
                return state.entropy.getCurrentState().lastScore;
            },
            getEntropyState: (agentId) => {
                const state = getAgentState(agentId);
                return state.entropy.getCurrentState();
            }
        };

        api.registerGatewayMethod('stability.getPrinciples', async ({ params, respond }) => {
            const state = getAgentState(params?.agentId);
            respond(true, {
                agentId: state.agentId,
                principles: state.identity.getPrincipleNames(),
                source: state.identity.usingFallback ? 'config-fallback' : 'soul.md',
                format: '## Core Principles\n- **Name**: description',
                fallback: config.principles.fallback.map(p => p.name)
            });
        });

        // -------------------------------------------------------------------
        // Gateway methods: growth vector management
        // -------------------------------------------------------------------

        api.registerGatewayMethod('stability.getGrowthVectors', async ({ params, respond }) => {
            const state = getAgentState(params?.agentId);
            const fileData = state.vectorStore.loadFile();
            respond(true, {
                agentId: state.agentId,
                total: fileData.vectors.length,
                validated: fileData.vectors.filter(v => v.validation_status === 'validated').length,
                candidates: fileData.candidates.length,
                vectors: fileData.vectors.slice(0, 20),
                candidateList: fileData.candidates.slice(0, 10),
                sessionTensions: state.identity._activeTensions
            });
        });

        api.registerGatewayMethod('stability.validateVector', async ({ params, respond }) => {
            if (!params?.id) {
                respond(false, { error: 'Missing required param: id' });
                return;
            }
            const state = getAgentState(params?.agentId);
            const result = state.vectorStore.validateVector(params.id, params.note || '');
            respond(result.success, result);
        });

        api.registerGatewayMethod('stability.getVectorFeedback', async ({ params, respond }) => {
            const state = getAgentState(params?.agentId);
            if (params?.id) {
                const feedback = state.vectorStore.getFeedback(params.id);
                respond(!!feedback, feedback || { error: 'No feedback data for this vector' });
            } else {
                // Return summary for all vectors with feedback
                try {
                    const data = state.vectorStore._loadFeedbackFile();
                    const summary = Object.entries(data).map(([id, record]) => ({
                        id,
                        avgEntropyDelta: record.avgEntropyDelta,
                        totalInjections: record.totalInjections,
                        lastUsed: record.lastUsed,
                        entries: record.entries.length
                    }));
                    respond(true, { agentId: state.agentId, vectors: summary });
                } catch (err) {
                    respond(false, { error: err.message });
                }
            }
        });

        // List all initialized agent states (diagnostic)
        api.registerGatewayMethod('stability.listAgents', async ({ respond }) => {
            const agents = [];
            for (const [id, state] of agentStates) {
                agents.push({
                    agentId: id,
                    dataDir: state.dataDir,
                    workspacePath: state.workspacePath,
                    vectorFilePath: state.vectorStore.filePath
                });
            }
            respond(true, { agents });
        });

        // Run lifecycle management on startup for main agent
        // (other agents run lifecycle on first access)
        try {
            const mainState = getAgentState('main');
            mainState.vectorStore.runLifecycle();
        } catch (_) { /* best-effort */ }

        api.logger.info('Stability plugin registered — multi-agent entropy monitoring, loop detection, heartbeat decisions, growth vectors active');
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
 * All known context block prefixes injected by OpenClaw plugins.
 * Must stay in sync with the continuity plugin's CONTEXT_BLOCK_HEADERS.
 */
const CONTEXT_BLOCK_HEADERS = [
    '[CONTINUITY CONTEXT]',
    '[STABILITY CONTEXT]',
    '[ACTIVE PROJECTS]',
    '[ACTIVE CONSTRAINTS]',
    '[OPEN DIRECTIVES',
    '[GROWTH VECTORS]',
    '[GRAPH CONTEXT]',
    '[GRAPH NOTE]',
    '[CONTEMPLATION STATE]',
    '[TOPIC NOTE]',
    '[ARCHIVE RETRIEVAL]',
    '[LOOP DETECTED]',
];

const CONTEXT_LINE_PREFIXES = [
    'Session:',
    'Topics:',
    'Anchors:',
    'Entropy:',
    'Principles:',
    'Recent decisions:',
    'Fingerprint:',
    'Loops:',
    'You remember these',
    '- They told you:',
    '  You said:',
    'Speak from this memory',
    'From your knowledge base:',
    'You know these connections:',
    'Active inquiries:',
    'Recent insights',
];

function _isContextLine(line) {
    if (line.length === 0) return true;
    for (const header of CONTEXT_BLOCK_HEADERS) {
        if (line.startsWith(header)) return true;
    }
    for (const prefix of CONTEXT_LINE_PREFIXES) {
        if (line.startsWith(prefix)) return true;
    }
    if (line.startsWith('- "') || line.startsWith('  -')) return true;
    return false;
}

/**
 * Strip plugin-injected context blocks from user message text.
 *
 * OpenClaw bakes prependContext into the user message, so by the time
 * agent_end fires the user message starts with [CONTINUITY CONTEXT]
 * and/or [STABILITY CONTEXT] blocks followed by the actual user text.
 * This strips those blocks so downstream consumers (detectors, identity,
 * candidate vector creation) operate on real user content.
 */
function _stripContextBlocks(text) {
    if (!text) return '';

    // Fast path: no context blocks present
    const hasBlock = CONTEXT_BLOCK_HEADERS.some(h => text.includes(h));
    const hasRecall = text.includes('You remember these') || text.includes('From your knowledge base:');
    if (!hasBlock && !hasRecall) return text;

    // Primary: find the LAST timestamp marker (earlier ones may be inside recalled memories)
    const tsRegex = /\n\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s\d{4}-\d{2}-\d{2}\s[^\]]*\]\s*/g;
    let lastTsMatch = null;
    let match;
    while ((match = tsRegex.exec(text)) !== null) {
        lastTsMatch = match;
    }
    if (lastTsMatch) {
        return text.substring(lastTsMatch.index + lastTsMatch[0].length);
    }

    // Fallback: strip known context lines from the beginning
    const lines = text.split('\n');
    const realStart = lines.findIndex(line => !_isContextLine(line));
    if (realStart > 0) {
        return lines.slice(realStart).join('\n').trim();
    }
    if (realStart < 0) return '';

    return text;
}

/**
 * Extract the last user message from an event (for growth vector relevance scoring).
 * Works with both before_agent_start (event.messages) and the raw message.
 */
function _extractLastUserMessage(event) {
    // Try event.messages array (most common)
    const messages = event.messages || [];
    const lastUser = [...messages].reverse().find(m => m?.role === 'user');
    if (lastUser) return _stripContextBlocks(_extractText(lastUser));

    // Try event.message (some hook formats)
    if (event.message) {
        const raw = typeof event.message === 'string' ? event.message : _extractText(event.message);
        return _stripContextBlocks(raw);
    }

    return '';
}
