
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Icons } from './Icons';
import { engine } from '../services/SimulationEngine';
import { DebugState, IEDNode } from '../types';

interface ScriptEditorProps {
  ieds: IEDNode[];
  initialDeviceId?: string;
}

const DEFAULT_SCRIPT = `(* IEC 61131-3 Logic *)
(* Device: Controller_01 *)

VAR
  STATE_INITIAL : INT := 0;
  STATE_STANDSTILL : INT := 1;
  STATE_RUN  : INT := 2;
  STATE_SHUTDOWN : INT := 3;
  temp_val : REAL;
  counter : INT;
END_VAR

IF state = undefined THEN state := STATE_INITIAL; END_IF;

(* Main State Machine *)
IF state = STATE_INITIAL THEN
   (* Q:N *) temp_val := Device.ReadInput('30001') / 100.0;
   counter := 0;
   Device.Log('info', 'Initialization complete');
   
   (* Transition *)
    IF TRUE THEN 
         state := STATE_STANDSTILL; 
   END_IF;

ELSIF state = STATE_STANDSTILL THEN
    (* Q:N *) temp_val := Device.ReadInput('30001') / 100.0;
    Device.Log('info', 'Standstill');

    (* Transition *)
    IF temp_val > 50.0 THEN
         state := STATE_RUN;
    END_IF;

ELSIF state = STATE_RUN THEN
   (* Q:S *) Device.WriteCoil('00001', TRUE);
   counter := counter + 1;
   Device.Log('info', 'Running... Counter: ' + counter);
   temp_val := Device.ReadInput('30001') / 100.0;
   
   (* Transitions *)
   IF Device.ReadCoil('2') = FALSE THEN 
       state := STATE_SHUTDOWN;
   ELSIF counter > 100 THEN
       state := STATE_STANDSTILL;
   END_IF;

ELSIF state = STATE_SHUTDOWN THEN
   (* Q:R *) Device.WriteCoil('00001', FALSE);
   Device.Log('info', 'System shutdown');
   
   (* Transition *)
   IF TRUE THEN
       state := STATE_STANDSTILL;
   END_IF;
END_IF;
`;

// --- SFC Visualizer Types & Helper ---
const ACTION_QUALIFIERS = ['N', 'S', 'R', 'L', 'D', 'P', 'P1', 'P0', 'DS', 'SL'] as const;
const TIME_QUALIFIERS = ['L', 'D', 'DS', 'SL'];
const MAX_UNDO_HISTORY = 100;

interface SFCTransition {
    target: string;
    condition: string;
    priority: number;
    explicitPriority?: boolean;
    fullText: string;
    lineIndex: number; 
    blockEndIndex: number;
}

interface SFCAction {
    qualifier: typeof ACTION_QUALIFIERS[number];
    time?: string;
    text: string;
    lineIndex: number;
}

interface EditableAction {
    id: string;
    code: string; // multiline code
    qualifier: string; // Action-level qualifier (N, P1, P0, S, R, etc.)
    time?: string;     // Optional duration for time qualifiers (L, D, DS, SL)
}

interface SFCNode {
    id: string;
    label: string;
    type: 'init' | 'step';
    value?: number;
    actions: SFCAction[];
    transitions: SFCTransition[];
    stepStartLine: number;
    stepEndLine: number;
}

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

