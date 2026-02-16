/**
 * after_tool_call hook — Loop detection.
 *
 * Fires after each tool call. Tracks consecutive same-tool calls,
 * file re-reads, and identical output patterns.
 *
 * On loop detection, injects a warning message into the conversation.
 */

const LoopDetection = require('../lib/loop-detection');
const path = require('path');
const fs = require('fs');

let loopDetector;
let initialized = false;

function initialize(pluginDir) {
    if (initialized) return;

    const configPath = path.join(pluginDir, 'config.default.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    loopDetector = new LoopDetection(config);
    initialized = true;
}

module.exports = async function after_tool_call({ toolName, toolResult, toolParams }) {
    initialize(path.join(__dirname, '..'));

    const output = typeof toolResult === 'string'
        ? toolResult
        : JSON.stringify(toolResult || '');

    const result = loopDetector.recordAndCheck(toolName, output, toolParams || {});

    if (result.loopDetected) {
        console.warn(`[Stability] Loop detected (${result.type}): ${result.message}`);

        // Return warning message for injection into conversation
        return {
            systemMessage: `[LOOP DETECTED] ${result.message}`
        };
    }

    return {};
};
