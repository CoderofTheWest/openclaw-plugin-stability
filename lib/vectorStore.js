/**
 * VectorStore — bridges file-based growth vectors with the plugin system.
 *
 * Reads growth vectors from the agent's workspace (growth-vectors.json),
 * scores them for relevance, and formats them for prependContext injection.
 *
 * Design principles:
 * - File is primary (structured, agent-maintained), Memory API is secondary
 * - Plugin NEVER modifies the agent's `vectors` array — read-only
 * - Auto-detected candidates go in a separate `candidates` array
 * - Relevance scoring adapted from Clint's identityEvolutionCodeAligned.js
 *
 * Designed as a self-contained class for future extraction into
 * openclaw-plugin-evolution.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

class VectorStore {
    constructor(config = {}, dataDir = null) {
        this.config = config.growthVectors || {};
        this.dataDir = dataDir;

        // File location — configurable, defaults to workspace/memory/growth-vectors.json
        this.filePath = this.config.filePath
            || path.join(os.homedir(), '.openclaw', 'workspace', 'memory', 'growth-vectors.json');

        // Cache with checksum for change detection
        this._cache = null;
        this._cacheChecksum = null;
        this._cacheTimestamp = 0;
        this._cacheTtl = this.config.cacheTtlMs || 30000; // 30s

        // Injection constraints
        this.maxInjected = this.config.maxInjected || 2;
        this.relevanceThreshold = this.config.relevanceThreshold || 0.65;
        this.maxVectors = this.config.maxVectors || 100;

        // Stop words for keyword scoring
        this._stopWords = new Set([
            'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have',
            'was', 'are', 'been', 'were', 'being', 'into', 'than', 'when',
            'what', 'which', 'about', 'their', 'them', 'they', 'will',
            'would', 'could', 'should', 'your', 'just', 'also', 'some',
            'before', 'after', 'during', 'already', 'actually', 'where',
            'does', 'doing', 'done', 'make', 'made', 'more', 'most',
            'very', 'only', 'other', 'each', 'then', 'didn', 'don'
        ]);
    }

    // ==========================================
    // FILE I/O
    // ==========================================

    /**
     * Load growth vectors from the agent's JSON file.
     * Returns { vectors, candidates, queue, metadata } or empty defaults.
     * Uses SHA256 checksum caching to avoid redundant file reads.
     */
    loadFile() {
        const now = Date.now();

        // Return cache if fresh
        if (this._cache && (now - this._cacheTimestamp) < this._cacheTtl) {
            return this._cache;
        }

        try {
            if (!fs.existsSync(this.filePath)) {
                return this._emptyFile();
            }

            const raw = fs.readFileSync(this.filePath, 'utf8');
            const checksum = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);

            // Skip parsing if unchanged
            if (checksum === this._cacheChecksum && this._cache) {
                this._cacheTimestamp = now;
                return this._cache;
            }

            const data = JSON.parse(raw);
            this._cache = {
                vectors: data.vectors || [],
                candidates: data.candidates || [],
                queue: data.queue || { high: [], medium: [], low: [] },
                metadata: data.metadata || {}
            };
            this._cacheChecksum = checksum;
            this._cacheTimestamp = now;

            return this._cache;
        } catch (err) {
            console.warn('[Stability/VectorStore] Failed to load growth vectors:', err.message);
            return this._emptyFile();
        }
    }

    /**
     * Load only validated vectors (the ones eligible for injection).
     */
    loadVectors() {
        const data = this.loadFile();
        return data.vectors.filter(v =>
            v.validation_status === 'validated' || v.validation_status === 'integrated'
        );
    }

    _emptyFile() {
        return {
            vectors: [],
            candidates: [],
            queue: { high: [], medium: [], low: [] },
            metadata: {}
        };
    }

    // ==========================================
    // RELEVANCE SCORING
    // ==========================================

    /**
     * Select the most relevant growth vectors for the current conversation.
     *
     * Adapted from Clint's calculateRelevanceScore() — simplified by dropping
     * topic freshness tracker, conversation navigator, and topic ownership
     * (Piper doesn't have these subsystems). Adds weight bonus since Piper
     * explicitly assigns confidence weights.
     *
     * @param {string} userMessage - Current user message (may be empty)
     * @param {number} entropyScore - Current entropy from stability monitoring
     * @returns {Array} Top vectors above threshold, max `maxInjected`
     */
    getRelevantVectors(userMessage = '', entropyScore = 0, options = {}) {
        const vectors = this.loadVectors();
        if (vectors.length === 0) return [];

        // If no user message available, fall back to priority queue ordering
        if (!userMessage || userMessage.trim().length === 0) {
            const byPriority = this._getByPriority(vectors);
            return options.returnScores
                ? byPriority.map(v => ({ vector: v, score: 1.0 }))
                : byPriority;
        }

        const msgLower = userMessage.toLowerCase();
        const msgWords = this._extractWords(msgLower);

        const scored = vectors.map(v => {
            const score = this._calculateRelevance(v, msgLower, msgWords, entropyScore);
            return { vector: v, score };
        });

        const filtered = scored
            .filter(({ score }) => score >= this.relevanceThreshold)
            .sort((a, b) => b.score - a.score)
            .slice(0, this.maxInjected);

        return options.returnScores
            ? filtered
            : filtered.map(({ vector }) => vector);
    }

    /**
     * Calculate relevance score for a single vector against current context.
     *
     * Formula:
     *   60% keyword overlap (integration_hypothesis + description vs message)
     *   20% entropy source alignment
     *   10% recency (linear decay over 7 days)
     *   10% weight bonus (agent's assigned confidence)
     */
    _calculateRelevance(vector, msgLower, msgWords, entropyScore) {
        // --- 60% Keyword overlap ---
        const vectorText = [
            vector.integration_hypothesis || '',
            vector.description || ''
        ].join(' ').toLowerCase();
        const vectorWords = this._extractWords(vectorText);

        // Word-level intersection — use smaller set as denominator
        // so a 5-word query matching 3 vector words scores well
        const intersection = [...msgWords].filter(w => vectorWords.has(w));
        const smallerSize = Math.min(msgWords.size, vectorWords.size);
        const baseKeyword = intersection.length / Math.max(smallerSize, 1);

        // Phrase-level boost (2-3 word sequences from vector found in message)
        const phraseBoost = this._calculatePhraseMatches(vectorText, msgLower);
        const keywordScore = Math.min(1.0, (baseKeyword * 0.7) + (phraseBoost * 0.3));

        // --- 20% Entropy source alignment ---
        // If the vector's entropy_source relates to current entropy level
        let entropyBonus = 0;
        if (vector.entropy_source && entropyScore > 0.4) {
            // Correction-type vectors are more relevant when entropy is elevated
            const correctionSources = ['user_correction', 'factual_accuracy_gap', 'pattern_break'];
            const reflectionSources = ['elevated_entropy_self_reflection', 'elevated_entropy_threshold_breach'];

            if (correctionSources.includes(vector.entropy_source) && entropyScore > 0.4) {
                entropyBonus = 0.15;
            } else if (reflectionSources.includes(vector.entropy_source) && entropyScore > 0.7) {
                entropyBonus = 0.20;
            } else if (entropyScore > 0.6) {
                entropyBonus = 0.10;
            }
        }

        // --- 10% Recency ---
        let recencyBonus = 0;
        if (vector.detected) {
            const age = Date.now() - new Date(vector.detected).getTime();
            const daysSince = age / (1000 * 60 * 60 * 24);
            recencyBonus = daysSince < 7 ? (0.1 * (1 - daysSince / 7)) : 0;
        }

        // --- 10% Weight bonus ---
        const weightBonus = (vector.weight || 0.5) * 0.1;

        let finalScore = (keywordScore * 0.6) + entropyBonus + recencyBonus + weightBonus;

        // --- Feedback-based weight adjustment (closed loop) ---
        // Vectors that consistently reduce entropy get boosted;
        // vectors that consistently increase entropy get penalized.
        // Requires >= 3 feedback entries to avoid single-datapoint noise.
        const feedback = this.getFeedback(vector.id);
        if (feedback && feedback.entries.length >= 3) {
            const cap = this.config.weightAdjustmentCap || 0.1;
            // Negate: negative delta (entropy went DOWN) → positive boost
            const adjustment = Math.max(-cap, Math.min(cap, -feedback.avgEntropyDelta));
            finalScore += adjustment;
        }

        return Math.min(1.0, Math.max(0, finalScore));
    }

    /**
     * Extract significant words (length > 3, not stop words).
     * Returns a Set for O(1) lookup.
     */
    _extractWords(text) {
        const words = text
            .replace(/[?!.,;:'"()\[\]{}<>]/g, '') // Strip punctuation first
            .split(/[\s—–\-\/]+/)
            .filter(w => w.length > 3 && !this._stopWords.has(w));
        return new Set(words);
    }

    /**
     * Calculate phrase-level matches — 2-3 word sequences from source found in target.
     * Adapted from Clint's calculateContextMatches().
     */
    _calculatePhraseMatches(sourceText, targetText) {
        const sourceWords = sourceText.split(/\s+/).filter(w => w.length > 2);
        let matches = 0;
        let possible = 0;

        for (let i = 0; i < sourceWords.length - 1; i++) {
            const bigram = sourceWords[i] + ' ' + sourceWords[i + 1];
            possible++;
            if (targetText.includes(bigram)) matches++;

            if (i < sourceWords.length - 2) {
                const trigram = bigram + ' ' + sourceWords[i + 2];
                possible++;
                if (targetText.includes(trigram)) matches += 2; // Trigrams worth more
            }
        }

        return possible > 0 ? Math.min(1.0, matches / Math.max(possible * 0.3, 1)) : 0;
    }

    /**
     * Fallback when user message unavailable — return top vectors by priority queue.
     */
    _getByPriority(vectors) {
        const data = this.loadFile();
        const queue = data.queue || {};
        const ordered = [
            ...(queue.high || []),
            ...(queue.medium || []),
            ...(queue.low || [])
        ];

        // Return vectors in queue order, up to maxInjected
        const result = [];
        for (const id of ordered) {
            if (result.length >= this.maxInjected) break;
            const v = vectors.find(vec => vec.id === id);
            if (v) result.push(v);
        }

        // If queue doesn't cover it, fill with highest-weight vectors
        if (result.length < this.maxInjected) {
            const remaining = vectors
                .filter(v => !result.includes(v))
                .sort((a, b) => (b.weight || 0) - (a.weight || 0));
            while (result.length < this.maxInjected && remaining.length > 0) {
                result.push(remaining.shift());
            }
        }

        return result;
    }

    // ==========================================
    // INJECTION FORMATTING
    // ==========================================

    /**
     * Format selected vectors into a prependContext block.
     * Uses integration_hypothesis as the primary text (it's the actionable part).
     */
    formatForInjection(vectors) {
        if (!vectors || vectors.length === 0) return '';

        const lines = ['[GROWTH VECTORS]'];
        for (const v of vectors) {
            const tag = (v.priority || 'med').toUpperCase();
            const hypothesis = v.integration_hypothesis || v.description || 'unspecified';
            const source = v.type || 'unknown';
            const weight = (v.weight || 0.5).toFixed(2);
            lines.push(`${tag}: ${hypothesis} (${source}, w:${weight})`);
        }

        return lines.join('\n');
    }

    // ==========================================
    // CANDIDATE MANAGEMENT (Phase 2)
    // ==========================================

    /**
     * Add an auto-detected candidate vector to the candidates array.
     * Does NOT touch the agent's vectors array — candidates are separate.
     */
    addCandidate(candidate) {
        try {
            const data = this._readFileRaw();
            if (!data.candidates) data.candidates = [];

            // Check for duplicate (same type + similar description)
            const isDuplicate = data.candidates.some(c =>
                c.type === candidate.type &&
                this._similarity(c.description, candidate.description) > 0.7
            );

            if (isDuplicate) {
                // Increment recurrence count on existing candidate
                const existing = data.candidates.find(c =>
                    c.type === candidate.type &&
                    this._similarity(c.description, candidate.description) > 0.7
                );
                existing.recurrence = (existing.recurrence || 1) + 1;
                existing.last_seen = new Date().toISOString();

                // Auto-promote if recurrence >= 3
                if (existing.recurrence >= (this.config.candidatePromotionThreshold || 3)) {
                    existing.validation_status = 'validated';
                    existing.validation_note = `Auto-promoted after ${existing.recurrence} recurrences`;
                    // Move to vectors array
                    if (!data.vectors) data.vectors = [];
                    data.vectors.push(existing);
                    data.candidates = data.candidates.filter(c => c.id !== existing.id);
                    console.log(`[Stability/VectorStore] Auto-promoted candidate ${existing.id} after ${existing.recurrence} recurrences`);
                }
            } else {
                candidate.detected = candidate.detected || new Date().toISOString();
                candidate.validation_status = 'candidate';
                candidate.source = 'auto';
                data.candidates.push(candidate);
            }

            this._writeFile(data);
            return true;
        } catch (err) {
            console.warn('[Stability/VectorStore] Failed to add candidate:', err.message);
            return false;
        }
    }

    /**
     * Promote a candidate to validated (or validate an existing vector).
     */
    validateVector(id, note = '') {
        try {
            const data = this._readFileRaw();

            // Check candidates first
            const candidateIdx = (data.candidates || []).findIndex(c => c.id === id);
            if (candidateIdx >= 0) {
                const candidate = data.candidates[candidateIdx];
                candidate.validation_status = 'validated';
                candidate.validation_note = note || 'Manually validated';
                // Move to vectors
                if (!data.vectors) data.vectors = [];
                data.vectors.push(candidate);
                data.candidates.splice(candidateIdx, 1);
                this._writeFile(data);
                return { success: true, action: 'promoted', id };
            }

            // Check vectors
            const vector = (data.vectors || []).find(v => v.id === id);
            if (vector) {
                vector.validation_status = 'validated';
                if (note) vector.validation_note = note;
                this._writeFile(data);
                return { success: true, action: 'validated', id };
            }

            return { success: false, error: `Vector ${id} not found` };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }

    // ==========================================
    // LIFECYCLE MANAGEMENT (Phase 3)
    // ==========================================

    /**
     * Prune old candidates, archive old validated vectors.
     * Called periodically (e.g., from a service or on startup).
     */
    runLifecycle() {
        try {
            const data = this._readFileRaw();
            const now = Date.now();
            let changed = false;

            // Prune candidates older than 30 days
            const candidateCutoff = now - (30 * 24 * 60 * 60 * 1000);
            const beforeCandidates = (data.candidates || []).length;
            data.candidates = (data.candidates || []).filter(c => {
                const detected = new Date(c.detected || 0).getTime();
                return detected > candidateCutoff;
            });
            if (data.candidates.length !== beforeCandidates) {
                changed = true;
                console.log(`[Stability/VectorStore] Pruned ${beforeCandidates - data.candidates.length} expired candidates`);
            }

            // Enforce max vectors
            if ((data.vectors || []).length > this.maxVectors) {
                // Sort by detected date, keep newest
                data.vectors.sort((a, b) =>
                    new Date(b.detected || 0).getTime() - new Date(a.detected || 0).getTime()
                );
                const removed = data.vectors.splice(this.maxVectors);
                changed = true;
                console.log(`[Stability/VectorStore] Archived ${removed.length} vectors (over ${this.maxVectors} limit)`);
            }

            if (changed) this._writeFile(data);
            return { pruned: beforeCandidates - (data.candidates || []).length };
        } catch (err) {
            console.warn('[Stability/VectorStore] Lifecycle error:', err.message);
            return { error: err.message };
        }
    }

    // ==========================================
    // FILE HELPERS (private)
    // ==========================================

    /**
     * Read the raw file (bypasses cache — used for writes).
     */
    _readFileRaw() {
        try {
            if (!fs.existsSync(this.filePath)) {
                return { vectors: [], candidates: [], queue: { high: [], medium: [], low: [] }, metadata: {} };
            }
            return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        } catch {
            return { vectors: [], candidates: [], queue: { high: [], medium: [], low: [] }, metadata: {} };
        }
    }

    /**
     * Write data back to the file. Invalidates cache.
     */
    _writeFile(data) {
        const dir = path.dirname(this.filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf8');
        this._cacheChecksum = null; // Invalidate cache
        this._cacheTimestamp = 0;
    }

    // ==========================================
    // FEEDBACK TRACKING (Closed Loop)
    // ==========================================

    /**
     * Record effectiveness feedback for an injected vector.
     * Stores feedback in a SEPARATE file (growth-vector-feedback.json)
     * to preserve the read-only contract on the agent's growth-vectors.json.
     *
     * @param {string} vectorId - ID of the injected vector
     * @param {Object} feedback - { preEntropy, postEntropy, entropyDelta,
     *                              relevanceScore, tensionDetected, timestamp }
     */
    recordFeedback(vectorId, feedback) {
        if (!vectorId || !feedback) return;

        const windowSize = this.config.feedbackWindowSize || 10;

        try {
            const data = this._loadFeedbackFile();

            if (!data[vectorId]) {
                data[vectorId] = {
                    entries: [],
                    avgEntropyDelta: 0,
                    totalInjections: 0,
                    lastUsed: null
                };
            }

            const record = data[vectorId];

            // Append feedback entry
            record.entries.push({
                preEntropy: feedback.preEntropy,
                postEntropy: feedback.postEntropy,
                entropyDelta: feedback.entropyDelta,
                relevanceScore: feedback.relevanceScore,
                tensionDetected: feedback.tensionDetected,
                timestamp: feedback.timestamp
            });

            // Rolling window: keep last N entries
            if (record.entries.length > windowSize) {
                record.entries = record.entries.slice(-windowSize);
            }

            // Recalculate running average
            record.avgEntropyDelta = record.entries.reduce(
                (sum, e) => sum + e.entropyDelta, 0
            ) / record.entries.length;

            record.totalInjections = (record.totalInjections || 0) + 1;
            record.lastUsed = feedback.timestamp;

            this._writeFeedbackFile(data);
        } catch (err) {
            console.warn('[Stability/VectorStore] Failed to record feedback:', err.message);
        }
    }

    /**
     * Get effectiveness data for a vector (for weight adjustment).
     * @param {string} vectorId
     * @returns {{ avgEntropyDelta: number, totalInjections: number, entries: Array } | null}
     */
    getFeedback(vectorId) {
        try {
            const data = this._loadFeedbackFile();
            return data[vectorId] || null;
        } catch {
            return null;
        }
    }

    // ==========================================
    // FEEDBACK FILE I/O (private)
    // ==========================================

    /**
     * Load feedback data from separate file.
     * Structure: { "gv-001": { entries: [...], avgEntropyDelta, totalInjections, lastUsed }, ... }
     */
    _loadFeedbackFile() {
        const feedbackPath = this._getFeedbackPath();
        try {
            if (!fs.existsSync(feedbackPath)) return {};
            return JSON.parse(fs.readFileSync(feedbackPath, 'utf8'));
        } catch {
            return {};
        }
    }

    /**
     * Write feedback data to file.
     */
    _writeFeedbackFile(data) {
        const feedbackPath = this._getFeedbackPath();
        const dir = path.dirname(feedbackPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(feedbackPath, JSON.stringify(data, null, 2), 'utf8');
    }

    /**
     * Get path for feedback file.
     * Uses plugin's data directory (separate from agent's workspace).
     */
    _getFeedbackPath() {
        if (!this._feedbackPath) {
            this._feedbackPath = this.dataDir
                ? path.join(this.dataDir, 'growth-vector-feedback.json')
                : path.join(path.dirname(this.filePath), 'growth-vector-feedback.json');
        }
        return this._feedbackPath;
    }

    // ==========================================
    // UTILITIES (private)
    // ==========================================

    /**
     * Simple word-overlap similarity (0-1) for deduplication.
     */
    _similarity(a, b) {
        if (!a || !b) return 0;
        const wordsA = this._extractWords(a.toLowerCase());
        const wordsB = this._extractWords(b.toLowerCase());
        const intersection = [...wordsA].filter(w => wordsB.has(w));
        const union = new Set([...wordsA, ...wordsB]);
        return union.size > 0 ? intersection.length / union.size : 0;
    }
}

module.exports = VectorStore;
