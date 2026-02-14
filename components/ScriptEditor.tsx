
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
    actions: SFCAction[];
    transitions: SFCTransition[];
    stepStartLine: number;
    stepEndLine: number;
}

const parseSFC = (code: string): SFCNode[] => {
    const nodes: SFCNode[] = [];
    if (!code) return nodes;

    const lines = code.split('\n');
    const stateNames = new Map<string, string>(); 
    
    // 0. Detect Initial Step (heuristic)
    let initialStepId: string | null = null;
    const initMatch = code.match(/IF\s+state\s*=\s*undefined\s+THEN\s+state\s*:=\s*(STATE_\w+)/);
    if (initMatch) initialStepId = initMatch[1];

    // 1. Find States Constants
    // Looks for patterns like: STATE_NAME : INT := 0;
    const constRegex = /^\s*(STATE_\w+)\s*:\s*INT\s*:=\s*\d+;/;
    
    lines.forEach(line => {
        const match = line.match(constRegex);
        if (match) {
            stateNames.set(match[1], match[1]);
            nodes.push({ 
                id: match[1], 
                label: match[1].replace('STATE_', ''), 
                type: (initialStepId === match[1]) ? 'init' : 'step',
                transitions: [],
                actions: [],
                stepStartLine: -1,
                stepEndLine: -1
            });
        }
    });

    if (nodes.length === 0) return [];

    // 2. Find Transitions & Actions Logic
    let currentStep: string | null = null;
    let transitionPriorityCounter = 1;
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        
        // Skip empty lines or pure multi-line comment delimiters if they are on a single line
        if (!trimmed || trimmed === '(*' || trimmed === '*)') continue;

        // Detect Step Block Start
        const stepMatch = trimmed.match(/(?:IF|ELSIF)\s+state\s*=\s*(STATE_\w+)\s+THEN/);
        
        // Close previous step if we hit a new block starter or end
        if (stepMatch || trimmed === 'END_IF;' || trimmed.startsWith('ELSE')) {
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

            // Detect Transition Block (IF cond THEN state := target)
            // Simple heuristic: IF ... THEN state := ...
            // We need to handle single line and multi-line IFs reasonably well without a full parser
            
            // Check for inline transition: IF cond THEN state := TARGET; END_IF;
            const inlineTrans = trimmed.match(/^IF\s+(.+)\s+THEN\s+state\s*:=\s*(STATE_\w+);\s*END_IF;/);
            if (inlineTrans && stateNames.has(inlineTrans[2])) {
                 node.transitions.push({
                    target: inlineTrans[2],
                    condition: inlineTrans[1].replace(/\(\*.*\*\)/g, '').trim(),
                    priority: transitionPriorityCounter++,
                    fullText: line,
                    lineIndex: i,
                    blockEndIndex: i
                 });
                 continue;
            }

            // Check for multiline transition start: IF cond THEN
            const transStartMatch = trimmed.match(/^IF\s+(.+)\s+THEN/);
            
            if (transStartMatch) {
                // Check if this IF block contains a state assignment in the immediate next lines
                // This is a naive check to separate transitions from normal logic
                // We scan forward looking for `state := ...` at depth 1
                let isTransition = false;
                let targetState = '';
                let j = i;
                let blockEnd = i;
                let depth = 1;
                let foundAssign = false;
                
                // Scan forward limited lines to prevent hang on huge files
                while (j < lines.length - 1 && j < i + 20) { 
                    j++;
                    const nextTrim = lines[j].trim();
                    if (nextTrim.startsWith('IF ') && nextTrim.endsWith('THEN')) depth++;
                    if (nextTrim === 'END_IF;') depth--;
                    
                    const assignMatch = nextTrim.match(/state\s*:=\s*(STATE_\w+)/);
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
                    node.transitions.push({
                        target: targetState,
                        condition: transStartMatch[1].replace(/\(\*.*\*\)/g, '').trim(),
                        priority: transitionPriorityCounter++,
                        fullText: lines.slice(i, blockEnd + 1).join('\n'),
                        lineIndex: i,
                        blockEndIndex: blockEnd
                    });
                    
                    // Advance outer loop to skip this block
                    i = blockEnd; 
                    continue;
                }
            }
            
            // Simple direct assignment transition: state := TARGET
            const simpleAssign = trimmed.match(/^state\s*:=\s*(STATE_\w+)/);
            if (simpleAssign) {
                 const target = simpleAssign[1];
                 if (stateNames.has(target)) {
                    node.transitions.push({ 
                        target, 
                        condition: "TRUE",
                        priority: transitionPriorityCounter++,
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
ELSIF state = ${stepName} THEN
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
      const transCode = `   IF ${newTransCond} THEN state := ${newTransTarget}; END_IF;`;
      lines.splice(insertIdx, 0, transCode);
      setCode(lines.join('\n'));
      setIsDirty(true);
      setAddModal({ ...addModal, isOpen: false });
      setConsoleOutput(prev => [...prev, `> Added Transition: ${node.label} -> ${newTransTarget.replace('STATE_', '')}`]);
  };

  const isActiveDebugTarget = debugState.activeDeviceId === selectedDeviceId;
  const showDebugLine = debugState.isPaused && isActiveDebugTarget;
  
  const activeSFCStepId = useMemo(() => {
      if (!isActiveDebugTarget && !debugState.isRunning) return null;
      const stateVal = debugState.variables['state'];
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
                              <span className="text-xs font-mono w-12 text-center text-white">{zoomLevel}%</span>
                              <button onClick={() => setZoomLevel(z => Math.min(200, z + 25))} className="p-1 hover:bg-white/10 rounded text-scada-muted"><Icons.ChevronRight className="w-4 h-4 -rotate-90" /></button>
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
                                      return (
                                          <div key={node.id} className="relative flex flex-col items-center group">
                                              
                                              <div className="flex items-center gap-4">
                                                  {/* Step Box */}
                                                  <div className={`
                                                      w-40 h-20 flex items-center justify-center font-bold text-sm shadow-xl transition-all duration-300 relative z-10
                                                      ${isActive 
                                                          ? 'bg-scada-success/20 border-scada-success text-white shadow-[0_0_20px_rgba(16,185,129,0.3)]' 
                                                          : 'bg-scada-panel border-scada-border text-gray-300'}
                                                      ${node.type === 'init' ? 'border-4 double' : 'border-2'}
                                                  `}>
                                                      <div className="text-center">
                                                          <div className="text-[9px] uppercase text-scada-muted mb-1">{node.type === 'init' ? 'INITIAL' : `STEP ${index}`}</div>
                                                          {node.label}
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
                                                                  {node.transitions.length > 1 && <div className="absolute -left-6 text-[10px] font-bold text-yellow-500">[{trans.priority}]</div>}
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
                      <div className="mt-2 text-xs text-scada-muted">
                          Boolean expression (e.g., x &gt; 10 AND y &lt; 5)
                      </div>
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
