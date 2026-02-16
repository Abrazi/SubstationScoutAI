
import { SFCNode } from './types';

export const parseSFC = (code: string): SFCNode[] => {
    const nodes: SFCNode[] = [];
    if (!code) return nodes;

    const lines = code.split('\n');
    const stateNames = new Map<string, string>();

    // 0. Detect which state variable name is used (not always `state`) and initial-step heuristic
    let initialStepId: string | null = null;
    let stateVarName = 'state';

    // Try to detect the state variable by scanning for IF <var> = STATE_... or assignments like <var> := STATE_...
    const stateVarMatch = code.match(/IF\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*STATE_\w+/i) || code.match(/([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*STATE_\w+/i);
    if (stateVarMatch) {
        stateVarName = stateVarMatch[1];
    }

    // initial-step detection using the discovered state variable
    const initRegex = new RegExp(`IF\\s+${stateVarName}\\s*=\\s*undefined\\s+THEN\\s+${stateVarName}\\s*:=\\s*(STATE_\\w+)`, 'i');
    const initMatch = code.match(initRegex);
    if (initMatch) initialStepId = initMatch[1];

    // 1. Find States Constants
    // Looks for patterns like: STATE_NAME : INT := 0;
    const constRegex = /^\s*(STATE_\w+)\s*:\s*INT\s*:=\s*(\d+);/;

    lines.forEach(line => {
        const match = line.match(constRegex);
        if (match) {
            // store numeric value as string (used later for initial-step heuristics)
            stateNames.set(match[1], match[2]);
            nodes.push({
                id: match[1],
                label: match[1].replace('STATE_', ''),
                value: parseInt(match[2], 10),
                type: (initialStepId === match[1]) ? 'init' : 'step',
                transitions: [],
                actions: [],
                stepStartLine: -1,
                stepEndLine: -1
            });
        }
    });

    // If no explicit initial 'IF ... undefined' pattern found, try to detect initial from the
    // state variable default value inside the VAR block (e.g. `CurrentState : INT := 0;`).
    if (!initialStepId) {
        const varInitRe = new RegExp(`^\\s*${stateVarName}\\s*:\\s*INT\\s*:=\\s*(\\d+);`, 'mi');
        const varInitMatch = code.match(varInitRe);
        if (varInitMatch) {
            const initVal = parseInt(varInitMatch[1], 10);
            const initialNode = nodes.find(n => (n as any).value === initVal);
            if (initialNode) {
                initialNode.type = 'init';
                initialStepId = initialNode.id;
            }
        }
    }

    if (nodes.length === 0) return [];

    // 2. Find Transitions & Actions Logic
    let currentStep: string | null = null;
    let transitionPriorityCounter = 1;
    let ifDepth = 0;
    let stateChainDepth: number | null = null;

    const closeCurrentStep = (endLine: number) => {
        if (!currentStep) return;
        const node = nodes.find(n => n.id === currentStep);
        if (node) {
            node.stepEndLine = Math.max(node.stepStartLine, endLine);
        }
        currentStep = null;
        stateChainDepth = null;
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // Skip empty lines or pure multi-line comment delimiters if they are on a single line
        if (!trimmed || trimmed === '(*' || trimmed === '*)') continue;

        // Detect Step Block Start (use discovered state variable name)
        const stepRe = new RegExp(`(?:IF|ELSIF)\\s+${stateVarName}\\s*=\\s*(STATE_\\w+)\\s+THEN`, 'i');
        const stepMatch = trimmed.match(stepRe);

        // New state-step header closes previous step (for IF/ELSIF state chain)
        if (stepMatch && currentStep) {
            closeCurrentStep(i - 1);
        }

        if (stepMatch) {
            currentStep = stepMatch[1];
            transitionPriorityCounter = 1;
            const node = nodes.find(n => n.id === currentStep);
            if (node) node.stepStartLine = i;
            if (stateChainDepth === null) {
                // Depth of the state IF-chain after this header line starts
                stateChainDepth = ifDepth + (trimmed.toUpperCase().startsWith('IF ') ? 1 : 0);
            }
            if (trimmed.toUpperCase().startsWith('IF ')) {
                ifDepth++;
            }
            continue;
        }

        // Inside a step
        if (currentStep) {
            const node = nodes.find(n => n.id === currentStep);
            if (!node) continue;

            // Detect Transition Block (IF cond THEN <stateVar> := target)
            // Check for inline transition: IF cond THEN <stateVar> := TARGET; END_IF;
            const inlineTrans = trimmed.match(new RegExp(`^(?:\\(\\*[\\s\\S]*?\\*\\)\\s*)?IF\\s+(.+)\\s+THEN\\s+${stateVarName}\\s*:=\\s*(STATE_\\w+);\\s*END_IF;`, 'i'));
            if (inlineTrans && stateNames.has(inlineTrans[2])) {
                const blockText = line;
                const priMatch = blockText.match(/\(\*\s*PRI(?:ORITY)?\s*:\s*(\d+)\s*\*\)/i);
                const prio = priMatch ? parseInt(priMatch[1], 10) : transitionPriorityCounter++;
                node.transitions.push({
                    target: inlineTrans[2],
                    condition: inlineTrans[1].replace(/\(\*.*\*\)/g, '').trim(),
                    priority: prio,
                    explicitPriority: !!priMatch,
                    fullText: line,
                    lineIndex: i,
                    blockEndIndex: i
                });
                continue;
            }

            // Check for multiline transition start: IF cond THEN
            const transStartMatch = trimmed.match(/^IF\s+(.+)\s+THEN/i);

            if (transStartMatch) {
                // Scan forward looking for `<stateVar> := ...` at depth 1
                let isTransition = false;
                let targetState = '';
                let j = i;
                let blockEnd = i;
                let depth = 1;
                let foundAssign = false;

                while (j < lines.length - 1 && j < i + 20) {
                    j++;
                    const nextTrim = lines[j].trim();
                    if (/^IF\s+/i.test(nextTrim) && /\bTHEN$/i.test(nextTrim)) depth++;
                    if (/^END_IF;$/i.test(nextTrim)) depth--;

                    const assignMatch = nextTrim.match(new RegExp(`${stateVarName}\\s*:=\\s*(STATE_\\w+)`, 'i'));
                    if (assignMatch && depth >= 1) {
                        foundAssign = true;
                        targetState = assignMatch[1];
                    }

                    if (depth === 0) {
                        blockEnd = j;
                        break;
                    }
                }

                if (foundAssign && stateNames.has(targetState)) {
                    isTransition = true;
                    const blockText = lines.slice(i, blockEnd + 1).join('\n');
                    const priMatch = blockText.match(/\(\*\s*PRI(?:ORITY)?\s*:\s*(\d+)\s*\*\)/i);
                    const prio = priMatch ? parseInt(priMatch[1], 10) : transitionPriorityCounter++;
                    node.transitions.push({
                        target: targetState,
                        condition: transStartMatch[1].replace(/\(\*.*\*\)/g, '').trim(),
                        priority: prio,
                        explicitPriority: !!priMatch,
                        fullText: blockText,
                        lineIndex: i,
                        blockEndIndex: blockEnd
                    });

                    i = blockEnd;
                    continue;
                }
            }

            // Simple direct assignment transition: <stateVar> := TARGET
            const simpleAssign = trimmed.match(new RegExp(`^${stateVarName}\\s*:=\\s*(STATE_\\w+)`, 'i'));
            if (simpleAssign) {
                const target = simpleAssign[1];
                if (stateNames.has(target)) {
                    // detect priority comment on same or previous line
                    const prev = (lines[i - 1] || '').trim();
                    const blockText = `${prev}\n${line}`;
                    const priMatch = blockText.match(/\(\*\s*PRI(?:ORITY)?\s*:\s*(\d+)\s*\*\)/i);
                    const prio = priMatch ? parseInt(priMatch[1], 10) : transitionPriorityCounter++;
                    node.transitions.push({
                        target,
                        condition: "TRUE",
                        priority: prio,
                        explicitPriority: !!priMatch,
                        fullText: line,
                        lineIndex: i,
                        blockEndIndex: i
                    });
                    continue;
                }
            }

            // Action parsing
            // Check for explicit qualifier pattern: (* Q:X [T:time] *) Code
            const qualRegex = /^\(\*\s*Q:([A-Z0-9]+)(?:\s+T:([^ *]+))?\s*\*\)/;
            const isQualifierLine = qualRegex.test(trimmed);

            // Heuristic to ignore pure comment lines so they don't appear as empty actions
            const isPureComment = (trimmed.startsWith('(*') && !isQualifierLine);

            if (
                trimmed.length > 0 &&
                !isPureComment &&
                !trimmed.startsWith('VAR') &&
                !trimmed.startsWith('END_VAR') &&
                !/^(IF\b|ELSIF\b|ELSE\b|END_IF;?$|WHILE\b|END_WHILE;?$)/i.test(trimmed)
            ) {
                let qualifier: any = 'N';
                let time: string | undefined = undefined;
                let actionText = trimmed;

                const qualMatch = trimmed.match(qualRegex);
                if (qualMatch) {
                    qualifier = qualMatch[1];
                    if (qualMatch[2]) time = qualMatch[2];
                    actionText = trimmed.replace(qualRegex, '').trim();
                }

                actionText = actionText.replace(/;$/, '');
                node.actions.push({ qualifier, text: actionText, lineIndex: i });
            }
        }

        // Maintain IF nesting depth to close only the outer state-chain END_IF
        if (/^IF\b.*\bTHEN\s*$/i.test(trimmed)) {
            ifDepth++;
        }

        if (/^END_IF;$/i.test(trimmed)) {
            ifDepth = Math.max(0, ifDepth - 1);
            if (currentStep && stateChainDepth !== null && ifDepth < stateChainDepth) {
                closeCurrentStep(i - 1);
            }
        }
    }

    // Close trailing step at EOF if parser ended inside an open state-chain
    if (currentStep) {
        closeCurrentStep(lines.length - 1);
    }

    return nodes;
};

export const resolveStateValue = (code: string, stateName: string): number | undefined => {
    const re = new RegExp('^\\s*' + stateName.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&') + "\\s*:\\s*INT\\s*:=\\s*(\\d+);", 'm');
    const m = code.match(re);
    return m ? parseInt(m[1], 10) : undefined;
};

export const resolveStateNameByValue = (code: string, value?: number | null) => {
    if (value === undefined || value === null) return undefined;
    const re = /^\s*(STATE_\w+)\s*:\s*INT\s*:=\s*(\d+);/gm;
    let match: RegExpExecArray | null;
    while ((match = re.exec(code)) !== null) {
        if (parseInt(match[2], 10) === value) return match[1];
    }
    return undefined;
};

export const getVariablesFromCode = (code: string) => {
    const vars: string[] = [];
    const varBlock = /VAR([\s\S]*?)END_VAR;/m.exec(code);
    if (!varBlock) return vars;
    const lines = varBlock[1].split('\n');
    for (const l of lines) {
        const m = l.trim().match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:/);
        if (m) vars.push(m[1]);
    }
    return vars;
};
