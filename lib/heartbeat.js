/**
 * Heartbeat decision framework + decision log.
 *
 * Ported from Clint's heartbeat.js.
 * Provides structured decision taxonomy (GROUND/TEND/SURFACE/INTEGRATE)
 * and inter-beat continuity via decision logging.
 *
 * Uses OpenClaw's memory system for decision persistence.
 */

class Heartbeat {
    constructor(config) {
        this.config = config.heartbeat || {};
        this.enabled = this.config.decisionFramework !== false;
        this.recentCount = this.config.recentDecisionsInPrompt || 3;
    }

    // ==========================================
    // DECISION PARSING
    // ==========================================

    /**
     * Parse a structured decision from response text.
     * Looks for: DECISION: GROUND|TEND|SURFACE|INTEGRATE — reason
     *
     * @returns {{ decision: string, reason: string } | null}
     */
    parseDecision(responseText) {
        if (!responseText) return null;

        const match = responseText.match(
            /DECISION:\s*(GROUND|TEND|SURFACE|INTEGRATE)\s*[—\-]\s*(.+?)(?:\n|$)/i
        );

        if (!match) return null;

        return {
            decision: match[1].toUpperCase(),
            reason: match[2].trim()
        };
    }

    /**
     * Check if a response indicates nothing needs attention.
     * Recognizes both structured GROUND decisions and natural-language equivalents.
     */
    isGroundStable(responseText) {
        if (!responseText) return false;
        const normalized = responseText.toLowerCase();

        // Structured decision
        if (normalized.includes('decision: ground')) return true;

        // Natural language equivalents
        if (normalized.includes('ground stable')) return true;
        if (normalized.includes('continuity maintained')) return true;
        if (normalized.includes('presence maintained')) return true;
        if (normalized.includes('nothing requires attention')) return true;

        // Legacy
        const upper = responseText.trim().toUpperCase();
        return upper.startsWith('HEARTBEAT_OK') || upper === 'HEARTBEAT_OK';
    }

    // ==========================================
    // DECISION LOGGING (via OpenClaw Memory)
    // ==========================================

    /**
     * Log a heartbeat decision to OpenClaw memory.
     */
    async logDecision(responseText, memoryApi) {
        if (!memoryApi) return;

        const parsed = this.parseDecision(responseText);
        if (!parsed) {
            // If ground-stable but no structured decision, log as GROUND
            if (this.isGroundStable(responseText)) {
                parsed = { decision: 'GROUND', reason: 'Nothing needs attention' };
            } else {
                return; // Can't parse, skip
            }
        }

        const content = `[Heartbeat Decision] ${parsed.decision} — ${parsed.reason}`;

        try {
            await memoryApi.store(content, {
                type: 'heartbeat_decision',
                decision: parsed.decision,
                reason: parsed.reason,
                timestamp: new Date().toISOString()
            });
        } catch (err) {
            console.warn('[Stability] Failed to log heartbeat decision:', err.message);
        }
    }

    /**
     * Read recent decisions from OpenClaw memory for prompt injection.
     *
     * @returns {Array<{ time: string, decision: string }>}
     */
    async readRecentDecisions(memoryApi) {
        if (!memoryApi) return [];

        try {
            const results = await memoryApi.search('type:heartbeat_decision', {
                limit: this.recentCount,
                sort: 'newest'
            });

            return results.map(r => {
                const timeStr = r.metadata?.timestamp
                    ? new Date(r.metadata.timestamp).toLocaleTimeString('en-US', {
                        hour: 'numeric', minute: '2-digit'
                    })
                    : 'unknown';

                return {
                    time: timeStr,
                    decision: `${r.metadata?.decision || '?'} — ${r.metadata?.reason || r.content?.substring(0, 50)}`
                };
            });
        } catch {
            return [];
        }
    }

    // ==========================================
    // PROMPT GENERATION
    // ==========================================

    /**
     * Generate the decision framework block for injection into heartbeat prompts.
     * This replaces the freeform "Ground stable" / "Integration in progress" patterns.
     */
    getDecisionFrameworkPrompt() {
        return `## Decision (required)
Choose one and state why in one sentence:
- GROUND — Nothing needs attention. Presence maintained.
- TEND — An unfinished thread or relational need wants gentle attention. State what.
- SURFACE — Something should be brought to the user's attention. State what.
- INTEGRATE — A tension or correction is being metabolized. State the integration.

Format: DECISION: [GROUND|TEND|SURFACE|INTEGRATE] — [one sentence reason]
Then optionally add 1-2 lines of context if needed.`;
    }

    /**
     * Generate the recent decisions block for prompt injection.
     */
    async getRecentDecisionsPrompt(memoryApi) {
        const decisions = await this.readRecentDecisions(memoryApi);
        if (decisions.length === 0) return '';

        let block = '[RECENT HEARTBEAT DECISIONS]\n';
        for (const d of decisions) {
            block += `${d.time}: ${d.decision}\n`;
        }
        return block;
    }
}

module.exports = Heartbeat;