// --- SFC Analyzer & Helpers (basic, fast checks used by the UI) ---
export const analyzeSFC = (nodes: SFCNode[], code: string) => {
    const diagnostics: Array<{severity: 'error'|'warning'|'info', code: string, message: string, nodes?: string[]}> = [];
    if (nodes.length === 0) return diagnostics;

    // Initial step checks
    const initials = nodes.filter(n => n.type === 'init');
    if (initials.length === 0) diagnostics.push({ severity: 'error', code: 'IEC-SFC-001', message: 'No initial step detected — exactly one required.' });
    if (initials.length > 1) diagnostics.push({ severity: 'error', code: 'IEC-SFC-002', message: `Multiple initial steps detected (${initials.length}) — exactly one required.`, nodes: initials.map(n => n.id) });

    if (initials.length === 1) {
        const initNode = initials[0];
        if (initNode.id !== 'STATE_INITIAL') {
            diagnostics.push({
                severity: 'error',
                code: 'IEC-SFC-008',
                message: `Initial step must be named STATE_INITIAL (found: ${initNode.id}).`,
                nodes: [initNode.id]
            });
        }

        const hasStandstillTransition = initNode.transitions.some(t => t.target === 'STATE_STANDSTILL');
        if (!hasStandstillTransition) {
            diagnostics.push({
                severity: 'error',
                code: 'IEC-SFC-009',
                message: 'Initial step must transition to STATE_STANDSTILL as first operating step.',
                nodes: [initNode.id]
            });
        }
    }

    // Enforce "runtime variable initialization in INITIAL step", not in VAR block
    const varBlock = /VAR([\s\S]*?)END_VAR;/im.exec(code);
    if (varBlock) {
        const nonStateInit = varBlock[1]
            .split('\n')
            .map(l => l.trim())
            .filter(Boolean)
            .filter(l => /:=/.test(l))
            .filter(l => !/^STATE_/i.test(l));
        if (nonStateInit.length > 0) {
            diagnostics.push({
                severity: 'warning',
                code: 'IEC-SFC-010',
                message: 'Move non-state variable initialization from VAR block into STATE_INITIAL actions.'
            });
        }
    }

    // Reachability (BFS)
    const startId = initials[0]?.id;
    if (startId) {
        const visited = new Set<string>();
        const q: string[] = [startId];
        while (q.length) {
            const id = q.shift()!;
            if (visited.has(id)) continue;
            visited.add(id);
            const node = nodes.find(n => n.id === id);
            if (!node) continue;
            node.transitions.forEach(t => { if (!visited.has(t.target)) q.push(t.target); });
        }
        // Determine additional states referenced anywhere by assignment (e.g. `state := STATE_X`) —
        // treat those as reachable to avoid false-positive unreachable diagnostics when parseSFC misses complex patterns.
        const stateVarMatch = code.match(/IF\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*STATE_\w+/i) || code.match(/([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*STATE_\w+/i);
        const possibleStateVar = (stateVarMatch && stateVarMatch[1]) || 'state';
        const assignRe = new RegExp('\\b' + possibleStateVar.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&') + '\\s*:=\\s*(STATE_\\w+)', 'gi');
        const referencedTargets = new Set<string>();
        let am: RegExpExecArray | null;
        while ((am = assignRe.exec(code)) !== null) referencedTargets.add(am[1]);

        nodes.filter(n => !visited.has(n.id)).forEach(n => {
            if (referencedTargets.has(n.id)) return; // referenced somewhere — consider reachable
            diagnostics.push({ severity: 'warning', code: 'IEC-SFC-003', message: `Unreachable step: ${n.label}`, nodes: [n.id] });
        });

        // Deadlock detection (reachable step with no outgoing transitions and not obviously final)
        nodes.filter(n => visited.has(n.id)).forEach(n => {
            if (n.transitions.length === 0) {
                const lname = n.label.toLowerCase();
                if (!lname.includes('end') && !lname.includes('final')) {
                    diagnostics.push({ severity: 'warning', code: 'IEC-SFC-004', message: `Possible deadlock: step '${n.label}' has no outgoing transitions.`, nodes: [n.id] });
                }
            }
        });
    }

    // Nesting depth enforcement (recommendation)
    nodes.forEach(n => {
        if (n.stepStartLine >= 0 && n.stepEndLine >= 0) {
            const lines = code.split('\n').slice(n.stepStartLine, n.stepEndLine + 1);
            let depth = 0;
            let maxDepth = 0;
            for (const l of lines) {
                const t = l.trim();
                if (/^IF\s+/.test(t) && /\s+THEN$/.test(t)) { depth++; maxDepth = Math.max(maxDepth, depth); }
                if (/^END_IF;/.test(t)) depth = Math.max(0, depth - 1);
            }
            if (maxDepth > 8) diagnostics.push({ severity: 'error', code: 'IEC-SFC-005', message: `Nesting depth ${maxDepth} in step '${n.label}' exceeds recommended maximum (8).`, nodes: [n.id] });
        }
    });

    // Branching hints
    nodes.forEach(n => {
        if (n.transitions.length > 1) {
            const priorities = n.transitions.map(t => t.priority);
            const unique = new Set(priorities);
            const hasExplicit = n.transitions.some(t => (t as any).explicitPriority);
            if (unique.size !== priorities.length) {
                diagnostics.push({ severity: 'warning', code: 'IEC-SFC-006', message: `Duplicate transition priorities in step '${n.label}'.` , nodes: [n.id] });
            } else if (!hasExplicit) {
                // Only prompt to verify OR/AND semantics when explicit priorities are NOT present
                diagnostics.push({ severity: 'info', code: 'IEC-SFC-007', message: `Branching detected in step '${n.label}' — verify OR/AND semantics and explicit priorities.`, nodes: [n.id] });
            }
        }
    });

    return diagnostics;
};

const resolveStateValue = (code: string, stateName: string): number | undefined => {
    const re = new RegExp('^\\s*' + stateName.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&') + "\\s*:\\s*INT\\s*:=\\s*(\\d+);", 'm');
    const m = code.match(re);
    return m ? parseInt(m[1], 10) : undefined;
};

const resolveStateNameByValue = (code: string, value?: number | null) => {
    if (value === undefined || value === null) return undefined;
    const re = /^\s*(STATE_\w+)\s*:\s*INT\s*:=\s*(\d+);/gm;
    let match: RegExpExecArray | null;
    while ((match = re.exec(code)) !== null) {
        if (parseInt(match[2], 10) === value) return match[1];
    }
    return undefined;
};

const getVariablesFromCode = (code: string) => {
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

// --- SFC Code-manipulation helpers (exported for testing and UI operations) ---
export const renameStateInCode = (code: string, oldStateId: string, newStateId: string) => {
    if (!oldStateId || !newStateId || oldStateId === newStateId) return code;
    const escOld = oldStateId.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
    const wordRe = new RegExp('\\b' + escOld + '\\b', 'g');
    return code.replace(wordRe, newStateId);
};

export const removeStateFromCode = (code: string, stateId: string, stateVarName = 'state') => {
    if (!stateId) return code;
    const escState = stateId.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
    // Remove VAR constant line
    const varRe = new RegExp('^\\s*' + escState + '\\s*:\\s*INT\\s*:=\\s*\\d+;\\s*\\n?', 'm');
    let out = code.replace(varRe, '');
    // Remove step block (IF/ELSIF <stateVarName> = STATE_X THEN ... up to next ELSIF or END_IF;)
    const stepBlockRe = new RegExp('(?:IF|ELSIF)\\s+' + stateVarName + '\\s*=\\s*' + escState + '\\s+THEN[\\s\\S]*?(?=(?:\\n\\s*(?:ELSIF\\s+' + stateVarName + '|END_IF;)|$))', 'i');
    out = out.replace(stepBlockRe, '');
    // Remove direct assignments to the removed state
    const assignRe = new RegExp('\\b' + stateVarName.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&') + '\\s*:=\\s*' + escState + '\\b;?', 'g');
    out = out.replace(assignRe, '');
    // Finally strip any remaining textual references to the removed state (e.g. in OR chains)
    out = out.replace(new RegExp('\\b' + escState + '\\b', 'g'), '');
    return out;
};

export const reorderTransitionBlocks = (code: string, nodeId: string, fromIndex: number, toIndex: number) => {
    const nodes = parseSFC(code);
    const node = nodes.find(n => n.id === nodeId);
    if (!node || node.transitions.length < 2) return code;
    const lines = code.split('\n');
    const blocks = node.transitions.map(t => ({ start: t.lineIndex, end: t.blockEndIndex, text: lines.slice(t.lineIndex, t.blockEndIndex + 1).join('\n') }));
    blocks.sort((a,b) => a.start - b.start);
    if (fromIndex < 0 || fromIndex >= blocks.length || toIndex < 0 || toIndex >= blocks.length) return code;
    const moved = blocks.splice(fromIndex, 1)[0];
    blocks.splice(toIndex, 0, moved);
    // Remove original blocks from code (descending order)
    const originalRanges = node.transitions.map(t => ({ start: t.lineIndex, end: t.blockEndIndex })).sort((a,b) => b.start - a.start);
    for (const r of originalRanges) {
        lines.splice(r.start, r.end - r.start + 1);
    }
    const insertAt = Math.min(...originalRanges.map(r => r.start));
    const insertText = blocks.map(b => b.text).join('\n');
    lines.splice(insertAt, 0, insertText);
    return lines.join('\n');
};

const exportPLCopenXML = (nodes: SFCNode[], code?: string) => {
    const pouName = 'SFC_POU';
    const xmlParts: string[] = [];
    xmlParts.push('<?xml version="1.0" encoding="utf-8"?>');
    xmlParts.push('<project>');
    xmlParts.push(`  <pou name="${pouName}">`);
    xmlParts.push('    <sfc>');
    xmlParts.push('      <steps>');
    nodes.forEach(n => {
        xmlParts.push(`        <step id="${n.id}"><name>${n.label}</name><initial>${n.type === 'init'}</initial></step>`);
    });
    xmlParts.push('      </steps>');
    xmlParts.push('      <transitions>');
    nodes.forEach(n => n.transitions.forEach(t => {
        xmlParts.push(`        <transition source="${n.id}" target="${t.target}"><condition>${t.condition}</condition><priority>${t.priority}</priority></transition>`);
    }));
    xmlParts.push('      </transitions>');
    xmlParts.push('    </sfc>');
    xmlParts.push('  </pou>');
    xmlParts.push('</project>');
    const xml = xmlParts.join('\n');
    const blob = new Blob([xml], { type: 'application/xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `plcopen-sfc-${Date.now()}.xml`;
    a.click();
    URL.revokeObjectURL(url);
};

const formatElapsed = (ms: number | null) => {
    if (ms === null) return '--';
    if (ms < 1000) return `${ms} ms`;
    const s = Math.floor(ms / 1000);
    return `${s}s`;
};

export const ScriptEditor: React.FC<ScriptEditorProps> = ({ ieds, initialDeviceId }) => {
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>(initialDeviceId || ieds[0]?.id || '');
  const [code, setCode] = useState(DEFAULT_SCRIPT);
  const [tickRate, setTickRate] = useState(100);
  const [consoleOutput, setConsoleOutput] = useState<string[]>(['> System initialized.', '> Select a device to edit logic.']);
  const [isDirty, setIsDirty] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [viewMode, setViewMode] = useState<'code' | 'sfc'>('code');
  const [zoomLevel, setZoomLevel] = useState(100);
  const [consoleHeight, setConsoleHeight] = useState(250); // Console height in pixels
  const [isResizingConsole, setIsResizingConsole] = useState(false);
    const [rightPanelWidth, setRightPanelWidth] = useState(320);
    const [isResizingRightPanel, setIsResizingRightPanel] = useState(false);
    const [debugPanelWidth, setDebugPanelWidth] = useState(320);
    const [isResizingDebugPanel, setIsResizingDebugPanel] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(true);
  const [showTrace, setShowTrace] = useState(true);
  const [showConsole, setShowConsole] = useState(true);
  
  // Structured Action Editor State
  const [actionEditor, setActionEditor] = useState<{
      isOpen: boolean;
      nodeId: string;
      actions: EditableAction[];
  }>({ isOpen: false, nodeId: '', actions: [] });

  const [codeEditorModal, setCodeEditorModal] = useState<{
      isOpen: boolean;
      actionId: string;
      code: string;
      title: string;
  }>({ isOpen: false, actionId: '', code: '', title: '' });

  // Transition Editor State
  const [editModal, setEditModal] = useState<{
      isOpen: boolean;
      title: string;
      content: string;
      type: 'transition';
      nodeId: string;
      transitionIdx?: number;
      priority?: number;
      target?: string;
  }>({ isOpen: false, title: '', content: '', type: 'transition', nodeId: '' });

  // Creation Modal State
  const [addModal, setAddModal] = useState<{
      isOpen: boolean;
      type: 'step' | 'transition';
      sourceId?: string;
  }>({ isOpen: false, type: 'step' });
  const [newStepName, setNewStepName] = useState('');
  const [newTransTarget, setNewTransTarget] = useState('');
  const [newTransCond, setNewTransCond] = useState('TRUE');
    const [retargetModal, setRetargetModal] = useState<{
            isOpen: boolean;
            nodeId?: string;
            transitionIdx?: number;
            target: string;
    }>({ isOpen: false, nodeId: undefined, transitionIdx: undefined, target: '' });
      const [insertStepModal, setInsertStepModal] = useState<{
          isOpen: boolean;
          nodeId?: string;
          transitionIdx?: number;
          stepName: string;
      }>({ isOpen: false, nodeId: undefined, transitionIdx: undefined, stepName: '' });

  // --- Modal state for prompt/confirm replacements ---
  const [renameModal, setRenameModal] = useState<{ isOpen: boolean; nodeId?: string; value: string }>({ isOpen: false, nodeId: undefined, value: '' });
  const [deleteModal, setDeleteModal] = useState<{ isOpen: boolean; nodeId?: string; label?: string }>({ isOpen: false, nodeId: undefined });
  const [forceModal, setForceModal] = useState<{ isOpen: boolean; nodeId?: string; label?: string }>({ isOpen: false, nodeId: undefined });
  // Inline priority editor state
  const [editingPriority, setEditingPriority] = useState<{ nodeId?: string; idx?: number; value?: number }>({});
  // Normalization step size (configurable via SFC toolbar)
  const [normalizeStepSize, setNormalizeStepSize] = useState<number>(10);

  // Debug State
  const [debugState, setDebugState] = useState<DebugState>({
      isRunning: false,
      isPaused: false,
      activeDeviceId: null,
      currentLine: 0,
      variables: {},
      breakpoints: []
  });
  
  const [isCompiling, setIsCompiling] = useState(false);
  const [transitionTrace, setTransitionTrace] = useState<Array<{timestamp:number, from?: number | null, to?: number | null, deviceId?: string}>>([]);
  const transitionTraceRef = useRef<{timestamp:number, from?: number | null, to?: number | null, deviceId?: string} | null>(null);
  const [forcedSteps, setForcedSteps] = useState<Record<string, boolean>>({});
  const [showPrintBounds, setShowPrintBounds] = useState(false);
  const [findReplaceOpen, setFindReplaceOpen] = useState(false);
  const [showDebugPanel, setShowDebugPanel] = useState(false);
  const [debugPanelTab, setDebugPanelTab] = useState<'variables' | 'breakpoints' | 'watch'>('variables');
  const [watchExpressions, setWatchExpressions] = useState<string[]>([]);
    const [breakpointConditions, setBreakpointConditions] = useState<Record<number, string>>({});
    const [breakpointHitCounts, setBreakpointHitCounts] = useState<Record<number, string>>({});
    const [changedVars, setChangedVars] = useState<Record<string, number>>({});
    const prevVarsRef = useRef<Record<string, any>>({});
    const [editingDebugVar, setEditingDebugVar] = useState<{ name: string; value: string } | null>(null);
  const [newWatchExpr, setNewWatchExpr] = useState('');
  const [findText, setFindText] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [historyDepth, setHistoryDepth] = useState({ undo: 0, redo: 0 });
    const [draftMeta, setDraftMeta] = useState<{ hasDraft: boolean; restored: boolean; savedAt?: number }>({ hasDraft: false, restored: false, savedAt: undefined });
    const [selectedTransition, setSelectedTransition] = useState<{ nodeId?: string; idx?: number }>({});
    const [transitionContextMenu, setTransitionContextMenu] = useState<{ isOpen: boolean; x: number; y: number; nodeId?: string; idx?: number }>({ isOpen: false, x: 0, y: 0, nodeId: undefined, idx: undefined });
  const lastStateRef = useRef<number | null>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const lineContainerRef = useRef<HTMLDivElement>(null);
  const sfcContainerRef = useRef<HTMLDivElement>(null);
  const sfcNodeRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const undoHistoryRef = useRef<string[]>([DEFAULT_SCRIPT]);
  const undoIndexRef = useRef<number>(0);
  const skipHistoryCaptureRef = useRef<boolean>(false);

  const getDraftKey = (deviceId: string) => `substation-scout:draft:${deviceId}`;

  const syncHistoryDepth = () => {
      const undo = undoIndexRef.current;
      const redo = Math.max(0, undoHistoryRef.current.length - undoIndexRef.current - 1);
      setHistoryDepth({ undo, redo });
  };

  const resetHistory = (snapshot: string) => {
      undoHistoryRef.current = [snapshot];
      undoIndexRef.current = 0;
      syncHistoryDepth();
  };

  const pushHistory = (snapshot: string) => {
      const current = undoHistoryRef.current[undoIndexRef.current];
      if (snapshot === current) return;
      const base = undoHistoryRef.current.slice(0, undoIndexRef.current + 1);
      base.push(snapshot);
      if (base.length > MAX_UNDO_HISTORY) {
          undoHistoryRef.current = base.slice(base.length - MAX_UNDO_HISTORY);
          undoIndexRef.current = undoHistoryRef.current.length - 1;
      } else {
          undoHistoryRef.current = base;
          undoIndexRef.current = base.length - 1;
      }
      syncHistoryDepth();
  };

  const undoCodeChange = () => {
      if (undoIndexRef.current <= 0) return;
      undoIndexRef.current -= 1;
      skipHistoryCaptureRef.current = true;
      setCode(undoHistoryRef.current[undoIndexRef.current]);
      setIsDirty(true);
      syncHistoryDepth();
  };

  const redoCodeChange = () => {
      if (undoIndexRef.current >= undoHistoryRef.current.length - 1) return;
      undoIndexRef.current += 1;
      skipHistoryCaptureRef.current = true;
      setCode(undoHistoryRef.current[undoIndexRef.current]);
      setIsDirty(true);
      syncHistoryDepth();
  };

  const discardDraft = () => {
      if (!selectedDeviceId) return;
      try {
          localStorage.removeItem(getDraftKey(selectedDeviceId));
      } catch {
          // Ignore storage errors
      }

      const config = engine.getScriptConfig(selectedDeviceId);
      const fallbackCode = config?.code || DEFAULT_SCRIPT;
      const fallbackTickRate = config?.tickRate || 100;

      skipHistoryCaptureRef.current = true;
      setCode(fallbackCode);
      setTickRate(fallbackTickRate);
      resetHistory(fallbackCode);
      setIsDirty(false);
      setDraftMeta({ hasDraft: false, restored: false, savedAt: undefined });
      setConsoleOutput(prev => [...prev, `> Draft discarded for ${selectedDeviceId}. Restored last saved logic.`]);
  };

  const openTransitionContextMenu = (e: React.MouseEvent, nodeId: string, idx: number) => {
      e.preventDefault();
      e.stopPropagation();
      setSelectedTransition({ nodeId, idx });
      setTransitionContextMenu({ isOpen: true, x: e.clientX, y: e.clientY, nodeId, idx });
  };

  const closeTransitionContextMenu = () => {
      setTransitionContextMenu({ isOpen: false, x: 0, y: 0, nodeId: undefined, idx: undefined });
  };

  const runTransitionAction = (action: 'edit' | 'retarget' | 'insert' | 'delete' | 'normalize') => {
      const nodeId = selectedTransition.nodeId;
      const idx = selectedTransition.idx;
      if (!nodeId || idx === undefined) return;
      const node = sfcNodes.find(n => n.id === nodeId);
      if (!node) return;

      if (action === 'edit') {
          handleEditTransition(node, idx);
      } else if (action === 'retarget') {
          handleOpenRetargetTransition(node, idx);
      } else if (action === 'insert') {
          handleOpenInsertStepBetween(node, idx);
      } else if (action === 'delete') {
          deleteTransition(node, idx);
      } else if (action === 'normalize') {
          normalizePriorities(node.id, normalizeStepSize);
      }
      closeTransitionContextMenu();
  };

  // Console resize handlers
  const handleConsoleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizingConsole(true);
  };

    const handleRightPanelResizeStart = (e: React.MouseEvent) => {
        e.preventDefault();
        setIsResizingRightPanel(true);
    };

    const handleDebugPanelResizeStart = (e: React.MouseEvent) => {
        e.preventDefault();
        setIsResizingDebugPanel(true);
    };

  useEffect(() => {
    if (!isResizingConsole) return;

    const handleMouseMove = (e: MouseEvent) => {
      const rightPanel = document.querySelector('.right-panel-container');
      if (!rightPanel) return;
      
      const panelRect = rightPanel.getBoundingClientRect();
      const newHeight = panelRect.bottom - e.clientY;
      
      // Constrain console height between 100px and 80% of panel height
      const minHeight = 100;
      const maxHeight = panelRect.height * 0.8;
      setConsoleHeight(Math.max(minHeight, Math.min(maxHeight, newHeight)));
    };

    const handleMouseUp = () => {
      setIsResizingConsole(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizingConsole]);

    useEffect(() => {
        if (!isResizingRightPanel) return;

        const handleMouseMove = (e: MouseEvent) => {
            const newWidth = window.innerWidth - e.clientX;
            const minWidth = 240;
            const maxWidth = Math.min(720, Math.floor(window.innerWidth * 0.6));
            setRightPanelWidth(Math.max(minWidth, Math.min(maxWidth, newWidth)));
        };

        const handleMouseUp = () => {
            setIsResizingRightPanel(false);
        };

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);

        return () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };
    }, [isResizingRightPanel]);

    useEffect(() => {
        if (!isResizingDebugPanel) return;

        const handleMouseMove = (e: MouseEvent) => {
            const newWidth = window.innerWidth - e.clientX;
            const minWidth = 260;
            const maxWidth = Math.min(720, Math.floor(window.innerWidth * 0.7));
            setDebugPanelWidth(Math.max(minWidth, Math.min(maxWidth, newWidth)));
        };

        const handleMouseUp = () => {
            setIsResizingDebugPanel(false);
        };

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);

        return () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };
    }, [isResizingDebugPanel]);

  // SFC Data with Error Boundary
  const sfcNodes = useMemo(() => {
      try {
          return parseSFC(code);
      } catch (e) {
          console.error("Failed to parse SFC", e);
          return [];
      }
  }, [code]);

  // Diagnostics computed from parsed SFC + source code
  const diagnostics = useMemo(() => analyzeSFC(sfcNodes, code), [sfcNodes, code]);


  // Initialize Engine Devices
  useEffect(() => {
      ieds.forEach(ied => engine.registerDevice(ied.id, ied.name));
  }, [ieds]);

  useEffect(() => {
      if (!selectedDeviceId) return;
      const config = engine.getScriptConfig(selectedDeviceId);
      if (config) {
          let loadedCode = config.code || DEFAULT_SCRIPT;
          let loadedTickRate = config.tickRate || 100;
          let restoredFromDraft = false;
          let draftSavedAt: number | undefined;

          try {
              const rawDraft = localStorage.getItem(getDraftKey(selectedDeviceId));
              if (rawDraft) {
                  const parsedDraft = JSON.parse(rawDraft);
                  if (parsedDraft && typeof parsedDraft.code === 'string') {
                      loadedCode = parsedDraft.code;
                      if (typeof parsedDraft.tickRate === 'number') {
                          loadedTickRate = parsedDraft.tickRate;
                      }
                      if (typeof parsedDraft.savedAt === 'number') {
                          draftSavedAt = parsedDraft.savedAt;
                      }
                      restoredFromDraft = true;
                      setConsoleOutput(prev => [...prev, `> Restored draft for ${selectedDeviceId}.`]);
                  }
              }
          } catch {
              // Ignore malformed draft payloads
          }

          if (!config.code) {
              engine.updateScriptConfig({ deviceId: selectedDeviceId, code: DEFAULT_SCRIPT, tickRate: 100 });
          }

          skipHistoryCaptureRef.current = true;
          setCode(loadedCode);
          setTickRate(loadedTickRate);
          resetHistory(loadedCode);
          setIsDirty(false);
          setDraftMeta({ hasDraft: restoredFromDraft, restored: restoredFromDraft, savedAt: draftSavedAt });
      }
  }, [selectedDeviceId]);

  useEffect(() => {
      if (skipHistoryCaptureRef.current) {
          skipHistoryCaptureRef.current = false;
          return;
      }
      pushHistory(code);
  }, [code]);

  useEffect(() => {
      if (!selectedDeviceId) return;
      const timer = setInterval(() => {
          try {
              const savedAt = Date.now();
              localStorage.setItem(getDraftKey(selectedDeviceId), JSON.stringify({
                  code,
                  tickRate,
                  savedAt
              }));
              setDraftMeta(prev => ({ ...prev, hasDraft: true, savedAt }));
          } catch {
              // Ignore storage errors
          }
      }, 30000);

      return () => clearInterval(timer);
  }, [selectedDeviceId, code, tickRate]);

  useEffect(() => {
      if (!selectedDeviceId) return;
      const handleBeforeUnload = () => {
          try {
              localStorage.setItem(getDraftKey(selectedDeviceId), JSON.stringify({
                  code,
                  tickRate,
                  savedAt: Date.now()
              }));
          } catch {
              // Ignore storage errors
          }
      };

      window.addEventListener('beforeunload', handleBeforeUnload);
      return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [selectedDeviceId, code, tickRate]);

  useEffect(() => {
      engine.subscribeToDebug((state) => {
          setDebugState(state);
      });
  }, []);

  useEffect(() => {
      const prev = prevVarsRef.current;
      const now = debugState.variables || {};
      const changed: Record<string, number> = {};
      Object.keys(now).forEach((key) => {
          if (!(key in prev) || prev[key] !== now[key]) {
              changed[key] = Date.now();
          }
      });
      prevVarsRef.current = { ...now };
      if (Object.keys(changed).length > 0) {
          setChangedVars((old) => ({ ...old, ...changed }));
      }
  }, [debugState.variables]);

  useEffect(() => {
      const timer = setInterval(() => {
          const cutoff = Date.now() - 1500;
          setChangedVars((prev) => {
              const next: Record<string, number> = {};
              Object.entries(prev).forEach(([key, ts]) => {
                  if (ts >= cutoff) next[key] = ts;
              });
              return next;
          });
      }, 300);
      return () => clearInterval(timer);
  }, []);

  useEffect(() => {
      const activeDebugTarget = debugState.activeDeviceId === selectedDeviceId;
      const onKeyDown = (e: KeyboardEvent) => {
          const isUndoCombo = (e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z';
          const isRedoCombo = (e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'));

          if (isUndoCombo) {
              e.preventDefault();
              undoCodeChange();
              return;
          }

          if (isRedoCombo) {
              e.preventDefault();
              redoCodeChange();
              return;
          }

          if (viewMode === 'sfc') {
              const target = e.target as HTMLElement | null;
              const inTextField = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
              if (inTextField) return;

              if (e.key === 'Escape') {
                  closeTransitionContextMenu();
                  setSelectedTransition({});
                  return;
              }

              if (!selectedTransition.nodeId || selectedTransition.idx === undefined) return;

              const key = e.key.toLowerCase();
              if (key === 'e') {
                  e.preventDefault();
                  runTransitionAction('edit');
                  return;
              }
              if (key === 't') {
                  e.preventDefault();
                  runTransitionAction('retarget');
                  return;
              }
              if (key === 'i') {
                  e.preventDefault();
                  runTransitionAction('insert');
                  return;
              }
              if (key === 'n') {
                  e.preventDefault();
                  runTransitionAction('normalize');
                  return;
              }
              if (e.key === 'Delete' || e.key === 'Backspace') {
                  e.preventDefault();
                  runTransitionAction('delete');
                  return;
              }
          }

          if (viewMode !== 'code') return;

          if (e.key === 'F9') {
              e.preventDefault();
              let line = debugState.currentLine;
              if (editorRef.current) {
                  const text = editorRef.current.value;
                  const cursorPos = editorRef.current.selectionStart || 0;
                  line = text.slice(0, cursorPos).split('\n').length;
              }
              if (line > 0) toggleBreakpoint(line);
              return;
          }

          if (e.key === 'F5') {
              e.preventDefault();
              if (!debugState.isRunning) {
                  handleRun();
              } else if (debugState.isPaused) {
                  engine.resume();
              } else {
                  engine.pause(selectedDeviceId);
              }
              return;
          }

          if (e.key === 'F10') {
              e.preventDefault();
              if (debugState.isPaused && activeDebugTarget) {
                  engine.stepOver();
              }
          }
      };

      window.addEventListener('keydown', onKeyDown);
      return () => window.removeEventListener('keydown', onKeyDown);
    }, [viewMode, debugState.isRunning, debugState.isPaused, debugState.currentLine, debugState.activeDeviceId, selectedDeviceId, code, selectedTransition, normalizeStepSize, sfcNodes]);

  useEffect(() => {
      if (!transitionContextMenu.isOpen) return;
      const close = () => closeTransitionContextMenu();
      window.addEventListener('click', close);
      return () => window.removeEventListener('click', close);
  }, [transitionContextMenu.isOpen]);

  useEffect(() => {
      if (!selectedTransition.nodeId || selectedTransition.idx === undefined) return;
      const node = sfcNodes.find(n => n.id === selectedTransition.nodeId);
      if (!node || selectedTransition.idx < 0 || selectedTransition.idx >= node.transitions.length) {
          setSelectedTransition({});
          closeTransitionContextMenu();
      }
  }, [sfcNodes, selectedTransition]);

  // Detect state variable name used in the ST source (e.g. `state`, `CurrentState`)
  const detectedStateVar = useMemo(() => {
      const m1 = code.match(/IF\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*STATE_\w+/i);
      const m2 = code.match(/([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*STATE_\w+/i);
      return (m1 && m1[1]) || (m2 && m2[1]) || 'state';
  }, [code]);

  // Update transition trace when debugger reports a new state value for the selected device
  useEffect(() => {
      const stateVal = debugState.variables[detectedStateVar];
      if (debugState.activeDeviceId === selectedDeviceId && stateVal !== undefined) {
          if (lastStateRef.current !== stateVal) {
              setTransitionTrace(prev => [{ timestamp: Date.now(), from: lastStateRef.current, to: stateVal, deviceId: selectedDeviceId }, ...prev].slice(0, 1000));
              lastStateRef.current = stateVal;
          }
      }
  }, [debugState.variables, debugState.activeDeviceId, selectedDeviceId, detectedStateVar]); 

  // Auto-scroll to current line in debug mode (Code view)
  useEffect(() => {
      if (viewMode === 'code' && debugState.isPaused && debugState.currentLine > 0 && debugState.activeDeviceId === selectedDeviceId) {
          if (editorRef.current && lineContainerRef.current) {
              const lineHeight = 24; // 1.5rem = 24px
              const targetScrollTop = (debugState.currentLine - 1) * lineHeight - (editorRef.current.clientHeight / 2) + lineHeight;
              
              // Smooth scroll to the current line (centered in viewport)
              editorRef.current.scrollTo({
                  top: Math.max(0, targetScrollTop),
                  behavior: 'smooth'
              });
              
              // Sync line numbers container
              lineContainerRef.current.scrollTo({
                  top: Math.max(0, targetScrollTop),
                  behavior: 'smooth'
              });
          }
      }
  }, [viewMode, debugState.isPaused, debugState.currentLine, debugState.activeDeviceId, selectedDeviceId]);

  // ... (Handlers for scroll, save, run, stop, breakpoint) ...
  const handleScroll = () => {
      if (editorRef.current && lineContainerRef.current) {
          lineContainerRef.current.scrollTop = editorRef.current.scrollTop;
      }
  };

  const handleSave = () => {
      engine.updateScriptConfig({
          deviceId: selectedDeviceId,
          code: code,
          tickRate: tickRate
      });
      try {
          localStorage.removeItem(getDraftKey(selectedDeviceId));
      } catch {
          // Ignore storage errors
      }
      setDraftMeta({ hasDraft: false, restored: false, savedAt: undefined });
      setIsDirty(false);
      setConsoleOutput(prev => [...prev, `> Logic saved for ${selectedDeviceId}.`]);
  };

  const handleRun = () => {
    setIsCompiling(true);
    setConsoleOutput(prev => [...prev, `> Compiling logic for ${selectedDeviceId}...`]);
    setTimeout(() => {
        handleSave();
        const result = engine.compile(selectedDeviceId, code);
        if (result.success) {
            setConsoleOutput(prev => [...prev, '> Compilation Success.', '> Starting Engine...']);
            engine.start();
        } else {
            setConsoleOutput(prev => [...prev, `> Error: ${result.error}`]);
        }
        setIsCompiling(false);
    }, 500);
  };

  const handleStop = () => {
      engine.stop();
      setConsoleOutput(prev => [...prev, '> Runtime Halted.']);
  };

  const toggleBreakpoint = (lineNum: number) => {
      engine.toggleBreakpoint(selectedDeviceId, lineNum);
  };

  const handleDeviceSelect = (e: React.ChangeEvent<HTMLSelectElement>) => {
      const newDeviceId = e.target.value;
      if (isDirty) {
          engine.updateScriptConfig({ deviceId: selectedDeviceId, code: code, tickRate: tickRate });
          setConsoleOutput(prev => [...prev, `> Auto-saved changes for ${selectedDeviceId}`]);
      }
      setSelectedDeviceId(newDeviceId);
  };

  const draftSavedAtLabel = useMemo(() => {
      if (!draftMeta.savedAt) return null;
      return new Date(draftMeta.savedAt).toLocaleTimeString();
  }, [draftMeta.savedAt]);

  const handleCodeChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setCode(e.target.value);
      setIsDirty(true);
  };

  const handleTickRateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      setTickRate(parseInt(e.target.value) || 100);
      setIsDirty(true);
  };

  // --- SFC Editing Handlers ---

  const handleEditAction = (node: SFCNode) => {
      const lines = code.split('\n');
      const stepBodyLines: string[] = [];
      
      // Extract lines belonging to this step, excluding transitions
      for (let i = node.stepStartLine + 1; i <= node.stepEndLine; i++) {
          const inTransition = node.transitions.some(t => i >= t.lineIndex && i <= t.blockEndIndex);
          if (!inTransition) {
              stepBodyLines.push(lines[i]);
          }
      }

    // Parse body: detect qualifiers per action
      const qualRegex = /^\s*\(\*\s*Q:([A-Z0-9]+)(?:\s+T:([^ *]+))?\s*\*\)/;
      const actions: EditableAction[] = [];
      let currentActionCode: string[] = [];
      let currentQualifier = 'N';
      let currentTime: string | undefined = undefined;

      for (const line of stepBodyLines) {
          const trimmed = line.trim();
          if (!trimmed || (trimmed.startsWith('(*') && !qualRegex.test(trimmed))) {
              // Skip empty lines and pure comments
              continue;
          }
          
          const match = trimmed.match(qualRegex);
          if (match) {
              // Save previous action if any
              if (currentActionCode.length > 0) {
                  actions.push({
                      id: `act-${Date.now()}-${actions.length}`,
                      code: currentActionCode.join('\n'),
                      qualifier: currentQualifier,
                      time: currentTime
                  });
                  currentActionCode = [];
              }
              
              // Start new action with this qualifier
              currentQualifier = match[1];
              currentTime = match[2] ? match[2] : undefined;
              
              // Extract code after qualifier
              const codeAfter = trimmed.substring(match[0].length).trim().replace(/;$/, '');
              if (codeAfter) currentActionCode.push(codeAfter);
          } else {
              // Continuation of current action
              currentActionCode.push(trimmed.replace(/;$/, ''));
          }
      }
      
      // Add last action
      if (currentActionCode.length > 0) {
          actions.push({
              id: `act-${Date.now()}-${actions.length}`,
              code: currentActionCode.join('\n'),
              qualifier: currentQualifier,
              time: currentTime
          });
      }

      // Fallback: if line-bound extraction misses content (observed for some initial-step layouts),
      // use already parsed node.actions so editor always reflects the visible SFC action preview.
      if (actions.length === 0 && node.actions.length > 0) {
          node.actions.forEach((act, idx) => {
              actions.push({
                  id: `act-${Date.now()}-${idx}`,
                  code: act.text || '',
                  qualifier: act.qualifier || 'N',
                  time: act.time
              });
          });
      }

      // If no actions found, create a default empty action
      if (actions.length === 0) {
          actions.push({ 
              id: `act-${Date.now()}-0`, 
              code: '',
              qualifier: 'N',
              time: undefined
          });
      }

      setActionEditor({
          isOpen: true,
          nodeId: node.id,
          actions
      });
  };

  const handleEditTransition = (node: SFCNode, transIdx: number) => {
      const trans = node.transitions[transIdx];
      setEditModal({
          isOpen: true,
          title: `Edit Transition Condition`,
          content: trans.condition,
          type: 'transition',
          nodeId: node.id,
          transitionIdx: transIdx,
          priority: trans.priority,
          target: trans.target
      });
  };

  const deleteTransition = (node: SFCNode, transIdx: number) => {
      if (!window.confirm('Delete this transition? This action cannot be undone.')) return;
      
      const lines = code.split('\n');
      const trans = node.transitions[transIdx];
      
      // Remove the transition block from code
      lines.splice(trans.lineIndex, trans.blockEndIndex - trans.lineIndex + 1);
      
      setCode(lines.join('\n'));
      setIsDirty(true);
      setConsoleOutput(prev => [...prev, `> Deleted transition from ${node.id}`]);
  };

  const saveActionList = () => {
      const node = sfcNodes.find(n => n.id === actionEditor.nodeId);
      if (!node) return;

      const lines = code.split('\n');
      const transitionsText = node.transitions.map(t => t.fullText);
      
      const newActionLines: string[] = [];
      
      // Group actions by qualifier type for proper execution order
      const p1Actions = actionEditor.actions.filter(a => a.qualifier === 'P1');
      const normalActions = actionEditor.actions.filter(a => !['P1', 'P0'].includes(a.qualifier));
      const p0Actions = actionEditor.actions.filter(a => a.qualifier === 'P0');
      
      // Generate code for P1 actions (execute once on step entry)
      p1Actions.forEach((act) => {
          if (!act.code.trim()) return;
          
          const qualifierPrefix = `(* Q:P1 *)`;
          const codeLines = act.code.split('\n');
          
          // Wrap P1 code in stepTime check to execute only on first cycle(s)
          newActionLines.push(`   ${qualifierPrefix} IF stepTime < 100 THEN`);
          codeLines.forEach((codeLine) => {
              const trimmed = codeLine.trim();
              if (!trimmed) return;
              newActionLines.push(`       ${trimmed};`);
          });
          newActionLines.push(`   END_IF;`);
      });
      
      // Generate code for normal actions (N, S, R, L, D, P, DS, SL)
      normalActions.forEach((act) => {
          if (!act.code.trim()) return;
          
          // Build qualifier prefix for this action
          let qualifierPrefix = `(* Q:${act.qualifier}`;
          if (TIME_QUALIFIERS.includes(act.qualifier) && act.time) {
              const t = act.time.startsWith('T#') ? act.time : `T#${act.time}`;
              qualifierPrefix += ` T:${t}`;
          }
          qualifierPrefix += ` *)`;
          
          const codeLines = act.code.split('\n');
          codeLines.forEach((codeLine, lineIdx) => {
              const trimmed = codeLine.trim();
              if (!trimmed) return;
              
              // First line of action gets the qualifier prefix
              if (lineIdx === 0) {
                  newActionLines.push(`   ${qualifierPrefix} ${trimmed};`);
              } else {
                  // Subsequent lines are indented code without qualifier
                  newActionLines.push(`   ${trimmed};`);
              }
          });
      });
      
      // Generate code for P0 actions (execute once just before leaving step)
      // P0 executes when any transition condition is true
      if (p0Actions.length > 0 && node.transitions.length > 0) {
          // Build combined condition: any transition is about to fire
          const allTransitionConditions = node.transitions.map(t => `(${t.condition})`).join(' OR ');
          
          newActionLines.push(`   (* P0 Actions - Execute on step exit *)`);
          newActionLines.push(`   IF (${allTransitionConditions}) THEN`);
          
          p0Actions.forEach((act) => {
              if (!act.code.trim()) return;
              
              const qualifierPrefix = `(* Q:P0 *)`;
              const codeLines = act.code.split('\n');
              
              codeLines.forEach((codeLine, lineIdx) => {
                  const trimmed = codeLine.trim();
                  if (!trimmed) return;
                  
                  if (lineIdx === 0) {
                      newActionLines.push(`       ${qualifierPrefix} ${trimmed};`);
                  } else {
                      newActionLines.push(`       ${trimmed};`);
                  }
              });
          });
          
          newActionLines.push(`   END_IF;`);
      } else if (p0Actions.length > 0) {
          // If no transitions defined, P0 actions won't execute (add as comment)
          newActionLines.push(`   (* Warning: P0 actions defined but no transitions exist *)`);
      }

      const newBodyLines = [
          ...newActionLines,
          '',
          ...transitionsText
      ];

      const deleteCount = (node.stepEndLine - node.stepStartLine);
      lines.splice(node.stepStartLine + 1, deleteCount, ...newBodyLines);

      setCode(lines.join('\n'));
      setIsDirty(true);
      setActionEditor({ isOpen: false, nodeId: '', actions: [] });
  };

  // Structured Editor Helpers
  const updateAction = (id: string, code: string) => {
      setActionEditor(prev => ({
          ...prev,
          actions: prev.actions.map(a => a.id === id ? { ...a, code } : a)
      }));
  };

  const updateActionQualifier = (id: string, qualifier: string) => {
      setActionEditor(prev => ({
          ...prev,
          actions: prev.actions.map(a => a.id === id ? { ...a, qualifier, time: TIME_QUALIFIERS.includes(qualifier) ? (a.time || '') : undefined } : a)
      }));
  };

  const updateActionTime = (id: string, time: string) => {
      setActionEditor(prev => ({
          ...prev,
          actions: prev.actions.map(a => a.id === id ? { ...a, time } : a)
      }));
  };

  const openCodeEditor = (actionId: string, currentCode: string) => {
      setCodeEditorModal({
          isOpen: true,
          actionId,
          code: currentCode,
          title: 'Edit Action Code'
      });
  };

  const saveCodeFromEditor = () => {
      updateAction(codeEditorModal.actionId, codeEditorModal.code);
      setCodeEditorModal({ ...codeEditorModal, isOpen: false });
  };

  const addAction = () => {
      const newAct: EditableAction = { 
          id: `new-${Date.now()}`, 
          code: '',
          qualifier: 'N',
          time: undefined
      };
      setActionEditor(prev => ({ ...prev, actions: [...prev.actions, newAct] }));
  };

  const removeAction = (id: string) => {
      setActionEditor(prev => ({ ...prev, actions: prev.actions.filter(a => a.id !== id) }));
  };

  const moveAction = (index: number, direction: 'up' | 'down') => {
      const newActions = [...actionEditor.actions];
      if (direction === 'up' && index > 0) {
          [newActions[index], newActions[index - 1]] = [newActions[index - 1], newActions[index]];
      } else if (direction === 'down' && index < newActions.length - 1) {
          [newActions[index], newActions[index + 1]] = [newActions[index + 1], newActions[index]];
      }
      setActionEditor(prev => ({ ...prev, actions: newActions }));
  };

  const saveEdit = (newContent: string) => {
      const lines = code.split('\n');
      const node = sfcNodes.find(n => n.id === editModal.nodeId);
      
      if (!node) return;

      if (editModal.type === 'transition' && editModal.transitionIdx !== undefined) {
          const trans = node.transitions[editModal.transitionIdx];
          const blockStart = trans.lineIndex;
          const blockEnd = trans.blockEndIndex;
          const blockText = lines.slice(blockStart, blockEnd + 1).join('\n');

          let updatedBlockText = blockText.replace(/IF\s+([\s\S]*?)\s+THEN/i, `IF ${newContent} THEN`);

          const selectedTarget = editModal.target || trans.target;
          const stateVar = detectedStateVar || 'state';
          const exactAssignRe = new RegExp(`\\b${stateVar}\\s*:=\\s*STATE_\\w+\\b`);
          const genericAssignRe = /\b[A-Za-z_][A-Za-z0-9_]*\s*:=\s*STATE_\w+\b/;
          const assignment = `${stateVar} := ${selectedTarget}`;

          if (exactAssignRe.test(updatedBlockText)) {
              updatedBlockText = updatedBlockText.replace(exactAssignRe, assignment);
          } else if (genericAssignRe.test(updatedBlockText)) {
              updatedBlockText = updatedBlockText.replace(genericAssignRe, assignment);
          }

          lines.splice(blockStart, blockEnd - blockStart + 1, ...updatedBlockText.split('\n'));

          // handle priority change from modal if provided
          if (typeof editModal.priority === 'number') {
              const currentPriority = trans.priority;
              const desired = Math.max(0, Math.floor(editModal.priority));
              // If desired equals another transition's priority, show validation and don't apply here
              const conflict = node.transitions.some((t, i) => i !== editModal.transitionIdx && t.priority === desired);
              if (!conflict) {
                  // update single transition priority in-place
                  const priRe = /\(\*\s*PRI(?:ORITY)?\s*:\s*\d+\s*\*\)/i;
                  const blockStart = trans.lineIndex;
                  const blockEnd = trans.blockEndIndex;
                  const blockText = lines.slice(blockStart, blockEnd + 1).join('\n');
                  if (priRe.test(blockText)) {
                      const updatedText = lines.slice(blockStart, blockEnd + 1).join('\n');
                      const newBlock = updatedText.replace(priRe, `(* PRI: ${desired} *)`);
                      const newLines = newBlock.split('\n');
                      lines.splice(blockStart, blockEnd - blockStart + 1, ...newLines);
                  } else {
                      lines.splice(blockStart, 0, `   (* PRI: ${desired} *)`);
                  }
              } else {
                  // conflict: attempt auto-resolve by renumbering node's transitions
                  const updated = node.transitions.map((t, i) => t.priority);
                  updated[editModal.transitionIdx] = desired;
                  // auto-resolve duplicates by scanning and assigning next free number
                  const used = new Set<number>();
                  const resolved: number[] = [];
                  for (let i = 0; i < updated.length; i++) {
                      let p = updated[i];
                      if (!p || p <= 0) p = 1;
                      if (!used.has(p)) {
                          used.add(p);
                          resolved.push(p);
                      } else {
                          let candidate = Math.max(...Array.from(used)) + 1;
                          while (used.has(candidate)) candidate++;
                          used.add(candidate);
                          resolved.push(candidate);
                      }
                  }
                  setNodeTransitionPriorities(node.id, resolved);
                  setCode(lines.join('\n'));
                  setIsDirty(true);
                  setEditModal({ ...editModal, isOpen: false });
                  return;
              }
          }
      }

      setCode(lines.join('\n'));
      setIsDirty(true);
      setEditModal({ ...editModal, isOpen: false });
  };

  // --- Creation Logic ---

  const handleAddStep = () => {
      if (!newStepName) return;
      const stepName = `STATE_${newStepName.toUpperCase().replace(/\s+/g, '_')}`;
      let maxId = 0;
      const matches = code.matchAll(/STATE_\w+\s*:\s*INT\s*:=\s*(\d+)/g);
      for (const m of matches) maxId = Math.max(maxId, parseInt(m[1]));
      const newId = maxId + 1;
      let newCode = code.replace(/END_VAR/, `  ${stepName} : INT := ${newId};\nEND_VAR`);
      const lastEndIf = newCode.lastIndexOf('END_IF;');
      if (lastEndIf > 0) {
          const block = `
ELSIF ${detectedStateVar} = ${stepName} THEN
   (* Actions for ${newStepName} *)
   (* Q:N *) ;
`;
          newCode = newCode.slice(0, lastEndIf) + block + newCode.slice(lastEndIf);
          setCode(newCode);
          setIsDirty(true);
          setAddModal({ ...addModal, isOpen: false });
          setNewStepName('');
          setConsoleOutput(prev => [...prev, `> Added Step: ${stepName}`]);
      }
  };

  const handleAddTransition = () => {
      if (!addModal.sourceId || !newTransTarget) return;
      const node = sfcNodes.find(n => n.id === addModal.sourceId);
      if (!node) return;
      const lines = code.split('\n');
      const insertIdx = node.stepEndLine + 1;
      const transCode = `   IF ${newTransCond} THEN ${detectedStateVar} := ${newTransTarget}; END_IF;`;
      lines.splice(insertIdx, 0, transCode);
      setCode(lines.join('\n'));
      setIsDirty(true);
      setAddModal({ ...addModal, isOpen: false });
      setConsoleOutput(prev => [...prev, `> Added Transition: ${node.label} -> ${newTransTarget.replace('STATE_', '')}`]);
  };

  const handleOpenRetargetTransition = (node: SFCNode, transIdx: number) => {
      const trans = node.transitions[transIdx];
      if (!trans) return;
      setRetargetModal({
          isOpen: true,
          nodeId: node.id,
          transitionIdx: transIdx,
          target: trans.target
      });
  };

  const applyRetargetTransition = () => {
      if (!retargetModal.nodeId || retargetModal.transitionIdx === undefined || !retargetModal.target) return;
      const node = sfcNodes.find(n => n.id === retargetModal.nodeId);
      if (!node) return;
      const trans = node.transitions[retargetModal.transitionIdx];
      if (!trans) return;

      if (trans.target === retargetModal.target) {
          setRetargetModal({ isOpen: false, nodeId: undefined, transitionIdx: undefined, target: '' });
          return;
      }

      const lines = code.split('\n');
      const blockStart = trans.lineIndex;
      const blockEnd = trans.blockEndIndex;
      const blockText = lines.slice(blockStart, blockEnd + 1).join('\n');

      const stateVar = detectedStateVar || 'state';
      const exactAssignRe = new RegExp(`\\b${stateVar}\\s*:=\\s*STATE_\\w+\\b`);
      const genericAssignRe = /\b[A-Za-z_][A-Za-z0-9_]*\s*:=\s*STATE_\w+\b/;
      const replacement = `${stateVar} := ${retargetModal.target}`;

      let newBlockText = blockText;
      if (exactAssignRe.test(newBlockText)) {
          newBlockText = newBlockText.replace(exactAssignRe, replacement);
      } else if (genericAssignRe.test(newBlockText)) {
          newBlockText = newBlockText.replace(genericAssignRe, replacement);
      } else {
          setConsoleOutput(prev => [...prev, `> Could not update transition target for ${node.label}. Assignment pattern not found.`]);
          return;
      }

      lines.splice(blockStart, blockEnd - blockStart + 1, ...newBlockText.split('\n'));
      setCode(lines.join('\n'));
      setIsDirty(true);
      setRetargetModal({ isOpen: false, nodeId: undefined, transitionIdx: undefined, target: '' });
      setConsoleOutput(prev => [...prev, `> Updated Transition: ${node.label} -> ${retargetModal.target.replace('STATE_', '')}`]);
  };

  const handleOpenInsertStepBetween = (node: SFCNode, transIdx: number) => {
      setInsertStepModal({
          isOpen: true,
          nodeId: node.id,
          transitionIdx: transIdx,
          stepName: ''
      });
  };

  const applyInsertStepBetween = () => {
      if (!insertStepModal.nodeId || insertStepModal.transitionIdx === undefined) return;
      const raw = insertStepModal.stepName.trim();
      if (!raw) return;

      const node = sfcNodes.find(n => n.id === insertStepModal.nodeId);
      if (!node) return;
      const trans = node.transitions[insertStepModal.transitionIdx];
      if (!trans) return;

      const lines = code.split('\n');
      const originalTarget = trans.target;
      const stateVar = detectedStateVar || 'state';

      const baseName = raw.toUpperCase().replace(/\s+/g, '_').replace(/[^A-Z0-9_]/g, '');
      if (!baseName) return;
      const baseStateId = baseName.startsWith('STATE_') ? baseName : `STATE_${baseName}`;
      let newStateId = baseStateId;
      let suffix = 1;
      const existingIds = new Set(sfcNodes.map(n => n.id));
      while (existingIds.has(newStateId) || new RegExp(`\\b${newStateId}\\b`).test(code)) {
          suffix += 1;
          newStateId = `${baseStateId}_${suffix}`;
      }

      let maxId = 0;
      const matches = code.matchAll(/STATE_\w+\s*:\s*INT\s*:=\s*(\d+)/g);
      for (const m of matches) maxId = Math.max(maxId, parseInt(m[1], 10));
      const newStateValue = maxId + 1;

      const endVarIdx = lines.findIndex(l => /^\s*END_VAR;\s*$/i.test(l.trim()));
      if (endVarIdx >= 0) {
          lines.splice(endVarIdx, 0, `  ${newStateId} : INT := ${newStateValue};`);
      }

      const reparsed = parseSFC(lines.join('\n'));
      const updatedNode = reparsed.find(n => n.id === node.id);
      const updatedTrans = updatedNode?.transitions[insertStepModal.transitionIdx];
      if (!updatedNode || !updatedTrans) return;

      const blockStart = updatedTrans.lineIndex;
      const blockEnd = updatedTrans.blockEndIndex;
      const blockText = lines.slice(blockStart, blockEnd + 1).join('\n');
      const exactAssignRe = new RegExp(`\\b${stateVar}\\s*:=\\s*STATE_\\w+\\b`);
      const genericAssignRe = /\b[A-Za-z_][A-Za-z0-9_]*\s*:=\s*STATE_\w+\b/;
      const replacement = `${stateVar} := ${newStateId}`;
      let newBlockText = blockText;
      if (exactAssignRe.test(newBlockText)) {
          newBlockText = newBlockText.replace(exactAssignRe, replacement);
      } else if (genericAssignRe.test(newBlockText)) {
          newBlockText = newBlockText.replace(genericAssignRe, replacement);
      }
      lines.splice(blockStart, blockEnd - blockStart + 1, ...newBlockText.split('\n'));

      const lastEndIf = lines.map(l => l.trim().toUpperCase()).lastIndexOf('END_IF;');
      if (lastEndIf > 0) {
          const block = [
              '',
              `ELSIF ${stateVar} = ${newStateId} THEN`,
              `   (* Actions for ${newStateId.replace('STATE_', '')} *)`,
              `   (* Q:N *) ;`,
              `   IF TRUE THEN ${stateVar} := ${originalTarget}; END_IF;`
          ];
          lines.splice(lastEndIf, 0, ...block);
      }

      setCode(lines.join('\n'));
      setIsDirty(true);
      setInsertStepModal({ isOpen: false, nodeId: undefined, transitionIdx: undefined, stepName: '' });
      setConsoleOutput(prev => [...prev, `> Inserted Step: ${newStateId.replace('STATE_', '')} between ${node.label} and ${originalTarget.replace('STATE_', '')}`]);
  };

  // --- Rename / Delete / Force modal handlers ---
  const handleRenameStep = (node: SFCNode) => {
      setRenameModal({ isOpen: true, nodeId: node.id, value: node.label });
  };

  const applyRenameStep = () => {
      if (!renameModal.nodeId) return setRenameModal({ isOpen: false, nodeId: undefined, value: '' });
      const clean = renameModal.value.trim().toUpperCase().replace(/\s+/g, '_');
      const newStateId = clean.startsWith('STATE_') ? clean : `STATE_${clean}`;
      if (!/^[A-Z0-9_]+$/.test(clean)) {
          // simple inline validation — keep modal open
          return;
      }
      const node = sfcNodes.find(n => n.id === renameModal.nodeId);
      if (!node) return;
      if (newStateId === node.id) {
          setRenameModal({ isOpen: false, nodeId: undefined, value: '' });
          return;
      }
      const newCode = renameStateInCode(code, node.id, newStateId);
      setCode(newCode);
      setIsDirty(true);
      setConsoleOutput(prev => [...prev, `> Renamed ${node.id} -> ${newStateId}`]);
      setRenameModal({ isOpen: false, nodeId: undefined, value: '' });
  };

  const handleDeleteStep = (node: SFCNode) => {
      if (node.type === 'init') {
          // show small error modal instead of alert
          setConsoleOutput(prev => [...prev, `> Cannot delete initial step: ${node.label}`]);
          return;
      }
      setDeleteModal({ isOpen: true, nodeId: node.id, label: node.label });
  };

  const confirmDeleteStep = () => {
      if (!deleteModal.nodeId) return setDeleteModal({ isOpen: false, nodeId: undefined });
      const node = sfcNodes.find(n => n.id === deleteModal.nodeId);
      if (!node) return setDeleteModal({ isOpen: false, nodeId: undefined });
      const newCode = removeStateFromCode(code, node.id, detectedStateVar);
      setCode(newCode);
      setIsDirty(true);
      setConsoleOutput(prev => [...prev, `> Deleted step ${node.id}`]);
      setDeleteModal({ isOpen: false, nodeId: undefined });
  };

  const handleForceStep = (node: SFCNode) => {
      setForceModal({ isOpen: true, nodeId: node.id, label: node.label });
  };

  const confirmForceStep = () => {
      if (!forceModal.nodeId) return setForceModal({ isOpen: false, nodeId: undefined });
      const id = forceModal.nodeId;
      setForcedSteps(prev => { const next = { ...prev, [id]: !prev[id] }; setConsoleOutput(c => [...c, `> Force ${next[id] ? 'APPLIED' : 'CLEARED'}: ${forceModal.label || id}`]); return next; });
      setForceModal({ isOpen: false, nodeId: undefined });
  };

  // --- SFC Edit Helpers: rename / delete step, reorder transitions ---


  const moveTransitionInCode = (nodeId: string, idx: number, direction: 'up' | 'down') => {
      const nodes = parseSFC(code);
      const node = nodes.find(n => n.id === nodeId);
      if (!node) return;
      const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
      if (targetIdx < 0 || targetIdx >= node.transitions.length) return;
      const newCode = reorderTransitionBlocks(code, nodeId, idx, targetIdx);
      setCode(newCode);
      setIsDirty(true);
      setConsoleOutput(prev => [...prev, `> Reordered transitions for ${node.label}`]);
  };

  // Update a transition's explicit priority in the ST source (inserts or updates a `(* PRI: N *)` comment)
  const updateTransitionPriority = (nodeId: string, transIdx: number, newPriority: number) => {
      const nodes = parseSFC(code);
      const node = nodes.find(n => n.id === nodeId);
      if (!node) return;
      const trans = node.transitions[transIdx];
      if (!trans) return;

      const lines = code.split('\n');
      const start = trans.lineIndex;
      const end = trans.blockEndIndex;
      const blockLines = lines.slice(start, end + 1);
      const blockText = blockLines.join('\n');

      const priRe = /\(\*\s*PRI(?:ORITY)?\s*:\s*\d+\s*\*\)/i;
      if (priRe.test(blockText)) {
          // replace existing PRI in the block
          const newBlockText = blockText.replace(priRe, `(* PRI: ${newPriority} *)`);
          const newBlockLines = newBlockText.split('\n');
          lines.splice(start, end - start + 1, ...newBlockLines);
      } else {
          // insert PRI comment before the block start
          lines.splice(start, 0, `   (* PRI: ${newPriority} *)`);
      }

      setCode(lines.join('\n'));
      setIsDirty(true);
      setConsoleOutput(prev => [...prev, `> Set priority ${newPriority} on transition ${node.label} -> ${trans.target.replace('STATE_', '')}`]);
  };

  // Replace all transition priorities for a node in one pass (used by auto-resolve)
  const setNodeTransitionPriorities = (nodeId: string, newPriorities: number[]) => {
      const nodes = parseSFC(code);
      const node = nodes.find(n => n.id === nodeId);
      if (!node) return;
      const lines = code.split('\n');
      const start = node.stepStartLine + 1;
      const end = node.stepEndLine;
      // collect action lines (non-transition lines inside the step)
      const actionLines: string[] = [];
      let i = start;
      while (i <= end) {
          const inTransition = node.transitions.some(t => i >= t.lineIndex && i <= t.blockEndIndex);
          if (inTransition) {
              // skip the whole transition block
              const t = node.transitions.find(t => i >= t.lineIndex && i <= t.blockEndIndex) as any;
              i = (t.blockEndIndex || i) + 1;
              continue;
          }
          actionLines.push(lines[i].trim());
          i++;
      }

      const transitionsText = node.transitions.map((t, idx) => {
          // remove existing PRI comments from block text
          const blockText = t.fullText.replace(/\(\*\s*PRI(?:ORITY)?\s*:\s*\d+\s*\*\)/i, '').trim();
          const pri = newPriorities[idx];
          return `   (* PRI: ${pri} *) ${blockText}`;
      });

      const newBodyLines = [
          ...actionLines.filter(l => l !== ''),
          '',
          ...transitionsText
      ];

      // Replace the step body in the original lines array
      lines.splice(node.stepStartLine + 1, node.stepEndLine - node.stepStartLine, ...newBodyLines);
      setCode(lines.join('\n'));
      setIsDirty(true);
      setConsoleOutput(prev => [...prev, `> Reassigned priorities for ${node.label}`]);
  };

  // Normalize priorities for a step to tidy spacing (10,20,30...)
  const normalizePriorities = (nodeId: string, step = 10) => {
      const nodes = parseSFC(code);
      const node = nodes.find(n => n.id === nodeId);
      if (!node) return;
      const normalized = node.transitions.map((_, i) => (i + 1) * step);
      setNodeTransitionPriorities(nodeId, normalized);
  };

  const startEditPriority = (nodeId: string, idx: number, value: number) => {
      setEditingPriority({ nodeId, idx, value });
  };

  const applyEditPriority = (applyValue?: number) => {
      if (!editingPriority.nodeId || editingPriority.idx === undefined) return setEditingPriority({});
      const v = applyValue !== undefined ? applyValue : editingPriority.value || 0;
      updateTransitionPriority(editingPriority.nodeId, editingPriority.idx, Math.max(0, Math.floor(Number(v))));
      setEditingPriority({});
  };

  const autoFixInitialConvention = () => {
      let nextCode = code;
      const stateVar = detectedStateVar || 'state';

      // 1) Ensure initial step identifier is STATE_INITIAL
      if (!/\bSTATE_INITIAL\b/.test(nextCode)) {
          if (/\bSTATE_INIT\b/.test(nextCode)) {
              nextCode = nextCode.replace(/\bSTATE_INIT\b/g, 'STATE_INITIAL');
          } else {
              const parsed = parseSFC(nextCode);
              const detectedInit = parsed.find(n => n.type === 'init')?.id;
              if (detectedInit) {
                  const escaped = detectedInit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                  nextCode = nextCode.replace(new RegExp(`\\b${escaped}\\b`, 'g'), 'STATE_INITIAL');
              }
          }
      }

      // 2) Ensure STATE_STANDSTILL constant exists in VAR block
      if (!/\bSTATE_STANDSTILL\b/.test(nextCode)) {
          const stateConstRe = /^\s*STATE_\w+\s*:\s*INT\s*:=\s*(\d+);/gm;
          let maxStateVal = -1;
          let m: RegExpExecArray | null;
          while ((m = stateConstRe.exec(nextCode)) !== null) {
              maxStateVal = Math.max(maxStateVal, parseInt(m[1], 10));
          }
          const standstillVal = maxStateVal >= 0 ? maxStateVal + 1 : 1;

          const varBlock = /VAR([\s\S]*?)END_VAR;/m.exec(nextCode);
          if (varBlock) {
              const full = varBlock[0];
              const body = varBlock[1];
              let updatedBody: string;
              if (/\bSTATE_INITIAL\b/.test(body)) {
                  updatedBody = body.replace(/(\s*STATE_INITIAL\s*:\s*INT\s*:=\s*\d+;\s*)/m, `$1\n  STATE_STANDSTILL : INT := ${standstillVal};\n`);
              } else {
                  updatedBody = `\n  STATE_STANDSTILL : INT := ${standstillVal};\n${body}`;
              }
              nextCode = nextCode.replace(full, `VAR${updatedBody}END_VAR;`);
          }
      }

      // 3) Ensure undefined init line points to STATE_INITIAL
      const initLineRe = new RegExp(`IF\\s+${stateVar}\\s*=\\s*undefined\\s+THEN\\s+${stateVar}\\s*:=\\s*STATE_\\w+\\s*;\\s*END_IF;`, 'i');
      if (initLineRe.test(nextCode)) {
          nextCode = nextCode.replace(initLineRe, `IF ${stateVar} = undefined THEN ${stateVar} := STATE_INITIAL; END_IF;`);
      } else {
          const lines = nextCode.split('\n');
          const endVarIdx = lines.findIndex(l => /^\s*END_VAR;\s*$/i.test(l.trim()));
          if (endVarIdx >= 0) {
              lines.splice(endVarIdx + 1, 0, '', `IF ${stateVar} = undefined THEN ${stateVar} := STATE_INITIAL; END_IF;`);
              nextCode = lines.join('\n');
          }
      }

      // 4) Ensure transition from STATE_INITIAL to STATE_STANDSTILL exists
      const parsedAfter = parseSFC(nextCode);
      const initNode = parsedAfter.find(n => n.id === 'STATE_INITIAL') || parsedAfter.find(n => n.type === 'init');
      const hasInitToStandstill = !!initNode?.transitions.some(t => t.target === 'STATE_STANDSTILL');
      if (initNode && !hasInitToStandstill && initNode.stepEndLine >= initNode.stepStartLine) {
          const lines = nextCode.split('\n');
          const insertionAt = Math.max(initNode.stepStartLine + 1, initNode.stepEndLine + 1);
          lines.splice(insertionAt, 0,
              '   (* Auto-fix: INITIAL -> STANDSTILL *)',
              `   IF TRUE THEN`,
              `      ${stateVar} := STATE_STANDSTILL;`,
              '   END_IF;'
          );
          nextCode = lines.join('\n');
      }

      if (nextCode !== code) {
          setCode(nextCode);
          setIsDirty(true);
          setConsoleOutput(prev => [...prev, '> Auto-fix applied: INITIAL naming and INITIAL->STANDSTILL transition enforced.']);
      } else {
          setConsoleOutput(prev => [...prev, '> Auto-fix: No changes needed.']);
      }
  };

  const isActiveDebugTarget = debugState.activeDeviceId === selectedDeviceId;
  const showDebugLine = debugState.isPaused && isActiveDebugTarget;
  
  const activeSFCStepId = useMemo(() => {
      if (!isActiveDebugTarget && !debugState.isRunning) return null;
      const stateVal = debugState.variables[detectedStateVar];
      if (stateVal === undefined) return null;
      const lines = code.split('\n');
      for (const line of lines) {
          const match = line.match(/^\s*(STATE_\w+)\s*:\s*INT\s*:=\s*(\d+);/);
          if (match && parseInt(match[2]) === stateVal) {
              return match[1];
          }
      }
      return null;
  }, [debugState.variables, code, isActiveDebugTarget, debugState.isRunning]);

  // Auto-scroll to active state in SFC view
  useEffect(() => {
      if (viewMode === 'sfc' && activeSFCStepId && sfcContainerRef.current) {
          const activeNodeElement = sfcNodeRefs.current.get(activeSFCStepId);
          if (activeNodeElement) {
              // Scroll the active node into view, centered
              activeNodeElement.scrollIntoView({
                  behavior: 'smooth',
                  block: 'center',
                  inline: 'center'
              });
          }
      }
  }, [viewMode, activeSFCStepId]);

  const lineCount = code.split('\n').length;
  const lines = Array.from({ length: lineCount }, (_, i) => i + 1);
  const breakpointDetails = debugState.breakpointDetails || debugState.breakpoints.map((line) => ({ line, enabled: true, hits: 0 }));
  const executionHistory = debugState.executionHistory || [];
  const callStack = debugState.callStack || [];

  const exportDebugSession = () => {
      const payload = {
          exportedAt: new Date().toISOString(),
          deviceId: selectedDeviceId,
          debugState,
          watchExpressions,
          codeSnapshot: code
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `debug-session-${selectedDeviceId}-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setConsoleOutput(prev => [...prev, '> Debug session exported.']);
  };

  const copyVariablesToClipboard = async () => {
      try {
          await navigator.clipboard.writeText(JSON.stringify(debugState.variables, null, 2));
          setConsoleOutput(prev => [...prev, '> Variables copied to clipboard.']);
      } catch {
          setConsoleOutput(prev => [...prev, '> Error: Clipboard copy failed.']);
      }
  };

  const parseForcedDebugValue = (raw: string): any => {
      const trimmed = raw.trim();
      if (trimmed === 'true') return true;
      if (trimmed === 'false') return false;
      if (trimmed === 'null') return null;
      if (trimmed === 'undefined') return undefined;
      if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
          return trimmed.slice(1, -1);
      }
      const asNumber = Number(trimmed);
      if (trimmed !== '' && Number.isFinite(asNumber)) return asNumber;
      return raw;
  };

  const applyForcedVariableValue = () => {
      if (!editingDebugVar) return;
      if (!(debugState.isPaused && isActiveDebugTarget)) {
          setConsoleOutput(prev => [...prev, '> Variable forcing is locked. Pause active device to edit values.']);
          setEditingDebugVar(null);
          return;
      }
      const parsed = parseForcedDebugValue(editingDebugVar.value);
      const ok = engine.setDebugVariable(selectedDeviceId, editingDebugVar.name, parsed);
      if (ok) {
          setConsoleOutput(prev => [...prev, `> Forced ${editingDebugVar.name} = ${String(parsed)}`]);
      } else {
          setConsoleOutput(prev => [...prev, `> Error: Unable to force ${editingDebugVar.name}`]);
      }
      setEditingDebugVar(null);
  };

  // Helper for qualifier colors
  const getQualColor = (q: string) => {
      switch(q) {
          case 'N': return 'text-scada-muted';
          case 'S': return 'text-scada-success font-bold';
          case 'R': return 'text-scada-danger font-bold';
          case 'L': return 'text-blue-400 font-bold';
          case 'D': return 'text-purple-400 font-bold';
          case 'P': return 'text-yellow-400 font-bold';
          case 'P1': return 'text-orange-400 font-bold';
          case 'P0': return 'text-pink-400 font-bold';
          case 'DS': return 'text-indigo-400 font-bold';
          case 'SL': return 'text-cyan-400 font-bold';
          default: return 'text-scada-muted';
      }
  };

  return (
    <div className="h-full flex flex-col bg-scada-bg animate-in fade-in duration-300 relative">
       {/* Header - Unchanged */}
      <div className="h-16 border-b border-scada-border bg-scada-panel/50 flex justify-between items-center px-4 shrink-0 gap-4">
          <div className="flex items-center gap-4 flex-1">
             <div className="flex items-center gap-2 text-purple-400">
                <Icons.Code className="w-5 h-5" />
                <span className="font-semibold text-gray-200 hidden md:inline">Logic Editor</span>
             </div>
             <div className="relative group">
                 <select 
                    value={selectedDeviceId}
                    onChange={handleDeviceSelect}
                    className="bg-scada-bg border border-scada-border rounded pl-3 pr-8 py-1.5 text-sm text-white focus:border-scada-accent outline-none appearance-none min-w-[200px]"
                 >
                     {ieds.map(ied => (
                         <option key={ied.id} value={ied.id}>{ied.name} ({ied.type})</option>
                     ))}
                 </select>
                 <Icons.ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-scada-muted pointer-events-none" />
             </div>

             <div className="flex bg-scada-bg rounded p-0.5 border border-scada-border">
                 <button 
                    onClick={() => setViewMode('code')}
                    className={`px-3 py-1 text-xs font-bold rounded flex items-center gap-2 ${viewMode === 'code' ? 'bg-scada-panel text-white shadow' : 'text-scada-muted hover:text-white'}`}
                 >
                     <Icons.File className="w-3 h-3" /> ST Code
                 </button>
                 <button 
                    onClick={() => setViewMode('sfc')}
                    className={`px-3 py-1 text-xs font-bold rounded flex items-center gap-2 ${viewMode === 'sfc' ? 'bg-scada-panel text-white shadow' : 'text-scada-muted hover:text-white'}`}
                 >
                     <Icons.SFC className="w-3 h-3" /> SFC Diagram
                 </button>
             </div>
             
             {viewMode === 'sfc' && (
                 <button 
                    onClick={() => setAddModal({ isOpen: true, type: 'step' })}
                    className="flex items-center gap-2 px-3 py-1.5 bg-scada-accent/10 hover:bg-scada-accent/20 border border-scada-accent/30 text-scada-accent rounded text-sm transition-colors ml-4"
                 >
                     <Icons.Box className="w-4 h-4" /> Add Step
                 </button>
             )}

             {draftMeta.restored && (
                 <div className="ml-2 px-2 py-1 rounded border border-yellow-500/40 bg-yellow-500/10 text-yellow-400 text-[11px] font-bold whitespace-nowrap" title={draftSavedAtLabel ? `Draft saved at ${draftSavedAtLabel}` : 'Draft restored'}>
                     Draft Restored{draftSavedAtLabel ? ` • ${draftSavedAtLabel}` : ''}
                 </div>
             )}

             <div className="flex items-center gap-2 bg-scada-bg border border-scada-border rounded px-2 py-1.5 ml-auto md:ml-0" title="Execution Cycle Time">
                 <Icons.Refresh className="w-3 h-3 text-scada-muted" />
                 <input 
                    type="number" min="10" max="10000" 
                    value={tickRate} onChange={handleTickRateChange}
                    className="w-12 bg-transparent text-sm text-right outline-none text-white font-mono"
                 />
                 <span className="text-xs text-scada-muted">ms</span>
             </div>
          </div>
          
          <div className="flex gap-2 shrink-0">
               <button 
                  onClick={() => setShowDebugPanel(!showDebugPanel)}
                  className={`flex items-center gap-2 px-3 py-1.5 border rounded text-sm transition-colors ${showDebugPanel ? 'bg-scada-accent/20 text-scada-accent border-scada-accent/50' : 'bg-transparent hover:bg-white/5 border-transparent hover:border-scada-border text-scada-muted'}`}
                  title="Toggle Debug Panel"
               >
                  <Icons.Bug className="w-4 h-4" />
                  <span className="hidden sm:inline">Debug</span>
               </button>
               <button 
                  onClick={() => setShowHelp(true)}
                  className="flex items-center gap-2 px-3 py-1.5 bg-transparent hover:bg-white/5 border border-transparent hover:border-scada-border rounded text-sm transition-colors text-scada-accent"
               >
                  <Icons.Help className="w-4 h-4" />
                  <span className="hidden sm:inline">Help</span>
               </button>
               <div className="w-px h-6 bg-scada-border mx-1"></div>
                    <button
                        onClick={undoCodeChange}
                        disabled={historyDepth.undo === 0}
                        title="Undo (Ctrl/Cmd+Z)"
                        className={`px-2.5 py-1.5 border rounded text-xs font-bold transition-colors ${historyDepth.undo > 0 ? 'bg-scada-bg border-scada-border text-white hover:bg-white/10' : 'bg-transparent border-transparent text-scada-muted opacity-50 cursor-default'}`}
                    >
                        Undo
                    </button>
                    <button
                        onClick={redoCodeChange}
                        disabled={historyDepth.redo === 0}
                        title="Redo (Ctrl/Cmd+Shift+Z / Ctrl+Y)"
                        className={`px-2.5 py-1.5 border rounded text-xs font-bold transition-colors ${historyDepth.redo > 0 ? 'bg-scada-bg border-scada-border text-white hover:bg-white/10' : 'bg-transparent border-transparent text-scada-muted opacity-50 cursor-default'}`}
                    >
                        Redo
                    </button>
                    <button
                        onClick={discardDraft}
                        disabled={!draftMeta.hasDraft}
                        title="Discard local draft and restore last saved logic"
                        className={`px-2.5 py-1.5 border rounded text-xs font-bold transition-colors ${draftMeta.hasDraft ? 'bg-scada-bg border-scada-border text-scada-warning hover:bg-white/10' : 'bg-transparent border-transparent text-scada-muted opacity-50 cursor-default'}`}
                    >
                        Discard Draft
                    </button>
                    <div className="w-px h-6 bg-scada-border mx-1"></div>
               <button 
                  onClick={handleSave}
                  disabled={!isDirty}
                  className={`flex items-center gap-2 px-3 py-1.5 border rounded text-sm transition-colors font-medium ${isDirty ? 'bg-scada-accent/10 text-scada-accent border-scada-accent/50 hover:bg-scada-accent/20' : 'bg-transparent text-scada-muted border-transparent opacity-50 cursor-default'}`}
              >
                  <Icons.Save className="w-4 h-4" /> <span className="hidden sm:inline">Save</span>
              </button>
              <div className="w-px h-6 bg-scada-border mx-1"></div>
              {!debugState.isRunning ? (
                <button onClick={handleRun} disabled={isCompiling} className="flex items-center gap-2 px-4 py-1.5 bg-scada-success/10 text-scada-success hover:bg-scada-success/20 border border-scada-success/50 rounded text-sm transition-colors font-medium">
                    {isCompiling ? <Icons.Activity className="w-4 h-4 animate-spin" /> : <Icons.Run className="w-4 h-4" />} {isCompiling ? 'Compiling...' : 'Run All'}
                </button>
              ) : (
                <>
                   {debugState.isPaused ? (
                       <>
                           <button onClick={() => engine.resume()} className="flex items-center gap-2 px-3 py-1.5 bg-scada-accent/10 text-scada-accent border border-scada-accent/50 rounded text-sm hover:bg-scada-accent/20"><Icons.Play className="w-4 h-4" /></button>
                           <button onClick={() => engine.stepOver()} disabled={!isActiveDebugTarget} className="flex items-center gap-2 px-3 py-1.5 bg-scada-panel border border-scada-border rounded text-sm hover:bg-white/10 text-white disabled:opacity-50"><Icons.ChevronRight className="w-4 h-4" /></button>
                       </>
                   ) : (
                       <button onClick={() => engine.pause(selectedDeviceId)} className="flex items-center gap-2 px-3 py-1.5 bg-yellow-500/10 text-yellow-500 border border-yellow-500/50 rounded text-sm hover:bg-yellow-500/20"><Icons.Pause className="w-4 h-4" /></button>
                   )}
                   <div className="w-px h-6 bg-scada-border mx-1"></div>
                   <button onClick={handleStop} className="flex items-center gap-2 px-4 py-1.5 bg-scada-danger/10 text-scada-danger hover:bg-scada-danger/20 border border-scada-danger/50 rounded text-sm transition-colors font-medium"><Icons.Stop className="w-4 h-4" /> Stop</button>
                </>
              )}
          </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
          
          {/* Main Content Area (Dual View) */}
          <div className="flex-1 bg-[#0d1117] relative flex border-r border-scada-border overflow-hidden transition-all">
              
              {viewMode === 'code' ? (
                  <>
                    {/* Text Code Editor View */}
                    <div ref={lineContainerRef} className="w-12 bg-scada-bg border-r border-scada-border/50 text-right text-scada-muted text-sm font-mono pt-4 pb-4 select-none overflow-hidden shrink-0">
                        {lines.map(line => {
                            const hasBreakpoint = debugState.breakpoints.includes(line) && isActiveDebugTarget;
                            const isCurrent = showDebugLine && debugState.currentLine === line;
                            return (
                                <div key={line} onClick={() => toggleBreakpoint(line)} className={`h-6 pr-2 cursor-pointer hover:bg-white/5 relative flex items-center justify-end ${isCurrent ? 'bg-yellow-500/20 text-yellow-500 font-bold' : ''}`}>
                                    {hasBreakpoint && <div className="absolute left-1.5 w-2.5 h-2.5 rounded-full bg-red-500 shadow-sm" />}
                                    {isCurrent && <Icons.ChevronRight className="absolute left-0 w-3 h-3 text-yellow-500" />}
                                    {line}
                                </div>
                            );
                        })}
                    </div>
                    <div className="flex-1 relative overflow-hidden">
                        <textarea 
                            ref={editorRef} value={code} onChange={handleCodeChange} onScroll={handleScroll}
                            className="absolute inset-0 w-full h-full bg-transparent text-gray-300 font-mono text-sm p-4 pt-4 pl-2 resize-none outline-none leading-[1.5rem]"
                            spellCheck={false} style={{ lineHeight: '1.5rem' }} 
                        />
                        {showDebugLine && debugState.currentLine > 0 && (
                            <div className="absolute left-0 right-0 bg-yellow-500/10 pointer-events-none border-t border-b border-yellow-500/20" style={{ top: `${(debugState.currentLine - 1) * 1.5 + 1}rem`, height: '1.5rem' }} />
                        )}
                    </div>
                  </>
              ) : (
                  // SFC View
                  <div className="absolute inset-0 overflow-hidden flex flex-col bg-[#1e1e1e]">
                      {/* SFC Toolbar */}
                      <div className="h-10 bg-scada-panel border-b border-scada-border flex items-center px-4 gap-4 z-10 shadow-md">
                          <div className="flex items-center gap-2">
                              <button onClick={() => setZoomLevel(z => Math.max(25, z - 25))} className="p-1 hover:bg-white/10 rounded text-scada-muted"><Icons.ChevronDown className="w-4 h-4" /></button>
                              <select value={zoomLevel} onChange={(e) => setZoomLevel(parseInt(e.target.value || '100'))} className="bg-scada-bg border border-scada-border rounded p-1 text-xs font-mono w-20 text-center text-white">
                                  <option value={25}>25%</option>
                                  <option value={50}>50%</option>
                                  <option value={75}>75%</option>
                                  <option value={100}>100%</option>
                                  <option value={150}>150%</option>
                                  <option value={200}>200%</option>
                              </select>
                              <button onClick={() => setZoomLevel(z => Math.min(200, z + 25))} className="p-1 hover:bg-white/10 rounded text-scada-muted"><Icons.ChevronRight className="w-4 h-4 -rotate-90" /></button>
                              <label className="ml-3 text-xs text-scada-muted flex items-center gap-2">Normalize step
                                  <select aria-label="normalize-step-size" value={normalizeStepSize} onChange={e => setNormalizeStepSize(parseInt(e.target.value || '10', 10))} className="ml-2 bg-[#0d1117] border border-scada-border rounded p-1 text-xs">
                                      <option value={1}>1</option>
                                      <option value={5}>5</option>
                                      <option value={10}>10</option>
                                      <option value={20}>20</option>
                                      <option value={50}>50</option>
                                  </select>
                              </label>
                              <button onClick={() => exportPLCopenXML(sfcNodes)} title="Export PLCopen TC6 XML" className="ml-3 px-2 py-1 bg-scada-bg border border-scada-border rounded text-xs text-scada-muted hover:text-white">Export XML</button>
                              <button onClick={() => setFindReplaceOpen(true)} title="Find / Replace" className="px-2 py-1 bg-scada-bg border border-scada-border rounded text-xs text-scada-muted hover:text-white">Find/Replace</button>
                          </div>
                          <div className="h-4 w-px bg-scada-border" />
                          <div className="text-xs text-scada-muted flex items-center gap-2">
                              <span className="w-2 h-2 rounded-full bg-scada-success" /> Active
                              <span className="w-2 h-2 rounded-full bg-scada-panel border border-scada-border ml-2" /> Inactive
                          </div>
                          <div className="ml-auto text-xs text-scada-muted italic">Click Action Block to Configure</div>
                      </div>

                      <div ref={sfcContainerRef} className="flex-1 overflow-auto p-8 relative flex flex-col items-center" onClick={() => { setSelectedTransition({}); closeTransitionContextMenu(); }}>
                          {sfcNodes.length === 0 ? (
                              <div className="text-scada-muted flex flex-col items-center mt-20 opacity-50">
                                  <Icons.SFC className="w-16 h-16 mb-4" />
                                  <p>No compatible State Machine detected.</p>
                                  <p className="text-xs mt-2">Use STATE_X constants and IF state = STATE_X syntax.</p>
                              </div>
                          ) : (
                              <div className="space-y-8 origin-top transition-transform duration-200" style={{ transform: `scale(${zoomLevel / 100})` }}>
                                  {sfcNodes.map((node, index) => {
                                      const isActive = activeSFCStepId === node.id;
                                      const nodeHasError = diagnostics.some(d => d.nodes?.includes(node.id) && d.severity === 'error');
                                      const nodeHasWarning = diagnostics.some(d => d.nodes?.includes(node.id) && d.severity === 'warning');
                                      const isForced = !!forcedSteps[node.id];
                                      const activationCount = (() => { const v = resolveStateValue(code, node.id); if (v === undefined) return 0; return transitionTrace.filter(t => t.to === v && t.deviceId === selectedDeviceId).length; })();
                                      const lastActivationAge = (() => { const v = resolveStateValue(code, node.id); if (v === undefined) return null; const entry = transitionTrace.find(t => t.to === v && t.deviceId === selectedDeviceId); return entry ? Date.now() - entry.timestamp : null; })();
                                      return (
                                          <div 
                                              key={node.id} 
                                              ref={(el) => {
                                                  if (el) {
                                                      sfcNodeRefs.current.set(node.id, el);
                                                  } else {
                                                      sfcNodeRefs.current.delete(node.id);
                                                  }
                                              }}
                                              className="relative flex flex-col items-center group"
                                          >
                                              
                                              <div className="flex items-center gap-4">
                                                  {/* Step Box (enhanced) */}
                                                  <div className={`w-40 h-20 flex flex-col items-center justify-center font-bold text-sm shadow-xl transition-all duration-300 relative z-10
                                                      ${isActive ? 'bg-scada-success/20 border-scada-success text-white shadow-[0_0_20px_rgba(16,185,129,0.18)]' : 'bg-scada-panel text-gray-300'}
                                                      ${nodeHasError ? 'border-scada-danger' : nodeHasWarning ? 'border-scada-warning' : 'border-scada-border'}
                                                      ${node.type === 'init' ? 'border-4 border-double border-scada-accent' : 'border-2 border-scada-border'}`}>
                                                      <div className="text-center">
                                                          <div className="text-[9px] uppercase text-scada-muted mb-1 flex items-center gap-2 justify-center">
                                                              {node.type === 'init' ? <span className="px-2 py-0.5 rounded bg-black/20 border border-scada-accent text-scada-accent">INITIAL</span> : <span className="text-scada-muted">STEP {index}</span>}
                                                              {isForced && <span className="ml-1 text-[9px] px-1 rounded bg-scada-warning/20 text-scada-warning">FORCED</span>}
                                                          </div>
                                                          <div className="truncate max-w-[120px]">{node.label}</div>
                                                      </div>

                                                      {/* Indicators: _X (active), _T (elapsed), _N (count) */}
                                                      <div className="absolute -left-28 top-1/2 -translate-y-1/2 flex flex-col gap-1 text-[10px] items-end">
                                                          <div className={`px-1 rounded ${isActive ? 'bg-scada-success text-black' : 'bg-scada-bg/80 text-scada-muted'}`}>{node.label}_X</div>
                                                          <div className="px-1 rounded bg-scada-bg/80 text-scada-muted whitespace-nowrap">{node.label}_T: {formatElapsed(lastActivationAge)}</div>
                                                          <div className="px-1 rounded bg-scada-bg/80 text-scada-muted whitespace-nowrap">{node.label}_N: {activationCount}</div>
                                                      </div>

                                                      {/* Rename / Delete / Force controls */}
                                                      <div className="absolute top-1 right-1 flex items-center gap-1">
                                                          <button title="Rename step" onClick={() => handleRenameStep(node)} className="p-1 rounded text-[10px] bg-transparent hover:bg-white/5 text-scada-muted">
                                                              <Icons.File className="w-3 h-3" />
                                                          </button>
                                                          <button title="Delete step" onClick={() => handleDeleteStep(node)} className="p-1 rounded text-[10px] bg-transparent hover:bg-white/5 text-scada-danger">
                                                              <Icons.Trash className="w-3 h-3" />
                                                          </button>
                                                          <button title="Force step (UI-only)" onClick={() => handleForceStep(node)} className={`p-1 rounded text-[10px] ${isForced ? 'bg-scada-warning text-black' : 'bg-transparent text-scada-muted hover:bg-white/5'}`}>
                                                              {isForced ? 'F' : 'f'}
                                                          </button>
                                                      </div>

                                                      {isActive && <div className="absolute -right-1.5 top-1.5 w-2 h-2 bg-scada-accent rounded-full animate-ping" />}
                                                  </div>

                                                  {/* Action Block (Compact View) */}
                                                  {node.actions.length > 0 ? (
                                                      <div className="relative group/action">
                                                          <div className="w-8 h-0.5 bg-scada-border absolute right-full top-1/2 -translate-y-1/2" />
                                                          <div 
                                                            onClick={() => handleEditAction(node)}
                                                            className={`
                                                              w-48 bg-scada-bg border rounded text-[10px] font-mono shadow-md text-left transition-colors cursor-pointer hover:border-scada-accent
                                                              ${isActive ? 'border-scada-accent/50' : 'border-scada-border'}
                                                          `}>
                                                              {/* Header */}
                                                              <div className="bg-scada-panel border-b border-scada-border/50 px-2 py-1 flex justify-between items-center">
                                                                  <span className="text-[9px] font-bold text-scada-muted uppercase">Actions ({node.actions.length})</span>
                                                                  <Icons.Settings className="w-3 h-3 text-scada-muted" />
                                                              </div>
                                                              {/* List (Truncated) */}
                                                              <div className="p-1">
                                                                  {node.actions.slice(0, 3).map((act, i) => (
                                                                      <div key={i} className="flex items-center gap-2 py-0.5 px-1 rounded hover:bg-white/5">
                                                                          <span className={`font-bold w-4 text-center ${getQualColor(act.qualifier)}`}>{act.qualifier}</span>
                                                                          <span className="text-gray-400 truncate flex-1">{act.text || '...'}</span>
                                                                      </div>
                                                                  ))}
                                                                  {node.actions.length > 3 && (
                                                                      <div className="text-center text-[9px] text-scada-muted italic py-0.5">
                                                                          + {node.actions.length - 3} more...
                                                                      </div>
                                                                  )}
                                                              </div>
                                                          </div>
                                                      </div>
                                                  ) : (
                                                      <div className="relative group/action" onClick={() => handleEditAction(node)}>
                                                          <div className="w-8 h-0.5 bg-scada-border absolute right-full top-1/2 -translate-y-1/2" />
                                                          <div className="w-24 h-8 border border-dashed border-scada-border rounded flex items-center justify-center text-[9px] text-scada-muted cursor-pointer hover:border-scada-accent hover:text-white transition-colors bg-scada-bg/50">
                                                              + Actions
                                                          </div>
                                                      </div>
                                                  )}
                                              </div>

                                              {/* Transitions */}
                                              {node.transitions.length > 0 && (
                                                  <div className="flex flex-col items-center w-full mt-4 space-y-2">
                                                      {node.transitions.map((trans, idx) => {
                                                          const isSelectedTransition = selectedTransition.nodeId === node.id && selectedTransition.idx === idx;
                                                          return (
                                                          <div key={idx} className="flex flex-col items-center w-full group relative">
                                                              <div className="w-0.5 h-6 bg-scada-border" />
                                                              <div
                                                                  className={`w-24 h-1.5 relative flex items-center justify-center cursor-pointer transition-colors z-20 group/trans ${isSelectedTransition ? 'bg-yellow-400 shadow-[0_0_0_1px_rgba(250,204,21,0.9)]' : 'bg-gray-500 hover:bg-yellow-500'}`}
                                                                  onClick={(e) => { e.stopPropagation(); setSelectedTransition({ nodeId: node.id, idx }); handleEditTransition(node, idx); }}
                                                                  onContextMenu={(e) => openTransitionContextMenu(e, node.id, idx)}
                                                                  title="Click to edit condition"
                                                              >
                                                                  {node.transitions.length > 1 && (
                                                                      <div className="absolute -left-14 flex flex-col items-center space-y-1 text-[10px] font-bold text-yellow-500">
                                                                          <button onClick={() => moveTransitionInCode(node.id, idx, 'up')} className="p-0.5 rounded bg-transparent hover:bg-white/5 text-scada-muted"><Icons.ChevronDown className="w-3 h-3 rotate-180" /></button>
                                                                          {/* priority display / inline editor */}
                                                                          {editingPriority.nodeId === node.id && editingPriority.idx === idx ? (
                                                                              <div className="flex flex-col items-center">
                                                                                  <input
                                                                                      type="number"
                                                                                      aria-label={`edit-priority-${node.id}-${idx}`}
                                                                                      value={editingPriority.value}
                                                                                      onChange={(e) => setEditingPriority(p => ({ ...p, value: parseInt(e.target.value || '0', 10) }))}
                                                                                      onBlur={() => applyEditPriority()}
                                                                                      onKeyDown={(e) => { if (e.key === 'Enter') applyEditPriority(); if (e.key === 'Escape') setEditingPriority({}); }}
                                                                                      className="w-12 bg-[#0d1117] border border-scada-border rounded p-1 text-xs text-center"
                                                                                  />
                                                                                  {/* conflict detection */}
                                                                                  {(() => {
                                                                                      const conflict = editingPriority.nodeId === node.id && editingPriority.idx === idx && sfcNodes.find(n => n.id === node.id)?.transitions.some((t, i2) => i2 !== idx && t.priority === (editingPriority.value || 0));
                                                                                      if (conflict) {
                                                                                          return (
                                                                                              <div className="text-[10px] text-yellow-400 mt-1">
                                                                                                  Duplicate priority — <button onClick={() => applyEditPriority(undefined /*auto-resolve*/)} className="underline">Auto-resolve</button>
                                                                                              </div>
                                                                                          );
                                                                                      }
                                                                                      return null;
                                                                                  })()}
                                                                              </div>
                                                                          ) : (
                                                                              <button onClick={() => startEditPriority(node.id, idx, trans.priority)} className="px-1 py-0.5 rounded hover:bg-white/5">[{trans.priority}]</button>
                                                                          )}
                                                                          <button onClick={() => moveTransitionInCode(node.id, idx, 'down')} className="p-0.5 rounded bg-transparent hover:bg-white/5 text-scada-muted"><Icons.ChevronDown className="w-3 h-3" /></button>
                                                                      </div>
                                                                  )}
                                                                  <div className="absolute left-full ml-3 top-1/2 -translate-y-1/2 bg-scada-bg border border-scada-border p-1.5 rounded shadow-lg min-w-[150px] max-w-[250px] z-50 transition-colors group-hover/trans:border-yellow-500">
                                                                      <div className="text-[9px] text-scada-muted uppercase font-bold flex justify-between items-center">
                                                                          <span>Transition Condition</span>
                                                                          <div className="flex gap-1">
                                                                              <Icons.Code className="w-3 h-3 text-yellow-500 opacity-0 group-hover/trans:opacity-100" />
                                                                              <button
                                                                                  onClick={(e) => { e.stopPropagation(); handleOpenInsertStepBetween(node, idx); }}
                                                                                  className="opacity-0 group-hover/trans:opacity-100 text-scada-accent hover:text-cyan-300 transition-opacity"
                                                                                  title="Insert step between source and target"
                                                                              >
                                                                                  <Icons.Box className="w-3 h-3" />
                                                                              </button>
                                                                              <button 
                                                                                  onClick={(e) => { e.stopPropagation(); deleteTransition(node, idx); }} 
                                                                                  className="opacity-0 group-hover/trans:opacity-100 text-scada-danger hover:text-red-500 transition-opacity"
                                                                                  title="Delete Transition"
                                                                              >
                                                                                  <Icons.Trash className="w-3 h-3" />
                                                                              </button>
                                                                          </div>
                                                                      </div>
                                                                      <div className="text-[10px] font-mono text-yellow-400 break-words">{trans.condition}</div>
                                                                  </div>
                                                              </div>
                                                              <div className="w-0.5 h-6 bg-scada-border relative">
                                                                   <Icons.ChevronDown className="absolute -bottom-2 -left-1.5 w-4 h-4 text-scada-muted" />
                                                              </div>
                                                              <div
                                                                  className={`mt-1 px-2 py-0.5 rounded border bg-scada-panel text-[10px] text-scada-text flex items-center gap-1 hover:text-white transition-colors cursor-pointer hover:border-scada-accent ${isSelectedTransition ? 'border-yellow-500/80' : 'border-scada-border'}`}
                                                                  onClick={(e) => { e.stopPropagation(); setSelectedTransition({ nodeId: node.id, idx }); handleOpenRetargetTransition(node, idx); }}
                                                                  onContextMenu={(e) => openTransitionContextMenu(e, node.id, idx)}
                                                                  title="Click to change target step"
                                                              >
                                                                  <Icons.ArrowDownLeft className="w-3 h-3 text-scada-muted" />
                                                                  <span>{trans.target.replace('STATE_', '')}</span>
                                                              </div>
                                                          </div>
                                                      )})}
                                                      
                                                      {/* Normalize + Add Another Transition Button (Branching) */}
                                                      <div className="mt-2 flex items-center gap-2">
                                                          <button onClick={() => normalizePriorities(node.id, normalizeStepSize)} className="px-2 py-1 text-xs bg-scada-bg border border-scada-border rounded text-scada-muted hover:text-white" title="Normalize priorities">Normalize</button>
                                                          <button 
                                                              onClick={() => setAddModal({isOpen: true, type: 'transition', sourceId: node.id})}
                                                              className="w-6 h-6 rounded-full bg-scada-bg border border-scada-border flex items-center justify-center text-scada-muted hover:text-white hover:border-scada-accent transition-colors text-xs"
                                                              title="Add Parallel Branch / Divergence"
                                                          >
                                                              +
                                                          </button>
                                                      </div>
                                                  </div>
                                              )}

                                              {/* Empty Transition Placeholder */}
                                              {node.transitions.length === 0 && (
                                                  <div className="flex flex-col items-center mt-2">
                                                      <div className="w-0.5 h-8 border-l-2 border-dashed border-scada-border" />
                                                      <button 
                                                          onClick={() => setAddModal({isOpen: true, type: 'transition', sourceId: node.id})}
                                                          className="px-3 py-1 bg-scada-bg border border-dashed border-scada-border rounded text-[10px] text-scada-muted hover:text-white hover:border-scada-accent transition-colors"
                                                      >
                                                          + Add Transition
                                                      </button>
                                                  </div>
                                              )}
                                          </div>
                                      );
                                  })}
                              </div>
                          )}

                          {transitionContextMenu.isOpen && (
                              <div
                                  className="fixed z-[70] min-w-[220px] bg-scada-panel border border-scada-border rounded shadow-2xl p-1"
                                  style={{ left: transitionContextMenu.x, top: transitionContextMenu.y }}
                                  onClick={(e) => e.stopPropagation()}
                              >
                                  <button onClick={() => runTransitionAction('edit')} className="w-full text-left px-3 py-1.5 text-xs text-white hover:bg-white/10 rounded">Edit Condition <span className="text-scada-muted float-right">E</span></button>
                                  <button onClick={() => runTransitionAction('retarget')} className="w-full text-left px-3 py-1.5 text-xs text-white hover:bg-white/10 rounded">Retarget Step <span className="text-scada-muted float-right">T</span></button>
                                  <button onClick={() => runTransitionAction('insert')} className="w-full text-left px-3 py-1.5 text-xs text-white hover:bg-white/10 rounded">Insert Step Between <span className="text-scada-muted float-right">I</span></button>
                                  <button onClick={() => runTransitionAction('normalize')} className="w-full text-left px-3 py-1.5 text-xs text-white hover:bg-white/10 rounded">Normalize Priorities <span className="text-scada-muted float-right">N</span></button>
                                  <div className="h-px my-1 bg-scada-border" />
                                  <button onClick={() => runTransitionAction('delete')} className="w-full text-left px-3 py-1.5 text-xs text-scada-danger hover:bg-red-500/10 rounded">Delete Transition <span className="text-scada-muted float-right">Del</span></button>
                              </div>
                          )}
                      </div>
                  </div>
              )}
          </div>

          {/* Right Panel - Resizable */}
          <div className="bg-scada-panel flex flex-col border-l border-scada-border right-panel-container relative" style={{ width: `${rightPanelWidth}px`, minWidth: '240px', maxWidth: '720px' }}>
              <div
                  onMouseDown={handleRightPanelResizeStart}
                  className="absolute left-0 top-0 bottom-0 w-1 -translate-x-1/2 cursor-ew-resize bg-scada-border/40 hover:bg-scada-accent transition-colors z-20"
                  title="Drag to resize Variables Inspector width"
              />
              {/* Variables Inspector */}
              <div className="flex flex-col border-b border-scada-border" style={{ minHeight: '200px', maxHeight: '40vh' }}>
                  <div className="p-3 border-b border-scada-border text-xs font-bold text-scada-muted uppercase flex items-center gap-2 bg-scada-bg/50">
                      <Icons.Search className="w-3 h-3" /> Variables Inspector
                  </div>
                  <div className="flex-1 overflow-y-auto p-0">
                      {isActiveDebugTarget || (debugState.isRunning && !debugState.isPaused) ? (
                          <table className="w-full text-xs font-mono">
                              <thead className="text-scada-muted bg-white/5 text-left">
                                  <tr><th className="px-3 py-1 font-medium">Name</th><th className="px-3 py-1 font-medium">Value</th></tr>
                              </thead>
                              <tbody className="divide-y divide-scada-border/30">
                                  {Object.entries(debugState.variables).map(([key, val]) => (
                                      <tr key={key} className="hover:bg-white/5">
                                          <td className="px-3 py-1 text-purple-400">{key}</td>
                                          <td className="px-3 py-1 text-gray-200 break-all">{typeof val === 'number' ? val.toFixed(2) : String(val)}</td>
                                      </tr>
                                  ))}
                              </tbody>
                          </table>
                      ) : (
                          <div className="p-4 text-center text-scada-muted text-xs">Variables available when running or paused.</div>
                      )}
                  </div>
              </div>

              {/* SFC Diagnostics */}
              <div className="border-b border-scada-border text-xs flex-shrink-0">
                  <div className="p-3 pb-2 flex items-center justify-between cursor-pointer hover:bg-white/5 transition-colors" onClick={() => setShowDiagnostics(!showDiagnostics)}>
                      <div className="font-bold text-scada-muted uppercase flex items-center gap-2">
                          <Icons.Alert className="w-3 h-3 text-scada-warning" /> 
                          SFC Diagnostics
                      </div>
                      <div className="flex items-center gap-2">
                          {diagnostics.some(d => ['IEC-SFC-008', 'IEC-SFC-009', 'IEC-SFC-010'].includes(d.code)) && (
                              <button
                                  onClick={(e) => {
                                      e.stopPropagation();
                                      autoFixInitialConvention();
                                  }}
                                  className="px-2 py-0.5 text-[10px] rounded bg-scada-accent/15 border border-scada-accent/40 text-scada-accent hover:bg-scada-accent/25"
                                  title="Auto-fix INITIAL naming and transition convention"
                              >
                                  Auto-fix
                              </button>
                          )}
                          <div className="text-[11px] text-scada-muted">{diagnostics.length} issues</div>
                          <Icons.ChevronDown className={`w-4 h-4 text-scada-muted transition-transform ${showDiagnostics ? '' : '-rotate-90'}`} />
                      </div>
                  </div>
                  {showDiagnostics && (
                  <div className="px-3 pb-3 space-y-2 max-h-64 overflow-y-auto">
                      {diagnostics.length === 0 ? (
                          <div className="text-scada-muted text-xs">No issues detected.</div>
                      ) : (
                          diagnostics.map((d, i) => (
                              <div key={i} className={`flex items-start gap-2 p-2 rounded ${d.severity === 'error' ? 'bg-scada-danger/10 border border-scada-danger/30' : d.severity === 'warning' ? 'bg-scada-warning/10 border border-scada-warning/30' : 'bg-white/2 border border-scada-border'}`}>
                                  <div className={`w-3 h-3 rounded-full ${d.severity === 'error' ? 'bg-scada-danger' : d.severity === 'warning' ? 'bg-scada-warning' : 'bg-scada-accent'}`} />
                                  <div className="text-[11px]">
                                      <div className="font-semibold">{d.code}</div>
                                      <div className="text-scada-muted text-[11px]">{d.message}</div>
                                  </div>
                              </div>
                          ))
                      )}
                  </div>
                  )}
              </div>

              {/* Trace Buffer */}
              <div className="border-b border-scada-border text-xs flex-shrink-0">
                  <div className="p-3 pb-2 flex items-center justify-between">
                      <div className="font-bold text-scada-muted uppercase flex items-center gap-2 cursor-pointer hover:text-white transition-colors" onClick={() => setShowTrace(!showTrace)}>
                          <Icons.Clock className="w-3 h-3 text-scada-accent" /> 
                          Trace (last {transitionTrace.length})
                          <Icons.ChevronDown className={`w-4 h-4 transition-transform ${showTrace ? '' : '-rotate-90'}`} />
                      </div>
                      <div className="flex gap-2">
                          <button onClick={(e) => { e.stopPropagation(); setTransitionTrace([]); }} className="px-2 py-1 text-xs bg-scada-bg border border-scada-border rounded hover:bg-white/5">Clear</button>
                          <button onClick={(e) => { e.stopPropagation(); const blob = new Blob([JSON.stringify(transitionTrace.slice(0,1000), null, 2)], {type:'application/json'}); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `sfc-trace-${selectedDeviceId}.json`; a.click(); URL.revokeObjectURL(url); }} className="px-2 py-1 text-xs bg-scada-bg border border-scada-border rounded hover:bg-white/5">Export</button>
                      </div>
                  </div>
                  {showTrace && (
                  <div className="px-3 pb-3 max-h-48 overflow-y-auto font-mono text-[11px] text-scada-muted space-y-1">
                      {transitionTrace.length === 0 ? <div className="text-scada-muted">No trace yet.</div> : transitionTrace.slice(0,50).map((t, i) => (
                          <div key={i} className="flex justify-between items-center gap-2">
                              <div>{new Date(t.timestamp).toLocaleTimeString()} — <span className="text-white">{resolveStateNameByValue(code, t.to) || t.to}</span></div>
                              <div className="text-scada-muted text-[10px]">{t.deviceId}</div>
                          </div>
                      ))}
                  </div>
                  )}
              </div>

              {/* Console Output - Resizable */}
              <div className="flex flex-col flex-shrink-0" style={{ height: showConsole ? `${consoleHeight}px` : 'auto', minHeight: showConsole ? '100px' : '0' }}>
                  {/* Resize Handle */}
                  {showConsole && (
                  <div 
                      onMouseDown={handleConsoleResizeStart}
                      className="h-1 bg-scada-border hover:bg-scada-accent cursor-ns-resize transition-colors relative group"
                      title="Drag to resize console"
                  >
                      <div className="absolute inset-0 flex items-center justify-center">
                          <div className="w-12 h-0.5 bg-scada-muted group-hover:bg-scada-accent rounded-full transition-colors"></div>
                      </div>
                  </div>
                  )}
                  
                  <div className="p-3 border-b border-scada-border text-xs font-bold text-scada-muted uppercase flex items-center justify-between bg-scada-bg/50 cursor-pointer hover:bg-white/5 transition-colors" onClick={() => setShowConsole(!showConsole)}>
                      <div className="flex items-center gap-2">
                          <Icons.Terminal className="w-3 h-3" /> Output Console
                          <Icons.ChevronDown className={`w-4 h-4 transition-transform ${showConsole ? '' : '-rotate-90'}`} />
                      </div>
                      <div className="text-[10px] font-normal opacity-60">{consoleOutput.length} lines</div>
                  </div>
                  {showConsole && (
                  <div className="flex-1 p-3 font-mono text-xs overflow-y-auto space-y-1 bg-[#0d1117] min-h-0">
                      {consoleOutput.map((line, i) => (
                          <div key={i} className={`${line.startsWith('> Error') ? 'text-scada-danger' : 'text-scada-text'} ${line.includes('Warning') ? 'text-scada-warning' : ''}`}>{line}</div>
                      ))}
                      {isCompiling && <div className="text-scada-accent animate-pulse">_</div>}
                  </div>
                  )}
              </div>
          </div>
      </div>

      {/* Structured Action Editor Modal */}
      {actionEditor.isOpen && (
          <div className="absolute inset-0 z-50 bg-black/80 flex items-center justify-center p-8 backdrop-blur-sm animate-in fade-in">
              <div className="bg-scada-panel border border-scada-border rounded-lg shadow-2xl w-full max-w-5xl flex flex-col overflow-hidden animate-in zoom-in-95 h-[85vh]">
                  <div className="p-4 border-b border-scada-border bg-scada-bg/50 flex justify-between items-center">
                      <h3 className="font-bold text-white text-sm flex items-center gap-2">
                          <Icons.Settings className="w-4 h-4 text-scada-accent" /> Professional Script IDE — Step Actions
                      </h3>
                      <button onClick={() => setActionEditor({ ...actionEditor, isOpen: false })} className="text-scada-muted hover:text-white"><Icons.Close className="w-5 h-5" /></button>
                  </div>
                  
                  <div className="flex-1 overflow-y-auto p-4 bg-[#0d1117]">
                      {actionEditor.actions.length === 0 ? (
                          <div className="h-full flex flex-col items-center justify-center text-scada-muted opacity-50">
                              <Icons.Code className="w-12 h-12 mb-4 opacity-30" />
                              <p className="text-lg mb-2">No actions defined for this step.</p>
                              <button onClick={addAction} className="mt-4 px-6 py-3 bg-scada-accent text-white border border-scada-accent rounded hover:bg-cyan-600 transition-colors font-bold shadow-lg shadow-cyan-900/20">
                                  + Add First Action
                              </button>
                          </div>
                      ) : (
                          <div className="space-y-3">
                              {actionEditor.actions.map((act, index) => {
                                  const lineCount = act.code.split('\n').length;
                                  const preview = act.code.split('\n')[0] || '(empty)';
                                  return (
                                      <div key={act.id} className="flex gap-3 items-start bg-scada-panel border-2 border-scada-border p-4 rounded-lg group hover:border-scada-accent/50 transition-all">
                                          {/* Controls */}
                                          <div className="flex flex-col gap-2 mt-2">
                                              <button onClick={() => moveAction(index, 'up')} disabled={index === 0} className="text-scada-muted hover:text-white disabled:opacity-30 transition-colors">
                                                  <Icons.ChevronDown className="w-5 h-5 rotate-180" />
                                              </button>
                                              <button onClick={() => moveAction(index, 'down')} disabled={index === actionEditor.actions.length - 1} className="text-scada-muted hover:text-white disabled:opacity-30 transition-colors">
                                                  <Icons.ChevronDown className="w-5 h-5" />
                                              </button>
                                          </div>

                                          {/* Action Content */}
                                          <div className="flex-1 min-w-0">
                                              <div className="flex items-center gap-3 mb-3">
                                                  <span className="text-xs font-bold text-scada-muted uppercase">Action #{index + 1}</span>
                                                  <span className="text-xs text-scada-muted/60">— {lineCount} line{lineCount !== 1 ? 's' : ''}</span>
                                              </div>
                                              
                                              {/* Qualifier Configuration */}
                                              <div className="flex items-center gap-3 mb-3">
                                                  <div className="w-44">
                                                      <label className="text-xs font-bold text-scada-muted uppercase block mb-1">Qualifier</label>
                                                      <select 
                                                          value={act.qualifier}
                                                          onChange={(e) => updateActionQualifier(act.id, e.target.value)}
                                                          className={`w-full bg-scada-bg border border-scada-border rounded px-2 py-1.5 text-xs font-bold focus:border-scada-accent outline-none ${getQualColor(act.qualifier)}`}
                                                      >
                                                          {ACTION_QUALIFIERS.map(q => <option key={q} value={q}>{q} — {
                                                              q === 'N' ? 'Non-stored' :
                                                              q === 'S' ? 'Set (Stored)' :
                                                              q === 'R' ? 'Reset' :
                                                              q === 'L' ? 'Time Limited' :
                                                              q === 'D' ? 'Time Delayed' :
                                                              q === 'P' ? 'Pulse' :
                                                              q === 'P1' ? 'Pulse Rising' :
                                                              q === 'P0' ? 'Pulse Falling' :
                                                              q === 'DS' ? 'Delayed & Stored' :
                                                              q === 'SL' ? 'Stored & Limited' : ''
                                                          }</option>)}
                                                      </select>
                                                  </div>

                                                  {TIME_QUALIFIERS.includes(act.qualifier) && (
                                                      <div className="w-36 animate-in slide-in-from-left-2">
                                                          <label className="text-xs font-bold text-scada-muted uppercase block mb-1">Duration</label>
                                                          <input 
                                                              value={act.time || ''}
                                                              onChange={(e) => updateActionTime(act.id, e.target.value)}
                                                              placeholder="T#2s, T#500ms"
                                                              className="w-full bg-scada-bg border border-scada-border rounded px-2 py-1.5 text-xs text-white font-mono focus:border-scada-accent outline-none"
                                                          />
                                                      </div>
                                                  )}
                                              </div>
                                              
                                              {/* Code Preview */}
                                              <div className="bg-[#0d1117] border border-scada-border rounded p-3 mb-3 font-mono text-sm min-h-[60px]">
                                                  {act.code ? (
                                                      <div className="text-gray-300 whitespace-pre-wrap">{act.code.length > 200 ? act.code.substring(0, 200) + '...' : act.code}</div>
                                                  ) : (
                                                      <div className="text-scada-muted italic">No code — click Edit to add</div>
                                                  )}
                                              </div>
                                              
                                              {/* Edit Button */}
                                              <button 
                                                  onClick={() => openCodeEditor(act.id, act.code)}
                                                  className="w-full px-4 py-2 bg-scada-accent/20 border border-scada-accent text-scada-accent rounded hover:bg-scada-accent hover:text-white transition-all font-bold flex items-center justify-center gap-2"
                                              >
                                                  <Icons.Code className="w-4 h-4" /> Open Code Editor
                                              </button>
                                          </div>

                                          <button onClick={() => removeAction(act.id)} className="mt-2 p-2 text-scada-danger hover:bg-scada-danger/10 rounded transition-colors" title="Delete Action">
                                              <Icons.Trash className="w-5 h-5" />
                                          </button>
                                      </div>
                                  );
                              })}
                          </div>
                      )}
                  </div>

                  <div className="p-4 border-t border-scada-border bg-scada-bg/30 flex justify-between items-center">
                      <button onClick={addAction} className="px-6 py-2 bg-scada-bg border border-scada-border rounded text-sm hover:bg-white/5 text-white transition-colors flex items-center gap-2 font-bold">
                          <Icons.Box className="w-4 h-4" /> Add Action
                      </button>
                      <div className="flex gap-3">
                          <button onClick={() => setActionEditor({ ...actionEditor, isOpen: false })} className="px-6 py-2 rounded text-sm hover:bg-white/5 text-scada-muted transition-colors">Cancel</button>
                          <button onClick={saveActionList} className="px-6 py-2 bg-scada-accent text-white rounded text-sm font-bold hover:bg-cyan-600 transition-colors shadow-lg shadow-cyan-900/20">Apply & Save</button>
                      </div>
                  </div>
              </div>
          </div>
      )}

      {/* Multiline Code Editor Modal */}
      {codeEditorModal.isOpen && (
          <div className="fixed inset-0 z-[60] bg-black/90 flex items-center justify-center p-4 backdrop-blur-sm animate-in fade-in">
              <div className="bg-scada-panel border-2 border-scada-accent rounded-lg shadow-2xl w-full max-w-6xl flex flex-col overflow-hidden animate-in zoom-in-95" style={{ height: 'min(90vh, 900px)' }}>
                  <div className="p-4 border-b border-scada-border bg-scada-bg/50 flex justify-between items-center">
                      <div className="flex items-center gap-3">
                          <Icons.Code className="w-5 h-5 text-scada-accent" />
                          <h3 className="font-bold text-white text-base">{codeEditorModal.title}</h3>
                          <span className="px-3 py-1 bg-scada-accent/20 text-scada-accent text-xs font-bold rounded-full border border-scada-accent/50">
                              IEC 61131-3 Structured Text
                          </span>
                      </div>
                      <button onClick={() => setCodeEditorModal({ ...codeEditorModal, isOpen: false })} className="text-scada-muted hover:text-white transition-colors">
                          <Icons.Close className="w-6 h-6" />
                      </button>
                  </div>
                  
                  <div className="flex-1 flex overflow-hidden min-h-0">
                      {/* Code Editor with integrated line numbers */}
                      <div className="flex-1 flex overflow-hidden bg-[#0d1117]">
                          <div className="w-14 bg-scada-bg/50 border-r border-scada-border py-3 px-2 overflow-y-auto flex-shrink-0 scrollbar-thin">
                              <div className="font-mono text-xs text-right text-scada-muted select-none">
                                  {codeEditorModal.code.split('\n').map((_, idx) => (
                                      <div key={idx} style={{ lineHeight: '24px', minHeight: '24px' }}>
                                          {idx + 1}
                                      </div>
                                  ))}
                              </div>
                          </div>
                          <textarea 
                              className="flex-1 p-3 bg-transparent text-gray-300 font-mono text-sm outline-none resize-none overflow-y-auto scrollbar-thin"
                              value={codeEditorModal.code}
                              onChange={(e) => setCodeEditorModal({ ...codeEditorModal, code: e.target.value })}
                              spellCheck={false}
                              autoFocus
                              placeholder="// Write your IEC 61131-3 Structured Text code here...\n// Examples:\n// Device.WriteCoil('00001', TRUE);\n// temp := Device.ReadInput('30001') / 100.0;\n// IF temp > 50.0 THEN\n//     Device.Log('info', 'High temperature');\n// END_IF;"
                              style={{ 
                                  lineHeight: '24px',
                                  tabSize: 4,
                                  MozTabSize: 4
                              }}
                          />
                      </div>
                  </div>

                  {/* Syntax Reference */}
                  <div className="p-2 border-t border-scada-border bg-scada-bg/30 text-[11px] text-scada-muted flex-shrink-0">
                      <div className="flex items-center gap-4 flex-wrap">
                          <div><strong className="text-white">Operators:</strong> :=, =, &lt;&gt;, AND, OR</div>
                          <div><strong className="text-white">Types:</strong> BOOL, INT, REAL</div>
                          <div><strong className="text-white">Control:</strong> IF...THEN...END_IF</div>
                          <div><strong className="text-white">Special:</strong> stepTime (ms in current step)</div>
                      </div>
                  </div>

                  <div className="p-3 border-t border-scada-border bg-scada-bg/50 flex justify-between items-center flex-shrink-0">
                      <div className="text-xs text-scada-muted">
                          Lines: <span className="text-white font-bold">{codeEditorModal.code.split('\n').length}</span>
                          {' | '}
                          Characters: <span className="text-white font-bold">{codeEditorModal.code.length}</span>
                      </div>
                      <div className="flex gap-3">
                          <button onClick={() => setCodeEditorModal({ ...codeEditorModal, isOpen: false })} className="px-5 py-2 rounded text-sm hover:bg-white/5 text-scada-muted transition-colors">
                              Cancel
                          </button>
                          <button onClick={saveCodeFromEditor} className="px-5 py-2 bg-scada-accent text-white rounded text-sm font-bold hover:bg-cyan-600 transition-colors shadow-lg shadow-cyan-900/20 flex items-center gap-2">
                              <Icons.Check className="w-4 h-4" /> Save Code
                          </button>
                      </div>
                  </div>
              </div>
          </div>
      )}

      {/* Edit Modal (Still used for Transitions) */}
      {editModal.isOpen && (
          <div className="absolute inset-0 z-50 bg-black/80 flex items-center justify-center p-8 backdrop-blur-sm animate-in fade-in">
              <div className="bg-scada-panel border border-scada-border rounded-lg shadow-2xl w-full max-w-2xl flex flex-col overflow-hidden animate-in zoom-in-95">
                  <div className="p-4 border-b border-scada-border bg-scada-bg/50 flex justify-between items-center">
                      <h3 className="font-bold text-white flex items-center gap-2">
                          <Icons.Code className="w-4 h-4 text-scada-accent" /> {editModal.title}
                      </h3>
                      <button onClick={() => setEditModal({ ...editModal, isOpen: false })} className="text-scada-muted hover:text-white"><Icons.Close className="w-5 h-5" /></button>
                  </div>
                  <div className="p-4 flex-1">
                      <textarea 
                          className="w-full h-64 bg-[#0d1117] text-gray-300 font-mono text-sm p-4 rounded border border-scada-border outline-none focus:border-scada-accent resize-none"
                          value={editModal.content} onChange={(e) => setEditModal({ ...editModal, content: e.target.value })}
                          spellCheck={false} autoFocus
                      />
                      <div className="mt-2 text-xs text-scada-muted">Boolean expression (e.g., x &gt; 10 AND y &lt; 5)</div>

                      {editModal.type === 'transition' && typeof editModal.transitionIdx === 'number' && (
                          <div className="mt-3">
                              <label className="text-xs font-bold text-scada-muted uppercase block mb-1">Target Step</label>
                              <select
                                  className="w-full bg-[#0d1117] border border-scada-border rounded p-2 text-white font-mono focus:border-scada-accent outline-none"
                                  value={editModal.target || ''}
                                  onChange={(e) => setEditModal(m => ({ ...m, target: e.target.value }))}
                              >
                                  <option value="">-- Select Target --</option>
                                  {sfcNodes.map(n => <option key={n.id} value={n.id}>{n.label}</option>)}
                              </select>
                          </div>
                      )}

                      {/* Priority editor (in modal) */}
                      {editModal.type === 'transition' && typeof editModal.transitionIdx === 'number' && (
                          <div className="mt-3 flex items-center gap-3">
                              <label className="text-xs font-bold text-scada-muted uppercase">Priority</label>
                              <input
                                  aria-label="transition-priority"
                                  type="number"
                                  value={editModal.priority ?? 0}
                                  onChange={(e) => setEditModal(m => ({ ...m, priority: parseInt(e.target.value || '0', 10) }))}
                                  className="w-24 bg-[#0d1117] border border-scada-border rounded p-1 text-xs text-center"
                              />
                              {/* conflict detection */}
                              {(() => {
                                  const node = sfcNodes.find(n => n.id === editModal.nodeId);
                                  const conflict = node && typeof editModal.priority === 'number' && node.transitions.some((t, i) => i !== editModal.transitionIdx && t.priority === editModal.priority);
                                  if (conflict) {
                                      return (
                                          <div className="text-[11px] text-yellow-400">
                                              Duplicate priority for this step — <button onClick={() => {
                                                  // auto-resolve: compute new priorities and apply
                                                  const current = node!.transitions.map(t => t.priority);
                                                  current[editModal.transitionIdx!] = editModal.priority || 0;
                                                  // resolve duplicates
                                                  const used = new Set<number>();
                                                  const resolved: number[] = [];
                                                  for (let i = 0; i < current.length; i++) {
                                                      let p = current[i] || 1;
                                                      if (!used.has(p)) { used.add(p); resolved.push(p); }
                                                      else { let candidate = Math.max(...Array.from(used)) + 1; while (used.has(candidate)) candidate++; used.add(candidate); resolved.push(candidate); }
                                                  }
                                                  setNodeTransitionPriorities(node!.id, resolved);
                                                  setEditModal({ ...editModal, priority: resolved[editModal.transitionIdx!] });
                                              }} className="underline">Auto-resolve</button>
                                          </div>
                                      );
                                  }
                                  return null;
                              })()}
                          </div>
                      )}

                      {/* Variable browser (quick insert) */}
                      <div className="mt-3 text-xs text-scada-muted">Variables: {Array.from(new Set([...getVariablesFromCode(code), ...Object.keys(debugState.variables)])).slice(0,50).map(v => (
                          <button key={v} onClick={() => setEditModal(m => ({ ...m, content: (m.content ? m.content + ' ' : '') + v }))} className="ml-2 mt-2 px-2 py-1 bg-scada-bg border border-scada-border rounded text-[11px] hover:bg-white/5">{v}</button>
                      ))}</div>
                  </div>
                  <div className="p-4 border-t border-scada-border bg-scada-bg/30 flex justify-end gap-3">
                      <button onClick={() => setEditModal({ ...editModal, isOpen: false })} className="px-4 py-2 rounded text-sm hover:bg-white/5 text-scada-muted transition-colors">Cancel</button>
                      <button
                          onClick={() => saveEdit(editModal.content)}
                          disabled={editModal.type === 'transition' && (() => { const node = sfcNodes.find(n => n.id === editModal.nodeId); return !!(node && typeof editModal.priority === 'number' && node.transitions.some((t, i) => i !== editModal.transitionIdx && t.priority === editModal.priority)); })()}
                          className={`px-4 py-2 rounded text-sm font-bold transition-colors shadow-lg shadow-cyan-900/20 ${editModal.type === 'transition' && (() => { const node = sfcNodes.find(n => n.id === editModal.nodeId); return !!(node && typeof editModal.priority === 'number' && node.transitions.some((t, i) => i !== editModal.transitionIdx && t.priority === editModal.priority)); })() ? 'bg-scada-bg text-scada-muted opacity-60 cursor-default' : 'bg-scada-accent text-white hover:bg-cyan-600'}`}>
                          Apply Changes
                      </button>
                  </div>
              </div>
          </div>
      )}

      {/* Creation Modal (New Step/Transition) */}
      {addModal.isOpen && (
          <div className="absolute inset-0 z-50 bg-black/80 flex items-center justify-center p-8 backdrop-blur-sm animate-in fade-in">
              <div className="bg-scada-panel border border-scada-border rounded-lg shadow-2xl w-full max-w-md flex flex-col overflow-hidden animate-in zoom-in-95">
                  <div className="p-4 border-b border-scada-border bg-scada-bg/50 flex justify-between items-center">
                      <h3 className="font-bold text-white flex items-center gap-2">
                          {addModal.type === 'step' ? <Icons.Box className="w-4 h-4 text-scada-accent" /> : <Icons.GitBranch className="w-4 h-4 text-yellow-500" />}
                          {addModal.type === 'step' ? 'Add New Step' : 'Add Transition'}
                      </h3>
                      <button onClick={() => setAddModal({ ...addModal, isOpen: false })} className="text-scada-muted hover:text-white"><Icons.Close className="w-5 h-5" /></button>
                  </div>
                  
                  <div className="p-6 space-y-4">
                      {addModal.type === 'step' ? (
                          <div>
                              <label className="text-xs font-bold text-scada-muted uppercase block mb-1">Step Name</label>
                              <input 
                                  className="w-full bg-[#0d1117] border border-scada-border rounded p-2 text-white font-mono focus:border-scada-accent outline-none"
                                  value={newStepName} onChange={e => setNewStepName(e.target.value)}
                                  placeholder="e.g. CLEANUP" autoFocus
                              />
                              <p className="text-xs text-scada-muted mt-2">Will be created as <span className="font-mono text-white">STATE_{newStepName.toUpperCase() || '...'}</span></p>
                          </div>
                      ) : (
                          <>
                              <div>
                                  <label className="text-xs font-bold text-scada-muted uppercase block mb-1">Target Step</label>
                                  <select 
                                      className="w-full bg-[#0d1117] border border-scada-border rounded p-2 text-white font-mono focus:border-scada-accent outline-none"
                                      value={newTransTarget} onChange={e => setNewTransTarget(e.target.value)}
                                  >
                                      <option value="">-- Select Target --</option>
                                      {sfcNodes.map(n => <option key={n.id} value={n.id}>{n.label}</option>)}
                                  </select>
                              </div>
                              <div>
                                  <label className="text-xs font-bold text-scada-muted uppercase block mb-1">Condition (ST Boolean)</label>
                                  <input 
                                      className="w-full bg-[#0d1117] border border-scada-border rounded p-2 text-white font-mono focus:border-scada-accent outline-none"
                                      value={newTransCond} onChange={e => setNewTransCond(e.target.value)}
                                      placeholder="e.g. x > 10"
                                  />
                              </div>
                          </>
                      )}
                  </div>

                  <div className="p-4 border-t border-scada-border bg-scada-bg/30 flex justify-end gap-3">
                      <button onClick={() => setAddModal({ ...addModal, isOpen: false })} className="px-4 py-2 rounded text-sm hover:bg-white/5 text-scada-muted transition-colors">Cancel</button>
                      <button 
                          onClick={addModal.type === 'step' ? handleAddStep : handleAddTransition} 
                          disabled={addModal.type === 'step' ? !newStepName : !newTransTarget}
                          className="px-4 py-2 bg-scada-accent text-white rounded text-sm font-bold hover:bg-cyan-600 transition-colors shadow-lg shadow-cyan-900/20 disabled:opacity-50"
                      >
                          {addModal.type === 'step' ? 'Create Step' : 'Add Link'}
                      </button>
                  </div>
              </div>
          </div>
      )}

      {/* Retarget Transition Modal */}
      {retargetModal.isOpen && (
          <div className="absolute inset-0 z-50 bg-black/80 flex items-center justify-center p-8 backdrop-blur-sm animate-in fade-in">
              <div className="bg-scada-panel border border-scada-border rounded-lg shadow-2xl w-full max-w-md flex flex-col overflow-hidden animate-in zoom-in-95">
                  <div className="p-4 border-b border-scada-border bg-scada-bg/50 flex justify-between items-center">
                      <h3 className="font-bold text-white flex items-center gap-2">
                          <Icons.GitBranch className="w-4 h-4 text-scada-accent" /> Edit Transition Target
                      </h3>
                      <button onClick={() => setRetargetModal({ isOpen: false, nodeId: undefined, transitionIdx: undefined, target: '' })} className="text-scada-muted hover:text-white"><Icons.Close className="w-5 h-5" /></button>
                  </div>

                  <div className="p-6 space-y-4">
                      <div>
                          <label className="text-xs font-bold text-scada-muted uppercase block mb-1">Select New Target Step</label>
                          <select
                              className="w-full bg-[#0d1117] border border-scada-border rounded p-2 text-white font-mono focus:border-scada-accent outline-none"
                              value={retargetModal.target}
                              onChange={(e) => setRetargetModal(m => ({ ...m, target: e.target.value }))}
                              autoFocus
                          >
                              <option value="">-- Select Target --</option>
                              {sfcNodes.map(n => <option key={n.id} value={n.id}>{n.label}</option>)}
                          </select>
                      </div>
                  </div>

                  <div className="p-4 border-t border-scada-border bg-scada-bg/30 flex justify-end gap-3">
                      <button onClick={() => setRetargetModal({ isOpen: false, nodeId: undefined, transitionIdx: undefined, target: '' })} className="px-4 py-2 rounded text-sm hover:bg-white/5 text-scada-muted transition-colors">Cancel</button>
                      <button
                          onClick={applyRetargetTransition}
                          disabled={!retargetModal.target}
                          className="px-4 py-2 bg-scada-accent text-white rounded text-sm font-bold hover:bg-cyan-600 transition-colors shadow-lg shadow-cyan-900/20 disabled:opacity-50"
                      >
                          Apply Target
                      </button>
                  </div>
              </div>
          </div>
      )}

      {/* Insert Step Between Modal */}
      {insertStepModal.isOpen && (
          <div className="absolute inset-0 z-50 bg-black/80 flex items-center justify-center p-8 backdrop-blur-sm animate-in fade-in">
              <div className="bg-scada-panel border border-scada-border rounded-lg shadow-2xl w-full max-w-md flex flex-col overflow-hidden animate-in zoom-in-95">
                  <div className="p-4 border-b border-scada-border bg-scada-bg/50 flex justify-between items-center">
                      <h3 className="font-bold text-white flex items-center gap-2">
                          <Icons.Box className="w-4 h-4 text-scada-accent" /> Insert Step Between
                      </h3>
                      <button onClick={() => setInsertStepModal({ isOpen: false, nodeId: undefined, transitionIdx: undefined, stepName: '' })} className="text-scada-muted hover:text-white"><Icons.Close className="w-5 h-5" /></button>
                  </div>

                  <div className="p-6 space-y-4">
                      <div>
                          <label className="text-xs font-bold text-scada-muted uppercase block mb-1">New Step Name</label>
                          <input
                              className="w-full bg-[#0d1117] border border-scada-border rounded p-2 text-white font-mono focus:border-scada-accent outline-none"
                              value={insertStepModal.stepName}
                              onChange={(e) => setInsertStepModal(m => ({ ...m, stepName: e.target.value }))}
                              placeholder="e.g. CHECK_READY"
                              autoFocus
                          />
                          <p className="text-xs text-scada-muted mt-2">This rewires transition as source → new step → old target.</p>
                      </div>
                  </div>

                  <div className="p-4 border-t border-scada-border bg-scada-bg/30 flex justify-end gap-3">
                      <button onClick={() => setInsertStepModal({ isOpen: false, nodeId: undefined, transitionIdx: undefined, stepName: '' })} className="px-4 py-2 rounded text-sm hover:bg-white/5 text-scada-muted transition-colors">Cancel</button>
                      <button
                          onClick={applyInsertStepBetween}
                          disabled={!insertStepModal.stepName.trim()}
                          className="px-4 py-2 bg-scada-accent text-white rounded text-sm font-bold hover:bg-cyan-600 transition-colors shadow-lg shadow-cyan-900/20 disabled:opacity-50"
                      >
                          Insert Step
                      </button>
                  </div>
              </div>
          </div>
      )}

      {/* Rename Modal */}
      {renameModal.isOpen && (
          <div className="absolute inset-0 z-50 bg-black/80 flex items-center justify-center p-8 backdrop-blur-sm animate-in fade-in">
              <div className="bg-scada-panel border border-scada-border rounded-lg shadow-2xl w-full max-w-md flex flex-col overflow-hidden animate-in zoom-in-95">
                  <div className="p-4 border-b border-scada-border bg-scada-bg/50 flex justify-between items-center">
                      <h3 className="font-bold text-white">Rename Step</h3>
                      <button onClick={() => setRenameModal({ isOpen: false, nodeId: undefined, value: '' })} className="text-scada-muted hover:text-white"><Icons.Close className="w-5 h-5" /></button>
                  </div>
                  <div className="p-6">
                      <label className="text-xs font-bold text-scada-muted uppercase block mb-1">New Step Name</label>
                      <input autoFocus value={renameModal.value} onChange={(e) => setRenameModal(r => ({ ...r, value: e.target.value }))} className="w-full bg-[#0d1117] border border-scada-border rounded p-2 text-white font-mono focus:border-scada-accent outline-none" />
                      <div className="mt-3 text-xs text-scada-muted">Use letters, numbers and underscores only. 'STATE_' prefix will be added automatically.</div>
                  </div>
                  <div className="p-4 border-t border-scada-border bg-scada-bg/30 flex justify-end gap-3">
                      <button onClick={() => setRenameModal({ isOpen: false, nodeId: undefined, value: '' })} className="px-4 py-2 rounded text-sm hover:bg-white/5 text-scada-muted transition-colors">Cancel</button>
                      <button onClick={applyRenameStep} className="px-4 py-2 bg-scada-accent text-white rounded text-sm font-bold hover:bg-cyan-600 transition-colors">Rename</button>
                  </div>
              </div>
          </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteModal.isOpen && (
          <div className="absolute inset-0 z-50 bg-black/80 flex items-center justify-center p-8 backdrop-blur-sm animate-in fade-in">
              <div className="bg-scada-panel border border-scada-border rounded-lg shadow-2xl w-full max-w-md flex flex-col overflow-hidden animate-in zoom-in-95">
                  <div className="p-4 border-b border-scada-border bg-scada-bg/50 flex justify-between items-center">
                      <h3 className="font-bold text-white">Delete Step</h3>
                      <button onClick={() => setDeleteModal({ isOpen: false, nodeId: undefined })} className="text-scada-muted hover:text-white"><Icons.Close className="w-5 h-5" /></button>
                  </div>
                  <div className="p-6">
                      <div className="text-sm text-scada-muted">Are you sure you want to delete <strong className="text-white">{deleteModal.label}</strong>? This will remove the state constant and any transitions targeting it.</div>
                  </div>
                  <div className="p-4 border-t border-scada-border bg-scada-bg/30 flex justify-end gap-3">
                      <button onClick={() => setDeleteModal({ isOpen: false, nodeId: undefined })} className="px-4 py-2 rounded text-sm hover:bg-white/5 text-scada-muted transition-colors">Cancel</button>
                      <button onClick={confirmDeleteStep} className="px-4 py-2 bg-scada-danger text-white rounded text-sm font-bold hover:bg-red-600 transition-colors">Delete</button>
                  </div>
              </div>
          </div>
      )}

      {/* Force Confirmation Modal */}
      {forceModal.isOpen && (
          <div className="absolute inset-0 z-50 bg-black/80 flex items-center justify-center p-8 backdrop-blur-sm animate-in fade-in">
              <div className="bg-scada-panel border border-scada-border rounded-lg shadow-2xl w-full max-w-md flex flex-col overflow-hidden animate-in zoom-in-95">
                  <div className="p-4 border-b border-scada-border bg-scada-bg/50 flex justify-between items-center">
                      <h3 className="font-bold text-white">Force Step</h3>
                      <button onClick={() => setForceModal({ isOpen: false, nodeId: undefined })} className="text-scada-muted hover:text-white"><Icons.Close className="w-5 h-5" /></button>
                  </div>
                  <div className="p-6">
                      <div className="text-sm text-scada-muted">Force <strong className="text-white">{forceModal.label}</strong> active? This simulates manual forcing (UI only).</div>
                  </div>
                  <div className="p-4 border-t border-scada-border bg-scada-bg/30 flex justify-end gap-3">
                      <button onClick={() => setForceModal({ isOpen: false, nodeId: undefined })} className="px-4 py-2 rounded text-sm hover:bg-white/5 text-scada-muted transition-colors">Cancel</button>
                      <button onClick={confirmForceStep} className="px-4 py-2 bg-scada-accent text-white rounded text-sm font-bold hover:bg-cyan-600 transition-colors">Apply Force</button>
                  </div>
              </div>
          </div>
      )}

      {/* Find / Replace Modal */}
      {findReplaceOpen && (
         <div className="absolute inset-0 z-50 bg-black/80 flex items-center justify-center p-8 backdrop-blur-sm animate-in fade-in">
             <div className="bg-scada-panel border border-scada-border rounded-lg shadow-2xl w-full max-w-md flex flex-col overflow-hidden animate-in zoom-in-95">
                 <div className="p-4 border-b border-scada-border bg-scada-bg/50 flex justify-between items-center">
                     <h3 className="font-bold text-white text-sm flex items-center gap-2"><Icons.Search className="w-4 h-4 text-scada-accent"/> Find & Replace</h3>
                     <button onClick={() => setFindReplaceOpen(false)} className="text-scada-muted hover:text-white"><Icons.Close className="w-5 h-5" /></button>
                 </div>
                 <div className="p-4 space-y-3">
                     <div>
                         <label className="text-xs text-scada-muted block mb-1">Find</label>
                         <input className="w-full bg-[#0d1117] border border-scada-border rounded p-2 text-white font-mono" value={findText} onChange={e => setFindText(e.target.value)} />
                     </div>
                     <div>
                         <label className="text-xs text-scada-muted block mb-1">Replace</label>
                         <input className="w-full bg-[#0d1117] border border-scada-border rounded p-2 text-white font-mono" value={replaceText} onChange={e => setReplaceText(e.target.value)} />
                     </div>
                     <div className="flex gap-2">
                         <button onClick={() => { const matches = findText ? code.split(findText).length - 1 : 0; setCode(code.split(findText).join(replaceText)); setFindReplaceOpen(false); setConsoleOutput(prev => [...prev, `> Replaced ${matches} occurrences.`]); }} className="px-4 py-2 bg-scada-accent text-white rounded text-sm">Replace All</button>
                         <button onClick={() => { const matches = findText ? code.split(findText).length - 1 : 0; setConsoleOutput(prev => [...prev, `> ${matches} matches found.`]); }} className="px-4 py-2 bg-scada-bg border border-scada-border rounded text-sm">Count Matches</button>
                     </div>
                 </div>
             </div>
         </div>
      )}

      {/* Debug Panel */}
      {showDebugPanel && (
                <div className="absolute right-0 top-0 bottom-0 bg-scada-panel border-l border-scada-border flex flex-col shadow-2xl z-20 animate-in slide-in-from-right duration-200" style={{ width: `${debugPanelWidth}px`, minWidth: '260px', maxWidth: '720px' }}>
                    <div
                        onMouseDown={handleDebugPanelResizeStart}
                        className="absolute left-0 top-0 bottom-0 w-1 -translate-x-1/2 cursor-ew-resize bg-scada-border/40 hover:bg-scada-accent transition-colors z-30"
                        title="Drag to resize Debug Panel width"
                    />
          {/* Debug Panel Header */}
          <div className="flex items-center justify-between p-3 border-b border-scada-border bg-scada-bg/50">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <Icons.Bug className="w-4 h-4 text-scada-accent" />
              Debug Panel
            </h3>
            <button onClick={() => setShowDebugPanel(false)} className="text-scada-muted hover:text-white transition-colors">
              <Icons.Close className="w-4 h-4" />
            </button>
          </div>

          {/* Debug Panel Tabs */}
          <div className="flex border-b border-scada-border bg-scada-bg">
            <button
              onClick={() => setDebugPanelTab('variables')}
              className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${debugPanelTab === 'variables' ? 'text-scada-accent border-b-2 border-scada-accent bg-scada-panel/50' : 'text-scada-muted hover:text-white'}`}
            >
              Variables
            </button>
            <button
              onClick={() => setDebugPanelTab('breakpoints')}
              className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${debugPanelTab === 'breakpoints' ? 'text-scada-accent border-b-2 border-scada-accent bg-scada-panel/50' : 'text-scada-muted hover:text-white'}`}
            >
              Breakpoints
            </button>
            <button
              onClick={() => setDebugPanelTab('watch')}
              className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${debugPanelTab === 'watch' ? 'text-scada-accent border-b-2 border-scada-accent bg-scada-panel/50' : 'text-scada-muted hover:text-white'}`}
            >
              Watch
            </button>
          </div>

          {/* Debug Panel Content */}
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {/* Execution Status */}
            <div className="bg-scada-bg border border-scada-border rounded p-3 space-y-2">
              <div className="text-xs font-medium text-scada-muted uppercase tracking-wide">Execution Status</div>
              <div className="space-y-1 text-xs">
                <div className="flex justify-between">
                  <span className="text-scada-muted">State:</span>
                  <span className={`font-mono font-medium ${debugState.isRunning ? (debugState.isPaused ? 'text-yellow-500' : 'text-scada-success') : 'text-scada-muted'}`}>
                    {debugState.isRunning ? (debugState.isPaused ? 'PAUSED' : 'RUNNING') : 'STOPPED'}
                  </span>
                </div>
                {debugState.activeDeviceId && (
                  <div className="flex justify-between">
                    <span className="text-scada-muted">Device:</span>
                    <span className="font-mono text-white">{debugState.activeDeviceId}</span>
                  </div>
                )}
                {debugState.isPaused && debugState.currentLine > 0 && (
                  <div className="flex justify-between">
                    <span className="text-scada-muted">Line:</span>
                    <span className="font-mono text-scada-accent font-bold">{debugState.currentLine}</span>
                  </div>
                )}
                                <div className="pt-1 border-t border-scada-border/50 text-[10px] text-scada-muted space-y-0.5">
                                    <div>F9 Toggle Breakpoint</div>
                                    <div>F5 Run/Resume/Pause</div>
                                    <div>F10 Step Over</div>
                                </div>
              </div>
            </div>

                        <div className="bg-scada-bg border border-scada-border rounded p-3 space-y-2">
                            <div className="text-xs font-medium text-scada-muted uppercase tracking-wide">Call Stack</div>
                            {callStack.length === 0 ? (
                                <div className="text-xs text-scada-muted">No active stack</div>
                            ) : (
                                <div className="space-y-1">
                                    {callStack.map((frame, idx) => (
                                        <div key={`${frame}-${idx}`} className="text-xs font-mono px-2 py-1 rounded border border-scada-border bg-scada-panel/30 text-gray-300 truncate" title={frame}>
                                            {idx + 1}. {frame}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>

                        <div className="bg-scada-bg border border-scada-border rounded p-3 space-y-2">
                            <div className="flex items-center justify-between">
                                <div className="text-xs font-medium text-scada-muted uppercase tracking-wide">Execution History</div>
                                <button onClick={exportDebugSession} className="text-[10px] text-scada-accent hover:text-cyan-300 transition-colors">Export</button>
                            </div>
                            {executionHistory.length === 0 ? (
                                <div className="text-xs text-scada-muted">No execution trace</div>
                            ) : (
                                <div className="max-h-24 overflow-y-auto space-y-1">
                                    {executionHistory.slice(0, 40).map((entry, idx) => (
                                        <div key={`${entry.timestamp}-${entry.line}-${idx}`} className="text-[10px] font-mono text-scada-muted flex justify-between gap-2">
                                            <span>{new Date(entry.timestamp).toLocaleTimeString()}</span>
                                            <span className="text-white">L{entry.line}</span>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>

            {/* Variables Tab */}
            {debugPanelTab === 'variables' && (
              <div className="space-y-2">
                                <div className="flex items-center justify-between">
                                    <div className="text-xs font-medium text-scada-muted uppercase tracking-wide">Scope Variables</div>
                                                                        <div className="flex items-center gap-2">
                                                                            <div className={`flex items-center gap-1 text-[10px] ${debugState.isPaused && isActiveDebugTarget ? 'text-scada-success' : 'text-scada-muted'}`} title={debugState.isPaused && isActiveDebugTarget ? 'Variable forcing unlocked while paused' : 'Variable forcing locked unless paused on active device'}>
                                                                                <Icons.Lock className="w-3 h-3" />
                                                                                <span>{debugState.isPaused && isActiveDebugTarget ? 'Unlocked' : 'Locked'}</span>
                                                                            </div>
                                                                            <button onClick={copyVariablesToClipboard} className="text-[10px] text-scada-accent hover:text-cyan-300 transition-colors">Copy</button>
                                                                        </div>
                                </div>
                                <div className="text-[10px] text-scada-muted">Double-click a variable to force value (only while paused on active device).</div>
                {Object.keys(debugState.variables).length === 0 ? (
                  <div className="bg-scada-bg border border-scada-border rounded p-3 text-xs text-scada-muted text-center">
                    No variables available
                    <div className="text-[10px] mt-1">Start execution to see variable values</div>
                  </div>
                ) : (
                  <div className="space-y-1">
                    {Object.entries(debugState.variables)
                      .sort(([a], [b]) => a.localeCompare(b))
                                            .map(([key, value]) => {
                                                const isChanged = !!changedVars[key];
                                                                                                const isEditing = editingDebugVar?.name === key;
                                                return (
                                                                                                <div
                                                                                                        key={key}
                                                                                                        onDoubleClick={() => {
                                                                                                            if (debugState.isPaused && isActiveDebugTarget) {
                                                                                                                setEditingDebugVar({ name: key, value: String(value ?? '') });
                                                                                                            }
                                                                                                        }}
                                                                                                        className={`bg-scada-bg border rounded p-2 transition-colors ${debugState.isPaused && isActiveDebugTarget ? 'cursor-pointer' : 'cursor-not-allowed'} ${isChanged ? 'border-scada-accent/80 bg-scada-accent/5' : 'border-scada-border hover:border-scada-accent/50'}`}
                                                                                                >
                          <div className="flex justify-between items-start gap-2">
                            <span className="text-xs font-mono text-scada-accent truncate" title={key}>{key}</span>
                                                        {isEditing ? (
                                                            <input
                                                                autoFocus
                                                                value={editingDebugVar.value}
                                                                onChange={(e) => setEditingDebugVar({ name: key, value: e.target.value })}
                                                                onBlur={applyForcedVariableValue}
                                                                onKeyDown={(e) => {
                                                                    if (e.key === 'Enter') applyForcedVariableValue();
                                                                    if (e.key === 'Escape') setEditingDebugVar(null);
                                                                }}
                                                                className="text-xs font-mono bg-scada-panel border border-scada-accent rounded px-1.5 py-0.5 text-white text-right min-w-[96px] outline-none"
                                                            />
                                                        ) : (
                                                            <span className="text-xs font-mono text-white break-all text-right" title={String(value)}>
                                                                {typeof value === 'boolean' ? (
                                                                    <span className={value ? 'text-scada-success' : 'text-scada-danger'}>{String(value)}</span>
                                                                ) : typeof value === 'number' ? (
                                                                    <span className="text-blue-400">{value}</span>
                                                                ) : (
                                                                    <span className="text-gray-400">{String(value)}</span>
                                                                )}
                                                            </span>
                                                        )}
                          </div>
                        </div>
                                            )})}
                  </div>
                )}
              </div>
            )}

            {/* Breakpoints Tab */}
            {debugPanelTab === 'breakpoints' && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-medium text-scada-muted uppercase tracking-wide">Breakpoints</div>
                                    {breakpointDetails.length > 0 && (
                    <button
                      onClick={() => {
                                                breakpointDetails.forEach(({ line }) => {
                          engine.setBreakpoint(selectedDeviceId, line, false);
                        });
                      }}
                      className="text-[10px] text-scada-danger hover:text-red-400 transition-colors"
                    >
                      Clear All
                    </button>
                  )}
                </div>
                                {breakpointDetails.length === 0 ? (
                  <div className="bg-scada-bg border border-scada-border rounded p-3 text-xs text-scada-muted text-center">
                    No breakpoints set
                    <div className="text-[10px] mt-1">Click line numbers in editor to add</div>
                  </div>
                ) : (
                  <div className="space-y-1">
                                        {breakpointDetails.sort((a, b) => a.line - b.line).map((bp) => {
                                            const line = bp.line;
                                            return (
                      <div key={line} className="bg-scada-bg border border-scada-border rounded p-2 hover:border-scada-accent/50 transition-colors group">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <div className="w-2 h-2 rounded-full bg-red-500" />
                                                        <span className="text-xs font-mono text-white">Line {line}</span>
                                                        <span className="text-[10px] text-scada-muted">hits: {bp.hits}</span>
                          </div>
                          <div className="flex gap-1">
                            <button
                              onClick={() => {
                                // Scroll to line in editor
                                if (editorRef.current) {
                                  const lineHeight = 24; // 1.5rem
                                  editorRef.current.scrollTop = (line - 1) * lineHeight - 100;
                                }
                              }}
                              className="opacity-0 group-hover:opacity-100 text-scada-muted hover:text-scada-accent transition-all p-1"
                              title="Go to line"
                            >
                              <Icons.ChevronRight className="w-3 h-3" />
                            </button>
                            <button
                              onClick={() => engine.setBreakpoint(selectedDeviceId, line, false)}
                              className="opacity-0 group-hover:opacity-100 text-scada-muted hover:text-scada-danger transition-all p-1"
                              title="Remove breakpoint"
                            >
                              <Icons.Close className="w-3 h-3" />
                            </button>
                          </div>
                        </div>
                        {/* Show line content preview */}
                        <div className="text-[10px] text-scada-muted font-mono mt-1 truncate">
                          {code.split('\n')[line - 1]?.trim() || ''}
                        </div>
                                                <div className="mt-2 grid grid-cols-2 gap-2">
                                                    <input
                                                        value={breakpointConditions[line] ?? (bp.condition || '')}
                                                        onChange={(e) => setBreakpointConditions(prev => ({ ...prev, [line]: e.target.value }))}
                                                        onBlur={() => {
                                                            engine.setBreakpointOptions(selectedDeviceId, line, {
                                                                condition: breakpointConditions[line] ?? (bp.condition || ''),
                                                                hitCount: parseInt(breakpointHitCounts[line] ?? String(bp.hitCount || ''), 10) || undefined
                                                            });
                                                        }}
                                                        placeholder="condition (e.g. counter > 10)"
                                                        className="col-span-2 bg-scada-panel border border-scada-border rounded px-2 py-1 text-[10px] font-mono text-white outline-none focus:border-scada-accent"
                                                    />
                                                    <input
                                                        value={breakpointHitCounts[line] ?? (bp.hitCount ? String(bp.hitCount) : '')}
                                                        onChange={(e) => setBreakpointHitCounts(prev => ({ ...prev, [line]: e.target.value.replace(/[^0-9]/g, '') }))}
                                                        onBlur={() => {
                                                            engine.setBreakpointOptions(selectedDeviceId, line, {
                                                                condition: breakpointConditions[line] ?? (bp.condition || ''),
                                                                hitCount: parseInt(breakpointHitCounts[line] ?? String(bp.hitCount || ''), 10) || undefined
                                                            });
                                                        }}
                                                        placeholder="hit count"
                                                        className="bg-scada-panel border border-scada-border rounded px-2 py-1 text-[10px] font-mono text-white outline-none focus:border-scada-accent"
                                                    />
                                                    <button
                                                        onClick={() => {
                                                            engine.setBreakpointOptions(selectedDeviceId, line, {
                                                                condition: breakpointConditions[line] ?? (bp.condition || ''),
                                                                hitCount: parseInt(breakpointHitCounts[line] ?? String(bp.hitCount || ''), 10) || undefined
                                                            });
                                                        }}
                                                        className="bg-scada-accent/20 border border-scada-accent/40 rounded px-2 py-1 text-[10px] text-scada-accent hover:bg-scada-accent/30"
                                                    >
                                                        Apply
                                                    </button>
                                                </div>
                      </div>
                                            );
                                        })}
                  </div>
                )}
              </div>
            )}

            {/* Watch Tab */}
            {debugPanelTab === 'watch' && (
              <div className="space-y-2">
                <div className="text-xs font-medium text-scada-muted uppercase tracking-wide">Watch Expressions</div>
                
                {/* Add Watch Expression */}
                <div className="bg-scada-bg border border-scada-border rounded p-2">
                  <div className="flex gap-1">
                    <input
                      type="text"
                      placeholder="Add expression..."
                      value={newWatchExpr}
                      onChange={(e) => setNewWatchExpr(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && newWatchExpr.trim()) {
                          setWatchExpressions([...watchExpressions, newWatchExpr.trim()]);
                          setNewWatchExpr('');
                        }
                      }}
                      className="flex-1 bg-scada-panel border border-scada-border rounded px-2 py-1 text-xs text-white font-mono outline-none focus:border-scada-accent"
                    />
                    <button
                      onClick={() => {
                        if (newWatchExpr.trim()) {
                          setWatchExpressions([...watchExpressions, newWatchExpr.trim()]);
                          setNewWatchExpr('');
                        }
                      }}
                      className="px-2 py-1 bg-scada-accent/20 hover:bg-scada-accent/30 text-scada-accent rounded text-xs transition-colors"
                    >
                      <Icons.Add className="w-3 h-3" />
                    </button>
                  </div>
                  <div className="text-[10px] text-scada-muted mt-1">
                    Enter variable names or expressions
                  </div>
                </div>

                {/* Watch List */}
                {watchExpressions.length === 0 ? (
                  <div className="bg-scada-bg border border-scada-border rounded p-3 text-xs text-scada-muted text-center">
                    No watch expressions
                    <div className="text-[10px] mt-1">Add expressions to monitor variables</div>
                  </div>
                ) : (
                  <div className="space-y-1">
                    {watchExpressions.map((expr, idx) => {
                      // Evaluate expression
                      let value: any = 'not available';
                      let hasError = false;
                      try {
                        // Try to get from variables
                        if (expr in debugState.variables) {
                          value = debugState.variables[expr];
                        } else {
                          // Try simple dot notation (e.g., scope.var)
                          const parts = expr.split('.');
                          if (parts[0] === 'scope' && parts.length > 1 && parts[1] in debugState.variables) {
                            value = debugState.variables[parts[1]];
                          }
                        }
                      } catch (e) {
                        hasError = true;
                        value = 'error';
                      }

                      return (
                        <div key={idx} className="bg-scada-bg border border-scada-border rounded p-2 hover:border-scada-accent/50 transition-colors group">
                          <div className="flex justify-between items-start gap-2">
                            <span className="text-xs font-mono text-scada-accent truncate flex-1" title={expr}>{expr}</span>
                            <button
                              onClick={() => setWatchExpressions(watchExpressions.filter((_, i) => i !== idx))}
                              className="opacity-0 group-hover:opacity-100 text-scada-muted hover:text-scada-danger transition-all p-0.5"
                              title="Remove watch"
                            >
                              <Icons.Close className="w-3 h-3" />
                            </button>
                          </div>
                          <div className={`text-xs font-mono mt-1 ${hasError ? 'text-scada-danger' : 'text-white'}`}>
                            {typeof value === 'boolean' ? (
                              <span className={value ? 'text-scada-success' : 'text-scada-danger'}>{String(value)}</span>
                            ) : typeof value === 'number' ? (
                              <span className="text-blue-400">{value}</span>
                            ) : (
                              <span className="text-gray-400">{String(value)}</span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Debug Panel Footer with Quick Actions */}
          {debugState.isRunning && (
            <div className="border-t border-scada-border p-3 bg-scada-bg/50 space-y-2">
              <div className="flex gap-2">
                {debugState.isPaused ? (
                  <>
                    <button
                      onClick={() => engine.resume()}
                      className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-scada-success/10 text-scada-success hover:bg-scada-success/20 border border-scada-success/50 rounded text-xs transition-colors font-medium"
                    >
                      <Icons.Play className="w-3 h-3" /> Resume
                    </button>
                                        <button
                                            onClick={() => engine.stepInto()}
                                            disabled={!isActiveDebugTarget}
                                            className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-scada-panel text-white hover:bg-white/10 border border-scada-border rounded text-xs transition-colors font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                                        >
                                            <Icons.ChevronRight className="w-3 h-3" /> Into
                                        </button>
                    <button
                      onClick={() => engine.stepOver()}
                      disabled={!isActiveDebugTarget}
                      className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-scada-accent/10 text-scada-accent hover:bg-scada-accent/20 border border-scada-accent/50 rounded text-xs transition-colors font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                                            <Icons.ChevronRight className="w-3 h-3" /> Over
                                        </button>
                                        <button
                                            onClick={() => engine.stepOut()}
                                            disabled={!isActiveDebugTarget}
                                            className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-scada-panel text-white hover:bg-white/10 border border-scada-border rounded text-xs transition-colors font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                                        >
                                            <Icons.ChevronRight className="w-3 h-3" /> Out
                    </button>
                  </>
                ) : (
                  <button
                                        onClick={() => engine.pause(selectedDeviceId)}
                    className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-yellow-500/10 text-yellow-500 hover:bg-yellow-500/20 border border-yellow-500/50 rounded text-xs transition-colors font-medium"
                  >
                    <Icons.Pause className="w-3 h-3" /> Pause
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Help Modal - Unchanged */}
      {showHelp && (
        <div className="absolute inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-8 animate-in fade-in duration-200">
            <div className="bg-scada-panel border border-scada-border rounded-xl shadow-2xl w-full max-w-4xl h-[90%] flex flex-col overflow-hidden animate-in zoom-in-95 duration-200">
                <div className="flex justify-between items-center p-6 border-b border-scada-border bg-scada-bg/50">
                    <h2 className="text-xl font-bold text-white flex items-center gap-3">
                        <Icons.File className="text-purple-400 w-6 h-6"/> Scripting Reference
                    </h2>
                    <button onClick={() => setShowHelp(false)} className="hover:text-white text-scada-muted transition-colors">
                        <Icons.Close className="w-6 h-6"/>
                    </button>
                </div>
                <div className="flex-1 overflow-y-auto p-8 space-y-10 text-sm">
                    {/* ... (Existing Help Sections) ... */}
                    <section>
                        <h3 className="text-lg font-bold text-scada-accent mb-3 flex items-center gap-2">
                            <Icons.SFC className="w-4 h-4"/> SFC Features
                        </h3>
                        <div className="grid grid-cols-2 gap-4">
                            <div className="bg-black/40 p-4 rounded border border-scada-border">
                                <h4 className="font-bold text-white mb-2">Interactive Editing</h4>
                                <p className="text-xs text-scada-muted">Click on any Step Action box or Transition bar to edit the underlying Structured Text code directly. Use the "+ Step" button to extend the chart.</p>
                            </div>
                            <div className="bg-black/40 p-4 rounded border border-scada-border">
                                <h4 className="font-bold text-white mb-2">Action Qualifiers</h4>
                                <p className="text-xs text-scada-muted">
                                    Click the qualifier letter (N, S, R, P) in the action block to configure it.
                                    <br/><br/>
                                    <span className="text-scada-muted">N - Non-Stored</span><br/>
                                    <span className="text-scada-success">S - Set (Stored)</span><br/>
                                    <span className="text-scada-danger">R - Reset</span><br/>
                                    <span className="text-yellow-400">P - Pulse</span><br/>
                                    <span className="text-blue-400">L - Limited (Requires Time)</span><br/>
                                    <span className="text-purple-400">D - Delayed (Requires Time)</span>
                                </p>
                            </div>
                        </div>
                    </section>
                    {/* ... */}
                </div>
            </div>
        </div>
      )}
    </div>
  );
};
