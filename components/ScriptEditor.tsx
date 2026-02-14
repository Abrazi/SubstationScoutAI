
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
  STATE_INIT : INT := 0;
  STATE_RUN  : INT := 1;
  temp_val : REAL;
END_VAR

IF state = undefined THEN state := STATE_INIT; END_IF;

(* Main State Machine *)
IF state = STATE_INIT THEN
   (* Initialization *)
   (* Q:N *) temp_val := Device.ReadInput('30001') / 100.0;
   
   (* Transition *)
   IF temp_val > 50.0 THEN 
       state := STATE_RUN; 
   END_IF;

ELSIF state = STATE_RUN THEN
   (* Running Actions *)
   (* Q:S *) Device.WriteCoil('00001', TRUE);
   (* Q:N *) Device.Log('info', 'Running...');
   (* Q:D T:T#2s *) Device.WriteCoil('00002', TRUE);
   
   (* Transitions *)
   IF Device.ReadCoil('2') = FALSE THEN 
       state := STATE_INIT; 
   END_IF;
END_IF;
`;

// --- SFC Visualizer Types & Helper ---
const ACTION_QUALIFIERS = ['N', 'S', 'R', 'L', 'D', 'P', 'P1', 'P0', 'DS', 'SL'] as const;
const TIME_QUALIFIERS = ['L', 'D', 'DS', 'SL'];

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
    qualifier: string;
    time: string;
    code: string;
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
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        
        // Skip empty lines or pure multi-line comment delimiters if they are on a single line
        if (!trimmed || trimmed === '(*' || trimmed === '*)') continue;

        // Detect Step Block Start (use discovered state variable name)
        const stepRe = new RegExp(`(?:IF|ELSIF)\\s+${stateVarName}\\s*=\\s*(STATE_\\w+)\\s+THEN`, 'i');
        const stepMatch = trimmed.match(stepRe);
        
        // Close previous step if we hit a new block starter or end
        if (stepMatch || trimmed.toUpperCase() === 'END_IF;' || trimmed.toUpperCase().startsWith('ELSE')) {
            if (currentStep) {
                const node = nodes.find(n => n.id === currentStep);
                if (node) {
                    node.stepEndLine = i - 1;
                }
            }
        }

        if (stepMatch) {
            currentStep = stepMatch[1];
            transitionPriorityCounter = 1;
            const node = nodes.find(n => n.id === currentStep);
            if (node) node.stepStartLine = i;
            continue;
        }

        // Inside a step
        if (currentStep) {
            const node = nodes.find(n => n.id === currentStep);
            if (!node) continue;

            // Detect Transition Block (IF cond THEN <stateVar> := target)
            // Check for inline transition: IF cond THEN <stateVar> := TARGET; END_IF;
            const inlineTrans = trimmed.match(new RegExp(`^IF\\s+(.+)\\s+THEN\\s+${stateVarName}\\s*:=\\s*(STATE_\\w+);\\s*END_IF;`, 'i'));
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
                !trimmed.startsWith('END_VAR')
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

const exportPLCopenXML = (nodes: SFCNode[], code: string) => {
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
  
  // Structured Action Editor State
  const [actionEditor, setActionEditor] = useState<{
      isOpen: boolean;
      nodeId: string;
      actions: EditableAction[];
  }>({ isOpen: false, nodeId: '', actions: [] });

  // Transition Editor State
  const [editModal, setEditModal] = useState<{
      isOpen: boolean;
      title: string;
      content: string;
      type: 'transition';
      nodeId: string;
      transitionIdx?: number;
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

  // --- Modal state for prompt/confirm replacements ---
  const [renameModal, setRenameModal] = useState<{ isOpen: boolean; nodeId?: string; value: string }>({ isOpen: false, nodeId: undefined, value: '' });
  const [deleteModal, setDeleteModal] = useState<{ isOpen: boolean; nodeId?: string; label?: string }>({ isOpen: false, nodeId: undefined });
  const [forceModal, setForceModal] = useState<{ isOpen: boolean; nodeId?: string; label?: string }>({ isOpen: false, nodeId: undefined });

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
  const [findText, setFindText] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const lastStateRef = useRef<number | null>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const lineContainerRef = useRef<HTMLDivElement>(null);

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
          if (config.code) setCode(config.code);
          else {
              engine.updateScriptConfig({ deviceId: selectedDeviceId, code: DEFAULT_SCRIPT, tickRate: 100 });
              setCode(DEFAULT_SCRIPT);
          }
          setTickRate(config.tickRate);
          setIsDirty(false);
      }
  }, [selectedDeviceId]);

  useEffect(() => {
      engine.subscribeToDebug((state) => {
          setDebugState(state);
      });
  }, []);

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
      const stepBodyLines = [];
      // Extract lines belonging to this step, excluding transitions
      for (let i = node.stepStartLine + 1; i <= node.stepEndLine; i++) {
          const inTransition = node.transitions.some(t => i >= t.lineIndex && i <= t.blockEndIndex);
          if (!inTransition) {
              stepBodyLines.push(lines[i].trim());
          }
      }

      // Parse body into EditableActions
      const actions: EditableAction[] = stepBodyLines.map((line, idx) => {
          if (!line) return null;
          const qualRegex = /^\(\*\s*Q:([A-Z0-9]+)(?:\s+T:([^ *]+))?\s*\*\)(.*)/;
          const match = line.match(qualRegex);
          if (match) {
              return {
                  id: `act-${Date.now()}-${idx}`,
                  qualifier: match[1],
                  time: match[2] || '',
                  code: match[3].trim().replace(/;$/, '')
              };
          }
          // Lines without qualifier (comments or raw code) are treated as N for now
          // or we can just ignore pure comments
          if (line.startsWith('(*')) return null;
          return {
              id: `act-${Date.now()}-${idx}`,
              qualifier: 'N',
              time: '',
              code: line.replace(/;$/, '')
          };
      }).filter(Boolean) as EditableAction[];

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
          transitionIdx: transIdx
      });
  };

  const saveActionList = () => {
      const node = sfcNodes.find(n => n.id === actionEditor.nodeId);
      if (!node) return;

      const lines = code.split('\n');
      const transitionsText = node.transitions.map(t => t.fullText);
      
      const newActionLines = actionEditor.actions.map(act => {
          let prefix = `(* Q:${act.qualifier}`;
          if (TIME_QUALIFIERS.includes(act.qualifier) && act.time) {
              const t = act.time.startsWith('T#') ? act.time : `T#${act.time}`;
              prefix += ` T:${t}`;
          }
          prefix += ` *)`;
          return `   ${prefix} ${act.code};`;
      });

      const newBodyLines = [
          ...newActionLines,
          '',
          ...transitionsText
      ];

      const deleteCount = (node.stepEndLine - node.stepStartLine);
      lines.splice(node.stepStartLine + 1, deleteCount, ...newBodyLines);

      setCode(lines.join('\n'));
      setIsDirty(true);
      setActionEditor({ ...actionEditor, isOpen: false });
  };

  // Structured Editor Helpers
  const updateAction = (id: string, field: keyof EditableAction, value: string) => {
      setActionEditor(prev => ({
          ...prev,
          actions: prev.actions.map(a => a.id === id ? { ...a, [field]: value } : a)
      }));
  };

  const addAction = () => {
      const newAct: EditableAction = { id: `new-${Date.now()}`, qualifier: 'N', time: '', code: '' };
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
          const line = lines[trans.lineIndex];
          const newLine = line.replace(/IF\s+(.+)\s+THEN/, `IF ${newContent} THEN`);
          lines[trans.lineIndex] = newLine;
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
  const handleRenameStep = (node: SFCNode) => {
      const input = prompt('Rename step (enter new name, e.g. PARKED)', node.label);
      if (!input) return;
      const clean = input.trim().toUpperCase().replace(/\s+/g, '_');
      const newStateId = clean.startsWith('STATE_') ? clean : `STATE_${clean}`;
      if (!/^[A-Z0-9_]+$/.test(clean)) {
          alert('Invalid step name. Use letters, numbers and underscores only.');
          return;
      }
      if (newStateId === node.id) return;
      const newCode = renameStateInCode(code, node.id, newStateId);
      setCode(newCode);
      setIsDirty(true);
      setConsoleOutput(prev => [...prev, `> Renamed ${node.id} -> ${newStateId}`]);
  };

  const handleDeleteStep = (node: SFCNode) => {
      if (node.type === 'init') {
          alert('Cannot delete the initial step.');
          return;
      }
      if (!confirm(`Delete step '${node.label}' and remove all transitions targeting it?`)) return;
      const newCode = removeStateFromCode(code, node.id, detectedStateVar);
      setCode(newCode);
      setIsDirty(true);
      setConsoleOutput(prev => [...prev, `> Deleted step ${node.id}`]);
  };

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

  const lineCount = code.split('\n').length;
  const lines = Array.from({ length: lineCount }, (_, i) => i + 1);

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
                  onClick={() => setShowHelp(true)}
                  className="flex items-center gap-2 px-3 py-1.5 bg-transparent hover:bg-white/5 border border-transparent hover:border-scada-border rounded text-sm transition-colors text-scada-accent"
               >
                  <Icons.Help className="w-4 h-4" />
                  <span className="hidden sm:inline">Help</span>
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
                       <button onClick={() => engine.pause()} className="flex items-center gap-2 px-3 py-1.5 bg-yellow-500/10 text-yellow-500 border border-yellow-500/50 rounded text-sm hover:bg-yellow-500/20"><Icons.Pause className="w-4 h-4" /></button>
                   )}
                   <div className="w-px h-6 bg-scada-border mx-1"></div>
                   <button onClick={handleStop} className="flex items-center gap-2 px-4 py-1.5 bg-scada-danger/10 text-scada-danger hover:bg-scada-danger/20 border border-scada-danger/50 rounded text-sm transition-colors font-medium"><Icons.Stop className="w-4 h-4" /> Stop</button>
                </>
              )}
          </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
          
          {/* Main Content Area (Dual View) */}
          <div className="flex-1 bg-[#0d1117] relative flex border-r border-scada-border overflow-hidden">
              
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

                      <div className="flex-1 overflow-auto p-8 relative flex flex-col items-center">
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
                                          <div key={node.id} className="relative flex flex-col items-center group">
                                              
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
                                                      <div className="absolute -bottom-3 left-1/2 -translate-x-1/2 flex gap-2 text-[10px]">
                                                          <div className={`px-1 rounded ${isActive ? 'bg-scada-success text-black' : 'bg-scada-bg/80 text-scada-muted'}`}>{node.label}_X</div>
                                                          <div className="px-1 rounded bg-scada-bg/80 text-scada-muted">{node.label}_T: {formatElapsed(lastActivationAge)}</div>
                                                          <div className="px-1 rounded bg-scada-bg/80 text-scada-muted">{node.label}_N: {activationCount}</div>
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
                                                      {node.transitions.map((trans, idx) => (
                                                          <div key={idx} className="flex flex-col items-center w-full group relative">
                                                              <div className="w-0.5 h-6 bg-scada-border" />
                                                              <div className="w-24 h-1.5 bg-gray-500 relative flex items-center justify-center cursor-pointer transition-colors hover:bg-yellow-500 z-20 group/trans" onClick={() => handleEditTransition(node, idx)} title="Click to edit condition">
                                                                  {node.transitions.length > 1 && (
                                                                      <div className="absolute -left-14 flex flex-col items-center space-y-1 text-[10px] font-bold text-yellow-500">
                                                                          <button onClick={() => moveTransitionInCode(node.id, idx, 'up')} className="p-0.5 rounded bg-transparent hover:bg-white/5 text-scada-muted"><Icons.ChevronDown className="w-3 h-3 rotate-180" /></button>
                                                                          <div>[{trans.priority}]</div>
                                                                          <button onClick={() => moveTransitionInCode(node.id, idx, 'down')} className="p-0.5 rounded bg-transparent hover:bg-white/5 text-scada-muted"><Icons.ChevronDown className="w-3 h-3" /></button>
                                                                      </div>
                                                                  )}
                                                                  <div className="absolute left-full ml-3 top-1/2 -translate-y-1/2 bg-scada-bg border border-scada-border p-1.5 rounded shadow-lg min-w-[150px] max-w-[250px] z-50 transition-colors group-hover/trans:border-yellow-500">
                                                                      <div className="text-[9px] text-scada-muted uppercase font-bold flex justify-between">
                                                                          <span>Transition Condition</span>
                                                                          <Icons.Code className="w-3 h-3 text-yellow-500 opacity-0 group-hover/trans:opacity-100" />
                                                                      </div>
                                                                      <div className="text-[10px] font-mono text-yellow-400 break-words">{trans.condition}</div>
                                                                  </div>
                                                              </div>
                                                              <div className="w-0.5 h-6 bg-scada-border relative">
                                                                   <Icons.ChevronDown className="absolute -bottom-2 -left-1.5 w-4 h-4 text-scada-muted" />
                                                              </div>
                                                              <div className="mt-1 px-2 py-0.5 rounded border border-scada-border bg-scada-panel text-[10px] text-scada-text flex items-center gap-1 hover:text-white transition-colors cursor-pointer">
                                                                  <Icons.ArrowDownLeft className="w-3 h-3 text-scada-muted" />
                                                                  <span>{trans.target.replace('STATE_', '')}</span>
                                                              </div>
                                                          </div>
                                                      ))}
                                                      
                                                      {/* Add Another Transition Button (Branching) */}
                                                      <button 
                                                          onClick={() => setAddModal({isOpen: true, type: 'transition', sourceId: node.id})}
                                                          className="mt-2 w-6 h-6 rounded-full bg-scada-bg border border-scada-border flex items-center justify-center text-scada-muted hover:text-white hover:border-scada-accent transition-colors text-xs"
                                                          title="Add Parallel Branch / Divergence"
                                                      >
                                                          +
                                                      </button>
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
                      </div>
                  </div>
              )}
          </div>

          {/* Right Panel - Unchanged */}
          <div className="w-80 bg-scada-panel flex flex-col border-l border-scada-border">
              {/* Variables Inspector */}
              <div className="flex-1 flex flex-col border-b border-scada-border min-h-[200px]">
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
              <div className="border-b border-scada-border p-3 text-xs">
                  <div className="flex items-center justify-between mb-2">
                      <div className="font-bold text-scada-muted uppercase flex items-center gap-2"><Icons.Alert className="w-3 h-3 text-scada-warning" /> SFC Diagnostics</div>
                      <div className="text-[11px] text-scada-muted">{diagnostics.length} issues</div>
                  </div>
                  <div className="space-y-2 max-h-36 overflow-y-auto">
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
              </div>

              {/* Trace Buffer */}
              <div className="p-3 border-b border-scada-border text-xs">
                  <div className="flex items-center justify-between mb-2">
                      <div className="font-bold text-scada-muted uppercase flex items-center gap-2"><Icons.Clock className="w-3 h-3 text-scada-accent" /> Trace (last {transitionTrace.length})</div>
                      <div className="flex gap-2">
                          <button onClick={() => setTransitionTrace([])} className="px-2 py-1 text-xs bg-scada-bg border border-scada-border rounded hover:bg-white/5">Clear</button>
                          <button onClick={() => { const blob = new Blob([JSON.stringify(transitionTrace.slice(0,1000), null, 2)], {type:'application/json'}); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `sfc-trace-${selectedDeviceId}.json`; a.click(); URL.revokeObjectURL(url); }} className="px-2 py-1 text-xs bg-scada-bg border border-scada-border rounded hover:bg-white/5">Export</button>
                      </div>
                  </div>
                  <div className="max-h-36 overflow-y-auto font-mono text-[11px] text-scada-muted space-y-1">
                      {transitionTrace.length === 0 ? <div className="text-scada-muted">No trace yet.</div> : transitionTrace.slice(0,50).map((t, i) => (
                          <div key={i} className="flex justify-between items-center gap-2">
                              <div>{new Date(t.timestamp).toLocaleTimeString()} — <span className="text-white">{resolveStateNameByValue(code, t.to) || t.to}</span></div>
                              <div className="text-scada-muted text-[10px]">{t.deviceId}</div>
                          </div>
                      ))}
                  </div>
              </div>

              {/* Console Output */}
              <div className="h-1/3 flex flex-col">
                  <div className="p-3 border-b border-scada-border text-xs font-bold text-scada-muted uppercase flex items-center gap-2 bg-scada-bg/50">
                      <Icons.Terminal className="w-3 h-3" /> Output Console
                  </div>
                  <div className="flex-1 p-3 font-mono text-xs overflow-y-auto space-y-1 bg-[#0d1117]">
                      {consoleOutput.map((line, i) => (
                          <div key={i} className={`${line.startsWith('> Error') ? 'text-scada-danger' : 'text-scada-text'} ${line.includes('Warning') ? 'text-scada-warning' : ''}`}>{line}</div>
                      ))}
                      {isCompiling && <div className="text-scada-accent animate-pulse">_</div>}
                  </div>
              </div>
          </div>
      </div>

      {/* Structured Action Editor Modal */}
      {actionEditor.isOpen && (
          <div className="absolute inset-0 z-50 bg-black/80 flex items-center justify-center p-8 backdrop-blur-sm animate-in fade-in">
              <div className="bg-scada-panel border border-scada-border rounded-lg shadow-2xl w-full max-w-4xl flex flex-col overflow-hidden animate-in zoom-in-95 h-[80vh]">
                  <div className="p-4 border-b border-scada-border bg-scada-bg/50 flex justify-between items-center">
                      <h3 className="font-bold text-white text-sm flex items-center gap-2">
                          <Icons.Settings className="w-4 h-4 text-scada-accent" /> Configure Actions
                      </h3>
                      <button onClick={() => setActionEditor({ ...actionEditor, isOpen: false })} className="text-scada-muted hover:text-white"><Icons.Close className="w-5 h-5" /></button>
                  </div>
                  
                  <div className="flex-1 overflow-y-auto p-4 bg-[#0d1117]">
                      {actionEditor.actions.length === 0 ? (
                          <div className="h-full flex flex-col items-center justify-center text-scada-muted opacity-50">
                              <p>No actions defined for this step.</p>
                              <button onClick={addAction} className="mt-4 px-4 py-2 bg-scada-bg border border-scada-border rounded hover:bg-white/5 transition-colors">
                                  + Add First Action
                              </button>
                          </div>
                      ) : (
                          <div className="space-y-2">
                              {actionEditor.actions.map((act, index) => (
                                  <div key={act.id} className="flex gap-2 items-start bg-scada-panel border border-scada-border p-3 rounded group hover:border-scada-muted/50 transition-colors">
                                      {/* Controls */}
                                      <div className="flex flex-col gap-1 mt-1">
                                          <button onClick={() => moveAction(index, 'up')} disabled={index === 0} className="text-scada-muted hover:text-white disabled:opacity-30"><Icons.ChevronDown className="w-4 h-4 rotate-180" /></button>
                                          <button onClick={() => moveAction(index, 'down')} disabled={index === actionEditor.actions.length - 1} className="text-scada-muted hover:text-white disabled:opacity-30"><Icons.ChevronDown className="w-4 h-4" /></button>
                                      </div>

                                      {/* Config */}
                                      <div className="w-24">
                                          <label className="text-[9px] font-bold text-scada-muted uppercase block mb-1">Qualifier</label>
                                          <select 
                                              value={act.qualifier}
                                              onChange={(e) => updateAction(act.id, 'qualifier', e.target.value)}
                                              className={`w-full bg-scada-bg border border-scada-border rounded p-1 text-xs font-bold focus:border-scada-accent outline-none ${getQualColor(act.qualifier)}`}
                                          >
                                              {ACTION_QUALIFIERS.map(q => <option key={q} value={q}>{q}</option>)}
                                          </select>
                                      </div>

                                      {TIME_QUALIFIERS.includes(act.qualifier) && (
                                          <div className="w-24 animate-in slide-in-from-left-2">
                                              <label className="text-[9px] font-bold text-scada-muted uppercase block mb-1">Duration</label>
                                              <input 
                                                  value={act.time}
                                                  onChange={(e) => updateAction(act.id, 'time', e.target.value)}
                                                  placeholder="T#2s"
                                                  className="w-full bg-scada-bg border border-scada-border rounded p-1 text-xs text-white font-mono focus:border-scada-accent outline-none"
                                              />
                                          </div>
                                      )}

                                      <div className="flex-1">
                                          <label className="text-[9px] font-bold text-scada-muted uppercase block mb-1">Action Code (Structured Text)</label>
                                          <input 
                                              value={act.code}
                                              onChange={(e) => updateAction(act.id, 'code', e.target.value)}
                                              className="w-full bg-scada-bg border border-scada-border rounded p-1 text-xs text-gray-300 font-mono focus:border-scada-accent outline-none focus:text-white"
                                              placeholder="e.g. Device.WriteCoil('1', TRUE)"
                                          />
                                      </div>

                                      <button onClick={() => removeAction(act.id)} className="mt-6 p-1 text-scada-danger hover:bg-scada-danger/10 rounded transition-colors"><Icons.Trash className="w-4 h-4" /></button>
                                  </div>
                              ))}
                          </div>
                      )}
                  </div>

                  <div className="p-4 border-t border-scada-border bg-scada-bg/30 flex justify-between items-center">
                      <button onClick={addAction} className="px-4 py-2 bg-scada-bg border border-scada-border rounded text-sm hover:bg-white/5 text-scada-muted transition-colors flex items-center gap-2">
                          <Icons.Box className="w-4 h-4" /> Add Action
                      </button>
                      <div className="flex gap-3">
                          <button onClick={() => setActionEditor({ ...actionEditor, isOpen: false })} className="px-4 py-2 rounded text-sm hover:bg-white/5 text-scada-muted transition-colors">Cancel</button>
                          <button onClick={saveActionList} className="px-4 py-2 bg-scada-accent text-white rounded text-sm font-bold hover:bg-cyan-600 transition-colors shadow-lg shadow-cyan-900/20">Apply Changes</button>
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

                      {/* Variable browser (quick insert) */}
                      <div className="mt-3 text-xs text-scada-muted">Variables: {Array.from(new Set([...getVariablesFromCode(code), ...Object.keys(debugState.variables)])).slice(0,50).map(v => (
                          <button key={v} onClick={() => setEditModal(m => ({ ...m, content: (m.content ? m.content + ' ' : '') + v }))} className="ml-2 mt-2 px-2 py-1 bg-scada-bg border border-scada-border rounded text-[11px] hover:bg-white/5">{v}</button>
                      ))}</div>
                  </div>
                  <div className="p-4 border-t border-scada-border bg-scada-bg/30 flex justify-end gap-3">
                      <button onClick={() => setEditModal({ ...editModal, isOpen: false })} className="px-4 py-2 rounded text-sm hover:bg-white/5 text-scada-muted transition-colors">Cancel</button>
                      <button onClick={() => saveEdit(editModal.content)} className="px-4 py-2 bg-scada-accent text-white rounded text-sm font-bold hover:bg-cyan-600 transition-colors shadow-lg shadow-cyan-900/20">Apply Changes</button>
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
                          {addModal.type === 'step' ? <Icons.Box className="w-4 h-4 text-scada-accent" /> : <Icons.GitGraph className="w-4 h-4 text-yellow-500" />}
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
