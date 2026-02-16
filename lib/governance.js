/**
 * Governance — rate limiting, deduplication, quiet hours, notification batching.
 *
 * Ported from Clint's serviceRateLimiter.js and notificationGovernor.js.
 */

class RateLimiter {
    constructor(config) {
        const gov = config.governance || {};
        this.limits = {
            perHour: gov.investigationsPerHour || 3,
            perDay: gov.investigationsPerDay || 20
        };

        this.hourlyCount = 0;
        this.dailyCount = 0;
        this.hourlyResetTime = Date.now() + 3600000;
        this.dailyResetTime = Date.now() + 86400000;
    }

    /**
     * Check if an investigation is allowed under current limits.
     */
    canInvestigate() {
        this._checkResets();
        return this.hourlyCount < this.limits.perHour &&
               this.dailyCount < this.limits.perDay;
    }

    /**
     * Record an investigation.
     */
    record() {
        this._checkResets();
        this.hourlyCount++;
        this.dailyCount++;
    }

    getStatus() {
        this._checkResets();
        return {
            hourly: `${this.hourlyCount}/${this.limits.perHour}`,
            daily: `${this.dailyCount}/${this.limits.perDay}`,
            allowed: this.canInvestigate()
        };
    }

    _checkResets() {
        const now = Date.now();
        if (now >= this.hourlyResetTime) {
            this.hourlyCount = 0;
            this.hourlyResetTime = now + 3600000;
        }
        if (now >= this.dailyResetTime) {
            this.dailyCount = 0;
            this.dailyResetTime = now + 86400000;
        }
    }
}

class Governance {
    constructor(config) {
        this.config = config.governance || {};
        this.rateLimiter = new RateLimiter(config);

        // Deduplication tracking
        this.recentTopics = new Map(); // topic -> timestamp
        this.deduplicationWindow = this.config.deduplicationWindowMs || 21600000; // 6 hours

        // Notification batching
        this.pendingNotifications = [];
        this.batchWindow = this.config.batchWindowMs || 30000; // 30 seconds
        this.batchTimer = null;
    }

    // ==========================================
    // QUIET HOURS
    // ==========================================

    /**
     * Check if current time is within quiet hours.
     * Handles overnight wrapping (e.g., 22:00-07:00).
     */
    isQuietHours() {
        const quietConfig = this.config.quietHours;
        if (!quietConfig) return false;

        const now = new Date();
        const currentMinutes = now.getHours() * 60 + now.getMinutes();

        const [startH, startM] = (quietConfig.start || '22:00').split(':').map(Number);
        const [endH, endM] = (quietConfig.end || '07:00').split(':').map(Number);

        const startMinutes = startH * 60 + (startM || 0);
        const endMinutes = endH * 60 + (endM || 0);

        // Handle overnight wrap (e.g., 22:00 to 07:00)
        if (startMinutes > endMinutes) {
            return currentMinutes >= startMinutes || currentMinutes < endMinutes;
        }
        return currentMinutes >= startMinutes && currentMinutes < endMinutes;
    }

    // ==========================================
    // DEDUPLICATION
    // ==========================================

    /**
     * Check if a topic has been investigated recently.
     * Uses simple string matching within the deduplication window.
     */
    isDuplicate(topic) {
        if (!topic) return false;

        const normalized = topic.toLowerCase().trim();
        const now = Date.now();

        // Clean expired entries
        for (const [key, timestamp] of this.recentTopics) {
            if (now - timestamp > this.deduplicationWindow) {
                this.recentTopics.delete(key);
            }
        }

        // Check for match
        for (const [key] of this.recentTopics) {
            if (this._similarity(normalized, key) > 0.8) {
                return true;
            }
        }

        return false;
    }

    /**
     * Record a topic as investigated.
     */
    recordTopic(topic) {
        if (!topic) return;
        this.recentTopics.set(topic.toLowerCase().trim(), Date.now());
    }

    // ==========================================
    // NOTIFICATION BATCHING
    // ==========================================

    /**
     * Queue a notification for batched delivery.
     * Notifications are held for batchWindow ms, then delivered together.
     *
     * @param {Object} notification - { content, priority, channel }
     * @param {Function} deliverFn - Called with array of batched notifications
     */
    queueNotification(notification, deliverFn) {
        this.pendingNotifications.push({
            ...notification,
            queuedAt: Date.now()
        });

        // Reset batch timer
        if (this.batchTimer) clearTimeout(this.batchTimer);
        this.batchTimer = setTimeout(() => {
            const batch = [...this.pendingNotifications];
            this.pendingNotifications = [];
            this.batchTimer = null;

            if (batch.length > 0 && deliverFn) {
                deliverFn(batch);
            }
        }, this.batchWindow);
    }

    // ==========================================
    // DELIVERY PATH DECISIONS
    // ==========================================

    /**
     * Decide delivery path for a finding.
     *
     * @returns {'immediate'|'briefing'|'store'|'discard'}
     */
    decideDeliveryPath(finding) {
        // During quiet hours, queue for briefing
        if (this.isQuietHours()) return 'briefing';

        // Duplicates get discarded
        if (this.isDuplicate(finding.topic)) return 'discard';

        // High priority = immediate
        if (finding.priority >= 0.8) return 'immediate';

        // Medium priority = store for later
        if (finding.priority >= 0.5) return 'store';

        // Low priority = briefing
        return 'briefing';
    }

    // ==========================================
    // INTERNAL
    // ==========================================

    _similarity(a, b) {
        // Simple word overlap similarity
        const wordsA = new Set(a.split(/\s+/));
        const wordsB = new Set(b.split(/\s+/));

        let intersection = 0;
        for (const w of wordsA) {
            if (wordsB.has(w)) intersection++;
        }

        const union = wordsA.size + wordsB.size - intersection;
        return union === 0 ? 0 : intersection / union;
    }
}

module.exports = Governance;
