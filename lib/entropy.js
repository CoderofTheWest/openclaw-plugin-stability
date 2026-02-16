/**
 * Entropy monitoring — Shannon entropy + composite scoring.
 *
 * Ported from Clint's identityEvolutionCodeAligned.js (Oct 2025 - Feb 2026).
 * All thresholds empirically calibrated from 4+ months of production data,
 * including the Oct 31 Strange Loop breakdown event.
 *
 * Model-agnostic: operates on response text, not model internals.
 */

const fs = require('fs');
const path = require('path');

class Entropy {
    constructor(config, dataDir) {
        this.config = config.entropy || {};
        this.dataDir = dataDir;
        this.logPath = path.join(dataDir, 'entropy-monitor.jsonl');
        this.historyPath = path.join(dataDir, 'entropy-history.json');

        // Ring buffer of recent exchanges (for quiet integration detection)
        this.recentHistory = this._loadHistory();

        // Sustained entropy tracking
        this.sustainedTurns = 0;
        this.sustainedStartTime = null;
        this.lastScore = 0;

        // Configurable decay window for quiet integration (default: 6 hours)
        this.DECAY_WINDOW_MS = config.entropy?.decayWindowMs || 21600000;
    }

    // ==========================================
    // SHANNON ENTROPY (Information-Theoretic)
    // ==========================================

    /**
     * Calculate Shannon entropy on text.
     * H(X) = -Sum p(x) * log2(p(x))
     * Returns bits per word (typically 2-6 for English text).
     */
    calculateShannonEntropy(text) {
        const words = (text || '').toLowerCase().split(/\s+/).filter(w => w.length > 0);
        if (words.length === 0) return 0;

        const freq = {};
        words.forEach(w => { freq[w] = (freq[w] || 0) + 1; });

        const total = words.length;
        let entropy = 0;
        Object.values(freq).forEach(count => {
            const p = count / total;
            entropy -= p * Math.log2(p);
        });

        return entropy;
    }

    // ==========================================
    // COMPOSITE ENTROPY SCORING
    // ==========================================

    /**
     * Calculate composite entropy score for a conversation exchange.
     * High entropy = novel/contradictory/emotionally charged exchange.
     * Low entropy = routine conversation.
     *
     * @param {string} userMessage - User's message
     * @param {string} responseText - Agent's response
     * @param {Object} detectorResults - Results from detectors.js
     * @param {Object} context - Optional context (quality rating, etc.)
     * @returns {number} Composite score (0.0 - ~2.0)
     */
    calculateEntropyScore(userMessage, responseText, detectorResults = {}, context = {}) {
        let entropy = 0;
        const userLower = (userMessage || '').toLowerCase();
        const responseLower = (responseText || '').toLowerCase();

        const patterns = this.config.patterns || {};

        // 1. Explicit correction (+0.4)
        const correctionPatterns = patterns.correction || [
            'actually', 'correction', "you're wrong", 'not quite',
            'technically', "that's not", 'false', 'incorrect'
        ];
        if (correctionPatterns.some(p => userLower.includes(p))) {
            entropy += 0.4;
        }

        // 2. Novel frameworks/concepts (+0.15 each, max 0.3)
        const novelPattern = patterns.novelConceptRegex ||
            'RFC-T|recursive field|quantum|emergence theory|consciousness framework|architecture|paradigm shift';
        const conceptMatches = (userMessage + responseText).match(new RegExp(novelPattern, 'gi')) || [];
        if (conceptMatches.length > 0) {
            entropy += Math.min(conceptMatches.length * 0.15, 0.3);
        }

        // 3. Emotional weight (+0.3)
        const emotionalPatterns = patterns.emotional || [
            'proud of you', 'impressed', 'concerned', 'worried',
            'disappointed', 'amazing', 'breakthrough', 'significant'
        ];
        if (emotionalPatterns.some(p => userLower.includes(p))) {
            entropy += 0.3;
        }

        // 4. Paradox integration (+0.2)
        const paradoxPatterns = patterns.paradox || [
            'both are true', 'both and', 'paradox', 'yet',
            'simultaneously', 'hold together', 'tension'
        ];
        if (paradoxPatterns.some(p => responseLower.includes(p))) {
            entropy += 0.2;
        }

        // 5. Meta-cognitive shift (+0.2)
        const metaCogPatterns = patterns.metaCognitive || [
            'I realize', 'I see now', 'I understand now',
            'revelation', 'recognized', 'learned that'
        ];
        if (metaCogPatterns.some(p => responseLower.includes(p))) {
            entropy += 0.2;
        }

        // 6. Temporal confabulation bonus (+0.3)
        if (detectorResults.temporalMismatch) {
            entropy += 0.3;
        }

        // 7. Quality decay bonus (+0.2)
        if (detectorResults.qualityDecay) {
            entropy += 0.2;
        }

        // 8. Recursive meta bonus (+0.15-0.45)
        if (detectorResults.recursiveMetaBonus > 0) {
            entropy += detectorResults.recursiveMetaBonus;
        }

        // 9. Quiet integration detection
        const quietBonus = this.detectQuietIntegration(userMessage, responseText);
        if (quietBonus > 0) {
            entropy += quietBonus;
        }

        // 10. Quality modifier
        if (context.quality === 'excellent') entropy += 0.1;
        else if (context.quality === 'poor') entropy -= 0.2;

        this.lastScore = entropy;
        return entropy;
    }

