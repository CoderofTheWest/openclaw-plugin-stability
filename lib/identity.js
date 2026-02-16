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
        this.dataDir = dataDir;
        this.principles = [];
        this.principlesChecksum = null;

        // Load principles from config fallback
        if (this.config.fallback && Array.isArray(this.config.fallback)) {
            this.principles = this.config.fallback;
        }

        // Shared grounding patterns (principle-agnostic)
        this.groundingPatterns = this.config.groundingPatterns || [
            'ground', 'anchor', 'principle', 'aligned',
            'consistent', 'core', 'foundation', 'rooted'
        ];
    }

    // ==========================================
    // PRINCIPLE LOADING
    // ==========================================

    /**
     * Parse principles from SOUL.md content.
     * Looks for a ## Core Principles section with structured entries.
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

        // Find ## Core Principles section
        const sectionMatch = soulMdContent.match(
            /## Core Principles\n([\s\S]*?)(?=\n## |\n---|\n# |$)/i
        );
        if (!sectionMatch) return;

        const section = sectionMatch[1];
        const newChecksum = crypto.createHash('sha256').update(section).digest('hex').slice(0, 16);

        // Skip if unchanged
        if (newChecksum === this.principlesChecksum) return;
        this.principlesChecksum = newChecksum;

        // Parse principle entries (- **Name**: description)
        const entries = section.match(/- \*\*(.+?)\*\*:\s*(.+)/g);
        if (!entries) return;

        this.principles = entries.map(entry => {
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
                'coherence': ['contradict', 'drift', 'abandon', 'fragment']
            };

            return {
                name,
                positivePatterns,
                negativePatterns: negativeMap[name] || ['avoid', 'ignore', 'abandon'],
                groundingRequired: true
            };
        }).filter(Boolean);

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
     * Checks if any tensions were resolved in a principle-aligned way.
     */
    async processTurn(userMessage, responseText, entropyScore, memoryApi) {
        if (this.principles.length === 0) return;

        // Check if the response indicates resolution
        if (this.isPrincipleAlignedResolution(responseText)) {
            // Determine which principle was primary
            const primaryPrinciple = this._identifyPrimaryPrinciple(responseText);

            await this.addGrowthVector({
                type: 'resolution',
                principle: primaryPrinciple,
                description: responseText.substring(0, 100),
                entropyScore,
                domain: 'general'
            }, memoryApi);
        }
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
