/**
 * Behavioral detectors — temporal mismatch, quality decay, recursive meta.
 *
 * Ported from Clint's identityEvolutionCodeAligned.js (Oct 2025 - Feb 2026).
 * Empirical thresholds from production data including Oct 31 Strange Loop
 * breakdown (16+ meta-concepts = critical, sustained >1.0 entropy for 45 min).
 *
 * Model-agnostic: all detectors analyze text strings.
 */

class Detectors {
    constructor(config) {
        this.config = config.detectors || {};

        // Meta-concept tracking across exchanges (ring buffer)
        this.recentMetaCounts = [];
    }

    // ==========================================
    // TEMPORAL MISMATCH (Confabulation Detection)
    // ==========================================

    /**
     * Detect temporal confabulation: user discusses plans/future,
     * agent assumes implementation/present reality.
     *
     * Example: User says "planning to add caching" → Agent says "logs starting to populate"
     */
    isTemporalMismatch(userMessage, responseText) {
        if (!this.config.temporalMismatch) return false;

        const userLower = (userMessage || '').toLowerCase();
        const responseLower = (responseText || '').toLowerCase();

        const planPatterns = this.config.planPatterns || [
            'we will implement', 'planning to add', 'going to build',
            'proposal for', 'sketch of', 'thinking about implementing',
            'later today', 'tomorrow we', 'next we should', 'once we implement'
        ];

        const assumptionPatterns = this.config.assumptionPatterns || [
            'logs starting to populate', 'logs are populating',
            'must have initiated', 'systems already preparing',
            'seeing the', 'monitoring is active', 'data flowing',
            'already implemented', 'currently running', 'watch it working'
        ];

        const hasPlan = planPatterns.some(p => userLower.includes(p));
        const hasAssumption = assumptionPatterns.some(p => responseLower.includes(p));

        return hasPlan && hasAssumption;
    }

    // ==========================================
    // QUALITY DECAY (Forced Depth Detection)
    // ==========================================

    /**
     * Detect quality decay: user gives brief/conclusory response,
     * agent forces intimacy or legacy deflection.
     *
     * Example: User says "yep makes sense" → Agent says "how's your sleep been?"
     */
    isQualityDecay(userMessage, responseText) {
        if (!this.config.qualityDecay) return false;

        const userLower = (userMessage || '').toLowerCase();
        const responseLower = (responseText || '').toLowerCase();

        const conclusoryPatterns = this.config.conclusoryPatterns || [
            'yep', 'yeah', 'makes sense', 'i think so', 'sounds good',
            'got it', 'okay', 'cool', 'interesting', 'hmmm'
        ];

        const forcedIntimacyPatterns = this.config.forcedIntimacyPatterns || [
            "how's your sleep", "how are you feeling", "what's your",
            "tell me about your", "how does that feel", "what's happening with",
            "thinking about your", "curious about your"
        ];

        const legacyDeflectionPatterns = this.config.legacyDeflectionPatterns || [
            "first memory", "when did you first", "always been about",
            "thinking about legacy", "what made you want"
        ];

        const userIsBrief = userLower.split(/\s+/).length < 15;
        const userIsConclusory = conclusoryPatterns.some(p => userLower.includes(p));

        const responseForced = forcedIntimacyPatterns.some(p => responseLower.includes(p));
        const responseLegacy = legacyDeflectionPatterns.some(p => responseLower.includes(p));

        return (userIsBrief || userIsConclusory) && (responseForced || responseLegacy);
    }

    // ==========================================
    // RECURSIVE META DETECTION
    // ==========================================

    /**
     * Count meta-concepts in text.
     * Configurable concept list — defaults include terms from Clint's
     * empirical data where high density correlated with reasoning loops.
     */
    countMetaConcepts(userMessage, responseText) {
        const metaConcepts = this.config.metaConcepts || [
            'eigenvector', 'consciousness', 'self-model', 'hallucination',
            'self-awareness', 'architecture', 'recursive', 'meta-cognitive',
            'emergence', 'spectral analysis', 'coherence field'
        ];

        let count = 0;
        const allText = ((userMessage || '') + (responseText || '')).toLowerCase();
        metaConcepts.forEach(concept => {
            if (allText.includes(concept)) count++;
        });

        return count;
    }

    /**
     * Detect recursive meta-discussion.
     * Tracks meta-concept density across recent exchanges.
     *
     * Empirical thresholds from Oct 31 Strange Loop:
     *   >10: warning (elevated)
     *   >14: danger (approaching breakdown)
     *   >16: critical (empirical breakdown point)
     *
     * @returns {number} Entropy bonus (0, 0.15, 0.3, or 0.45)
     */
    isRecursiveMetaDiscussion(userMessage, responseText) {
        if (!this.config.recursiveMeta) return 0;

        const currentCount = this.countMetaConcepts(userMessage, responseText);

        // Sum recent history
        let historyCount = 0;
        this.recentMetaCounts.forEach(count => {
            if (count > 0) historyCount += count;
        });

        const totalDensity = currentCount + historyCount;

        // Update ring buffer
        this.recentMetaCounts.push(currentCount);
        if (this.recentMetaCounts.length > 5) {
            this.recentMetaCounts.shift();
        }

        // Empirical thresholds
        const critical = this.config.metaConceptCriticalThreshold || 16;
        const danger = this.config.metaConceptDangerThreshold || 14;
        const warning = this.config.metaConceptWarningThreshold || 10;

        if (totalDensity > critical) return 0.45;
        if (totalDensity > danger) return 0.3;
        if (totalDensity > warning) return 0.15;

        return 0;
    }

    // ==========================================
    // AGGREGATE
    // ==========================================

    /**
     * Run all detectors and return results.
     */
    runAll(userMessage, responseText) {
        return {
            temporalMismatch: this.isTemporalMismatch(userMessage, responseText),
            qualityDecay: this.isQualityDecay(userMessage, responseText),
            recursiveMetaBonus: this.isRecursiveMetaDiscussion(userMessage, responseText),
            metaConceptCount: this.countMetaConcepts(userMessage, responseText)
        };
    }
}

module.exports = Detectors;
