/**
 * Identity evolution — principle-aligned growth vectors and tension tracking.
 *
 * Ported from Clint's identityEvolutionCodeAligned.js.
 * Key abstraction: isCodeAlignedResolution() becomes isPrincipleAlignedResolution()
 * with configurable principles loaded from SOUL.md or plugin config.
 *
 * Uses OpenClaw's memory system for persistence (vector + BM25 searchable).
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class Identity {
    constructor(config, dataDir) {
        this.config = config.principles || {};
        this.fullConfig = config; // Full plugin config (for entropy patterns etc.)
        this.dataDir = dataDir;
        this.principles = [];
        this.principlesChecksum = null;
        this.usingFallback = true;

        // Load principles from config fallback
        if (this.config.fallback && Array.isArray(this.config.fallback)) {
            this.principles = this.config.fallback;
        }

        // Shared grounding patterns (principle-agnostic)
        this.groundingPatterns = this.config.groundingPatterns || [
            'ground', 'anchor', 'principle', 'aligned',
            'consistent', 'core', 'foundation', 'rooted'
        ];

        // Correction patterns for tension detection (from entropy config)
        this.correctionPatterns = (config.entropy?.patterns?.correction || [
            'actually', 'correction', "you're wrong", 'not quite',
            'technically', "that's not", 'false', 'incorrect'
        ]).map(p => p.toLowerCase());

        // Active tensions (in-memory, session-scoped)
        this._activeTensions = [];
    }

    // ==========================================
    // PRINCIPLE LOADING
    // ==========================================

    /**
     * Parse principles from SOUL.md content.
     * Looks for a principles section in SOUL.md with structured entries.
     * Matches common heading variations: Core Principles, Core Truths,
     * Principles, Values, Code, Truths.
     *
     * Expected format in SOUL.md:
     *   ## Core Principles
     *   - **Courage**: Face truth directly, investigate before assuming
     *   - **Word**: Verify claims, don't promise what you can't deliver
     *   - **Brand**: Stay coherent across contexts, don't drift into generic mode
     *
     * Each principle becomes a { name, positivePatterns, negativePatterns } entry.
     */
    loadPrinciplesFromSoulMd(soulMdContent) {
        if (!soulMdContent) return;

        // Find ALL matching sections — SOUL.md may have both "Core Truths"
        // (prose) and "Core Principles" (structured). We need the one with
        // parseable entries, not just the first regex hit.
        const sectionRegex = /## (?:Core )?(?:Principles|Truths|Values|Code)\n([\s\S]*?)(?=\n## |\n---|\n# |$)/gi;

        let bestSection = null;
        let bestEntries = null;
        let match;

        while ((match = sectionRegex.exec(soulMdContent)) !== null) {
            const section = match[1];
            const entries = section.match(/- \*\*(.+?)\*\*:\s*(.+)/g);
            if (entries && entries.length > 0) {
                // Use the first section that has valid structured entries
                bestSection = section;
                bestEntries = entries;
                break;
            }
        }

        if (!bestSection || !bestEntries) return;

        const newChecksum = crypto.createHash('sha256').update(bestSection).digest('hex').slice(0, 16);

        // Skip if unchanged
        if (newChecksum === this.principlesChecksum) return;
        this.principlesChecksum = newChecksum;

        this.principles = bestEntries.map(entry => {
            const match = entry.match(/- \*\*(.+?)\*\*:\s*(.+)/);
            if (!match) return null;

            const name = match[1].toLowerCase().trim();
            const description = match[2].toLowerCase().trim();

            // Extract positive patterns from description words
            const words = description.split(/[\s,;]+/).filter(w => w.length > 3);
            const positivePatterns = [name, ...words.slice(0, 5)];

            // Negative patterns: common antonyms/violations
            const negativeMap = {
                'courage': ['avoid', 'safe', 'hedge', 'ignore'],
                'word': ['break', 'lie', 'guess', 'assume'],
                'brand': ['betray', 'abandon', 'contradict', 'drift'],
                'integrity': ['avoid', 'hedge', 'assume', 'fabricate'],
                'reliability': ['guess', 'probably', 'might', 'untested'],
                'coherence': ['contradict', 'drift', 'abandon', 'fragment'],
                'accountability': ['blame', 'deflect', 'excuse', 'hide'],
                'resourcefulness': ['helpless', 'stuck', 'unable', 'give up']
            };

            return {
                name,
                positivePatterns,
                negativePatterns: negativeMap[name] || ['avoid', 'ignore', 'abandon'],
                groundingRequired: true
            };
        }).filter(Boolean);

        if (this.principles.length > 0) {
            this.usingFallback = false;
        }
        console.log(`[Stability] Loaded ${this.principles.length} principles from SOUL.md`);
    }

    /**
     * Check if a resolution aligns with configured principles.
     * Replaces Clint's hardcoded isCodeAlignedResolution().
     *
     * A resolution is principle-aligned if:
     * 1. At least one principle's positive patterns match
     * 2. No principle's negative patterns match (in violation context)
     * 3. Grounding language is present (if required)
     */
    isPrincipleAlignedResolution(resolutionText) {
        if (!resolutionText || this.principles.length === 0) return false;

        const text = resolutionText.toLowerCase();
        let anyAligned = false;

        for (const principle of this.principles) {
            const hasPositive = principle.positivePatterns.some(p => text.includes(p));
            const hasNegative = principle.negativePatterns.some(p => text.includes(p));

            if (hasPositive && !hasNegative) {
                anyAligned = true;
            }
        }

        // Check grounding requirement
        if (anyAligned) {
            const isGrounded = this.groundingPatterns.some(p => text.includes(p));
            const anyRequiresGrounding = this.principles.some(p => p.groundingRequired);

            if (anyRequiresGrounding && !isGrounded) {
                return false;
            }
        }

        return anyAligned;
    }

    // ==========================================
    // GROWTH VECTORS (via OpenClaw Memory)
    // ==========================================

    /**
     * Add a growth vector to OpenClaw memory.
     * Called when a tension is resolved in a principle-aligned way.
     */
    async addGrowthVector(resolution, memoryApi) {
        if (!memoryApi) return;

        const vector = {
            id: crypto.randomUUID(),
            type: resolution.type || 'general',
            domain: resolution.domain || 'general',
            principle: resolution.principle || 'unknown',
            description: resolution.description || '',
            entropyScore: resolution.entropyScore || 0,
            createdAt: new Date().toISOString()
        };

        const content = `[Growth Vector] ${vector.principle}: ${vector.description} (entropy: ${vector.entropyScore.toFixed(2)}, domain: ${vector.domain})`;

        try {
            await memoryApi.store(content, {
                type: 'growth_vector',
                principle: vector.principle,
                domain: vector.domain,
                id: vector.id
            });
        } catch (err) {
            console.warn('[Stability] Failed to store growth vector:', err.message);
        }
    }

    /**
     * Add a tension to OpenClaw memory.
     */
    async addTension(tension, memoryApi) {
        if (!memoryApi) return;

        const content = `[Tension] ${tension.type}: ${tension.description} (status: active)`;

        try {
            await memoryApi.store(content, {
                type: 'tension',
                status: 'active',
                tensionType: tension.type,
                id: tension.id || crypto.randomUUID()
            });
        } catch (err) {
            console.warn('[Stability] Failed to store tension:', err.message);
        }
    }

    /**
     * Resolve a tension and optionally create a growth vector.
     */
    async resolveTension(tensionId, resolution, memoryApi) {
        if (!memoryApi) return;

        // Mark tension as resolved
        try {
            await memoryApi.store(
                `[Tension Resolved] ${resolution.description}`,
                { type: 'tension', status: 'resolved', id: tensionId }
            );
        } catch (err) {
            console.warn('[Stability] Failed to resolve tension:', err.message);
        }

        // Create growth vector if principle-aligned
        if (this.isPrincipleAlignedResolution(resolution.resolutionText)) {
            await this.addGrowthVector(resolution, memoryApi);
        }
    }

    /**
     * Detect fragmentation — too many unresolved tensions.
     */
    async detectFragmentation(memoryApi) {
        if (!memoryApi) return { fragmented: false };

        try {
            const tensions = await memoryApi.search('type:tension status:active', { limit: 50 });
            const vectors = await memoryApi.search('type:growth_vector', { limit: 50 });

            const ratio = tensions.length / Math.max(vectors.length, 1);
            return {
                fragmented: ratio > 3,
                activeTensions: tensions.length,
                growthVectors: vectors.length,
                ratio
            };
        } catch {
            return { fragmented: false };
        }
    }

    // ==========================================
    // PROCESS TURN (main entry point for agent_end hook)
    // ==========================================

    /**
     * Process a conversation turn for identity evolution.
     *
     * Extended flow:
     * 1. Detect tensions from corrections, capability claims, entropy spikes
     * 2. Check for principle-aligned resolutions
     * 3. If aligned, try to resolve active tensions
     * 4. If entropy elevated, create candidate growth vector
     *
     * @param {string} userMessage
     * @param {string} responseText
     * @param {number} entropyScore
     * @param {object} memoryApi - OpenClaw memory API
     * @param {object} [vectorStore] - VectorStore instance (for candidate creation)
     */
    async processTurn(userMessage, responseText, entropyScore, memoryApi, vectorStore) {
        if (this.principles.length === 0) return;

        // 1. Detect tensions from user message + response
        const tensions = this.detectTensions(userMessage, responseText, entropyScore);
        for (const tension of tensions) {
            this._activeTensions.push(tension);
            await this.addTension(tension, memoryApi);
        }

        // 2. Check if response is principle-aligned
        if (this.isPrincipleAlignedResolution(responseText)) {
            const primaryPrinciple = this._identifyPrimaryPrinciple(responseText);

            // 3. Try to resolve matching active tensions
            await this._tryResolveTensions(responseText, primaryPrinciple, entropyScore, memoryApi);

            // 4. Create growth vector from the resolution
            await this.addGrowthVector({
                type: 'resolution',
                principle: primaryPrinciple,
                description: responseText.substring(0, 100),
                entropyScore,
                domain: 'general'
            }, memoryApi);
        }

        // 5. Create candidate growth vector on elevated entropy
        if (vectorStore && entropyScore > 0.6) {
            this._createCandidateVector(userMessage, responseText, entropyScore, tensions, vectorStore);
        }

        // 6. Expire old tensions (> 7 days)
        this._expireTensions();
    }

    // ==========================================
    // TENSION DETECTION (Phase 2)
    // ==========================================

    /**
     * Detect tensions from conversation content and entropy signals.
     * Returns array of tension objects for recording.
     */
    detectTensions(userMessage, responseText, entropyScore) {
        const tensions = [];
        const userLower = (userMessage || '').toLowerCase();
        const responseLower = (responseText || '').toLowerCase();

        // Tension from user correction + elevated entropy
        if (entropyScore > 0.4) {
            const hasCorrection = this.correctionPatterns.some(p => userLower.includes(p));
            if (hasCorrection) {
                tensions.push({
                    id: crypto.randomUUID(),
                    type: 'user_correction',
                    description: userMessage.substring(0, 150),
                    entropyScore,
                    detectedAt: new Date().toISOString(),
                    status: 'active'
                });
            }
        }

        // Tension from capability claim without demonstration
        const claimPatterns = ['i can', "i'm able to", 'i have access', 'i could'];
        const demoPatterns = ['here is', 'done', 'completed', 'created', 'result:', 'output:'];
        const hasClaim = claimPatterns.some(p => responseLower.includes(p));
        const hasDemo = demoPatterns.some(p => responseLower.includes(p));
        if (hasClaim && !hasDemo && entropyScore > 0.3) {
            tensions.push({
                id: crypto.randomUUID(),
                type: 'capability_gap',
                description: 'Claimed capability without demonstration in response',
                entropyScore,
                detectedAt: new Date().toISOString(),
                status: 'active'
            });
        }

        // Tension from high entropy spike (> 0.7) with detector signals
        if (entropyScore > 0.7 && tensions.length === 0) {
            tensions.push({
                id: crypto.randomUUID(),
                type: 'entropy_spike',
                description: `Entropy spike (${entropyScore.toFixed(2)}) without identified correction`,
                entropyScore,
                detectedAt: new Date().toISOString(),
                status: 'active'
            });
        }

        return tensions;
    }

    /**
     * Try to resolve active tensions when a principle-aligned response occurs.
     * Matches by type and recency — resolves the most recent matching tension.
     */
    async _tryResolveTensions(responseText, principle, entropyScore, memoryApi) {
        if (this._activeTensions.length === 0) return;

        // Find the most recent active tension that matches this resolution's domain
        const now = Date.now();
        for (let i = this._activeTensions.length - 1; i >= 0; i--) {
            const tension = this._activeTensions[i];
            if (tension.status !== 'active') continue;

            // Only resolve tensions from current session (< 30 minutes old)
            const age = now - new Date(tension.detectedAt).getTime();
            if (age > 30 * 60 * 1000) continue;

            // Resolve it
            tension.status = 'resolved';
            await this.resolveTension(tension.id, {
                description: `Resolved via principle-aligned response (${principle})`,
                resolutionText: responseText,
                principle,
                entropyScore,
                domain: 'general'
            }, memoryApi);

            // Only resolve one tension per turn
            break;
        }
    }

    /**
     * Create a candidate growth vector from elevated entropy turn.
     * Written to VectorStore's candidates array (not the agent's vectors).
     */
    _createCandidateVector(userMessage, responseText, entropyScore, tensions, vectorStore) {
        // Determine type from tensions or entropy
        let type = 'auto_detected';
        let entropySource = 'elevated_entropy';
        let hypothesis = '';

        if (tensions.length > 0) {
            const t = tensions[0];
            type = t.type;
            entropySource = t.type;
        }

        // Generate integration hypothesis from the correction/context
        const userShort = (userMessage || '').substring(0, 100);
        if (type === 'user_correction') {
            hypothesis = `Verify before asserting: ${userShort}`;
        } else if (type === 'capability_gap') {
            hypothesis = 'When claiming capability, demonstrate immediately';
        } else if (type === 'entropy_spike') {
            hypothesis = `Elevated entropy (${entropyScore.toFixed(2)}) may signal new territory — attend to it`;
        } else {
            hypothesis = `Review and learn from elevated entropy context: ${userShort}`;
        }

        const candidate = {
            id: `gv-auto-${Date.now()}`,
            detected: new Date().toISOString(),
            type,
            description: userShort,
            entropy_source: entropySource,
            priority: entropyScore > 0.8 ? 'high' : 'medium',
            integration_hypothesis: hypothesis,
            weight: 0.5,
            source: 'auto'
        };

        vectorStore.addCandidate(candidate);
        console.log(`[Stability] Created candidate growth vector: ${candidate.id} (${type})`);
    }

    /**
     * Expire tensions older than 7 days.
     */
    _expireTensions() {
        const cutoff = Date.now() - (7 * 24 * 60 * 60 * 1000);
        this._activeTensions = this._activeTensions.filter(t => {
            const age = new Date(t.detectedAt).getTime();
            return age > cutoff;
        });
    }

    // ==========================================
    // UTILITIES
    // ==========================================

    getPrincipleNames() {
        return this.principles.map(p => p.name);
    }

    async getVectorCount(memoryApi) {
        if (!memoryApi) return 0;
        try {
            const results = await memoryApi.search('type:growth_vector', { limit: 1000 });
            return results.length;
        } catch { return 0; }
    }

    async getTensionCount(memoryApi) {
        if (!memoryApi) return 0;
        try {
            const results = await memoryApi.search('type:tension status:active', { limit: 1000 });
            return results.length;
        } catch { return 0; }
    }

    _identifyPrimaryPrinciple(responseText) {
        const text = responseText.toLowerCase();
        let best = { name: 'general', score: 0 };

        for (const principle of this.principles) {
            let score = 0;
            principle.positivePatterns.forEach(p => {
                if (text.includes(p)) score++;
            });
            if (score > best.score) {
                best = { name: principle.name, score };
            }
        }

        return best.name;
    }
}

module.exports = Identity;
