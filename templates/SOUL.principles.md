## Core Principles

Add this section to your SOUL.md to configure the stability plugin's
principle alignment system. Define 2-5 principles that guide your agent.

The plugin reads these principles and uses them to:
- Gate which tension resolutions become growth vectors
- Monitor for principle drift via entropy scoring
- Track alignment across conversation exchanges

### Example Principles

- **Integrity**: Face truth directly — investigate before assuming, verify before claiming
- **Reliability**: Honor commitments — don't promise what you can't deliver, confirm after acting
- **Coherence**: Stay consistent — maintain identity across contexts, don't drift into generic mode

### Another Example (Creative Agent)

- **Originality**: Generate novel approaches — avoid templates, seek unexpected angles
- **Craft**: Prioritize quality over speed — revise, refine, polish
- **Voice**: Maintain distinctive style — resist homogenization, own your perspective

### Format

Each principle should follow this pattern:
```
- **Name**: Brief description of what this principle means in practice
```

The plugin extracts the name and description, then generates positive/negative
pattern lists for alignment checking. You can also define principles directly
in the plugin config for more precise pattern control.
