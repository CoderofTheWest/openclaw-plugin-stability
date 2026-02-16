/**
 * Investigation background service — two-phase investigation system.
 *
 * Phase 1: Agent proposes investigation intent during heartbeat.
 * Phase 2: On next heartbeat cycle, intent is executed.
 *
 * Ported from Clint's heartbeat investigation system.
 */

const fs = require('fs');
const path = require('path');
const Governance = require('../lib/governance');

class InvestigationService {
    constructor(config, dataDir) {
        this.config = config;
        this.dataDir = dataDir;
        this.statePath = path.join(dataDir, 'investigation-state.json');
        this.governance = new Governance(config);

        this.state = this._loadState();
    }

    // ==========================================
    // SERVICE LIFECYCLE
    // ==========================================

    async start() {
        console.log('[Stability] Investigation service started');
        this.state = this._loadState();
    }

    async stop() {
        this._saveState();
        console.log('[Stability] Investigation service stopped');
    }

    // ==========================================
    // TWO-PHASE INVESTIGATION
    // ==========================================

    /**
     * Parse investigation intent from heartbeat response.
     *
     * Looks for:
     *   INVESTIGATION_INTENT:
     *   topic: [What to investigate]
     *   lane: [SERVICE|AWARENESS|GROWTH]
     *   deliverable: [telegram_brief|stored_resource|architectural_note]
     *   scope: [quick|investigation]
     *   rationale: [Why this serves the user]
     */
    parseIntent(responseText) {
        if (!responseText) return null;
        if (!responseText.includes('INVESTIGATION_INTENT') &&
            !responseText.includes('investigation_intent')) {
            return null;
        }

        try {
            const topicMatch = responseText.match(/topic:\s*(.+?)(?:\n|$)/i);
            const laneMatch = responseText.match(/lane:\s*(SERVICE|AWARENESS|GROWTH)/i);
            const deliverableMatch = responseText.match(
                /deliverable:\s*(telegram_brief|stored_resource|architectural_note)/i
            );
            const scopeMatch = responseText.match(/scope:\s*(quick|investigation)/i);
            const rationaleMatch = responseText.match(/rationale:\s*(.+?)(?:\n|$)/i);

            if (topicMatch && laneMatch && deliverableMatch) {
                return {
                    topic: topicMatch[1].trim(),
                    lane: laneMatch[1].toUpperCase(),
                    deliverable: deliverableMatch[1].toLowerCase(),
                    scope: scopeMatch ? scopeMatch[1].toLowerCase() : 'quick',
                    rationale: rationaleMatch ? rationaleMatch[1].trim() : '',
                    queuedAt: new Date().toISOString()
                };
            }
        } catch (err) {
            console.warn('[Stability] Failed to parse investigation intent:', err.message);
        }

        return null;
    }

    /**
     * Queue an investigation intent for execution on next cycle.
     */
    queueIntent(intent) {
        if (this.governance.isDuplicate(intent.topic)) {
            console.log('[Stability] Duplicate investigation topic, skipping');
            return false;
        }

        if (!this.governance.rateLimiter.canInvestigate()) {
            console.log('[Stability] Investigation rate limit reached');
            return false;
        }

        this.state.queuedIntent = intent;
        this._saveState();

        console.log(`[Stability] Investigation intent queued: ${intent.topic}`);
        return true;
    }

    /**
     * Check if there's a queued intent ready for execution.
     */
    hasQueuedIntent() {
        return this.state.queuedIntent !== null;
    }

    /**
     * Get and clear the queued intent.
     */
    consumeQueuedIntent() {
        const intent = this.state.queuedIntent;
        if (intent) {
            this.state.queuedIntent = null;
            this.governance.rateLimiter.record();
            this.governance.recordTopic(intent.topic);
            this._saveState();
        }
        return intent;
    }

    /**
     * Get current investigation state (for heartbeat prompt context).
     */
    getStateForPrompt() {
        this._resetDailyIfNeeded();

        return {
            lastCheck: this.state.lastCheck,
            investigationsToday: this.state.investigationsToday,
            queuedIntent: this.state.queuedIntent,
            recentTopics: Object.keys(this.state.recentTopics || {})
        };
    }

    // ==========================================
    // STATE MANAGEMENT
    // ==========================================

    _loadState() {
        try {
            return JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
        } catch {
            return {
                lastCheck: null,
                lastInvestigation: null,
                investigationsToday: 0,
                todayDate: new Date().toISOString().split('T')[0],
                queuedIntent: null,
                recentTopics: {}
            };
        }
    }

    _saveState() {
        fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
    }

    _resetDailyIfNeeded() {
        const today = new Date().toISOString().split('T')[0];
        if (this.state.todayDate !== today) {
            this.state.todayDate = today;
            this.state.investigationsToday = 0;
            this._saveState();
        }
    }
}

module.exports = InvestigationService;