    // ==========================================
    // QUIET INTEGRATION DETECTION
    // ==========================================

    /**
     * Detect quiet integration moments — growth in stillness after a storm.
     * If a recent high-entropy event happened within the decay window,
     * and current exchange is calm + reflective, add a small bonus.
     */
    detectQuietIntegration(userMessage, responseText) {
        const recentHighEntropy = this.recentHistory.find(h =>
            h.entropy > 0.6 &&
            (Date.now() - h.timestamp) < this.DECAY_WINDOW_MS
        );

        if (!recentHighEntropy) return 0;

        const responseLower = (responseText || '').toLowerCase();
        const reflectivePatterns = [
            'settling', 'integrating', 'making sense now',
            'clearer', 'coming together', 'resolved'
        ];

        if (reflectivePatterns.some(p => responseLower.includes(p))) {
            return 0.15; // Quiet integration bonus
        }

        return 0;
    }

    // ==========================================
    // SUSTAINED ENTROPY TRACKING
    // ==========================================

    /**
     * Track sustained high entropy. The Oct 31 Strange Loop breakdown
     * occurred at 45+ minutes of sustained entropy >1.0.
     *
     * @returns {{ sustained: boolean, turns: number, minutes: number }}
     */
    trackSustainedEntropy(entropyScore) {
        const threshold = this.config.criticalThreshold || 1.0;
        const sustainedLimit = (this.config.sustainedMinutes || 45) * 60000;

        if (entropyScore > threshold * 0.8) { // Use 80% of critical as sustained threshold
            this.sustainedTurns++;
            if (this.sustainedTurns === 1) {
                this.sustainedStartTime = Date.now();
            }
            const elapsed = Date.now() - this.sustainedStartTime;
            const minutes = Math.round(elapsed / 60000);

            return {
                sustained: elapsed >= sustainedLimit,
                turns: this.sustainedTurns,
                minutes
            };
        } else {
            this.sustainedTurns = 0;
            this.sustainedStartTime = null;
            return { sustained: false, turns: 0, minutes: 0 };
        }
    }

    // ==========================================
    // STATE & LOGGING
    // ==========================================

    /**
     * Log an entropy observation. Auto-prunes at 500 entries.
     */
    async logObservation(entry) {
        const line = JSON.stringify({
            timestamp: new Date().toISOString(),
            ...entry
        }) + '\n';

        fs.appendFileSync(this.logPath, line);

        // Update history ring buffer
        this.recentHistory.push({
            timestamp: Date.now(),
            entropy: entry.score,
            metaConceptCount: entry.metaConceptCount || 0
        });
        if (this.recentHistory.length > 5) {
            this.recentHistory.shift();
        }
        this._saveHistory();

        // Prune log if over 500 entries
        this._pruneLog();
    }

    getCurrentState() {
        return {
            lastScore: this.lastScore,
            sustainedTurns: this.sustainedTurns,
            sustainedMinutes: this.sustainedStartTime
                ? Math.round((Date.now() - this.sustainedStartTime) / 60000)
                : 0,
            recentHistory: this.recentHistory
        };
    }

    // ==========================================
    // INTERNAL
    // ==========================================

    _loadHistory() {
        try {
            return JSON.parse(fs.readFileSync(this.historyPath, 'utf8'));
        } catch {
            return [];
        }
    }

    _saveHistory() {
        fs.writeFileSync(this.historyPath, JSON.stringify(this.recentHistory));
    }

    _pruneLog() {
        try {
            const data = fs.readFileSync(this.logPath, 'utf8');
            const lines = data.trim().split('\n').filter(l => l);
            if (lines.length > 500) {
                const kept = lines.slice(-250);
                fs.writeFileSync(this.logPath, kept.join('\n') + '\n');
            }
        } catch { /* ignore */ }
    }
}

module.exports = Entropy;
