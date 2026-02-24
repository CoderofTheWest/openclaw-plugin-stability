/**
 * Loop detection — consecutive-tool tracking, file re-read detection, output hash comparison.
 *
 * Ported from Clint's agentRuntime.js.
 * Prevents agents from getting stuck in repetitive tool-call patterns.
 */

class LoopDetection {
    constructor(config) {
        this.config = config.loopDetection || {};
        this.consecutiveThreshold = this.config.consecutiveToolThreshold || 5;
        this.rereadThreshold = this.config.fileRereadThreshold || 3;
        this.exemptTools = new Set(this.config.exemptTools || []);

        // Per-session tracking (resets when session ends)
        this.toolHistory = [];       // Array of { tool, hash, timestamp }
        this.fileReadCounts = {};    // { filePath: count }
    }

    // ==========================================
    // DJB2 HASH
    // ==========================================

    /**
     * Fast DJB2 hash for output comparison.
     */
    djb2Hash(str) {
        let hash = 5381;
        for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) + hash) + str.charCodeAt(i);
            hash = hash & hash; // Convert to 32-bit integer
        }
        return hash;
    }

    // ==========================================
    // DETECTION METHODS
    // ==========================================

    /**
     * Record a tool call and check for loops.
     *
     * @param {string} toolName - Name of tool called
     * @param {string} output - Tool output content
     * @param {Object} params - Tool parameters (for file path detection)
     * @returns {{ loopDetected: boolean, type: string|null, message: string|null }}
     */
    recordAndCheck(toolName, output, params = {}) {
        const hash = this.djb2Hash(output || '');

        this.toolHistory.push({
            tool: toolName,
            hash,
            timestamp: Date.now()
        });

        // Keep bounded
        if (this.toolHistory.length > 20) {
            this.toolHistory.shift();
        }

        // Track file reads
        const filePath = params.file_path || params.path || params.filePath;
        if (filePath && this._isReadTool(toolName)) {
            this.fileReadCounts[filePath] = (this.fileReadCounts[filePath] || 0) + 1;
        }

        // Exempt tools still get recorded in history but skip all detection checks
        if (this.exemptTools.has(toolName)) {
            return { loopDetected: false, type: null, message: null };
        }

        // Check all loop types
        const consecutive = this._checkConsecutive();
        if (consecutive) return consecutive;

        const reread = this._checkFileReread(filePath);
        if (reread) return reread;

        const outputRepeat = this._checkOutputRepetition();
        if (outputRepeat) return outputRepeat;

        return { loopDetected: false, type: null, message: null };
    }

    /**
     * Reset tracking state (call at session start/end).
     */
    reset() {
        this.toolHistory = [];
        this.fileReadCounts = {};
    }

    // ==========================================
    // INTERNAL CHECKS
    // ==========================================

    _checkConsecutive() {
        const recent = this.toolHistory.slice(-this.consecutiveThreshold);
        if (recent.length < this.consecutiveThreshold) return null;

        const allSame = recent.every(t => t.tool === recent[0].tool);
        if (allSame) {
            return {
                loopDetected: true,
                type: 'consecutive_tool',
                message: `You've called ${recent[0].tool} ${this.consecutiveThreshold} consecutive times. Step back and reassess your approach.`
            };
        }
        return null;
    }

    _checkFileReread(filePath) {
        if (!filePath) return null;

        const count = this.fileReadCounts[filePath] || 0;
        if (count >= this.rereadThreshold) {
            return {
                loopDetected: true,
                type: 'file_reread',
                message: `You've read ${filePath} ${count} times. You likely already have the information you need.`
            };
        }
        return null;
    }

    _checkOutputRepetition() {
        const recent = this.toolHistory.slice(-3);
        if (recent.length < 3) return null;

        const allSameHash = recent.every(t => t.hash === recent[0].hash);
        if (allSameHash && recent[0].hash !== 0) {
            return {
                loopDetected: true,
                type: 'output_repetition',
                message: 'The last 3 tool calls produced identical output. You may be stuck in a loop.'
            };
        }
        return null;
    }

    _isReadTool(toolName) {
        const readTools = ['read_file', 'cat', 'head', 'tail', 'Read', 'read'];
        return readTools.includes(toolName);
    }
}

module.exports = LoopDetection;
