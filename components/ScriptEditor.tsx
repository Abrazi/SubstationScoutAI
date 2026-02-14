import React, { useState, useEffect, useRef } from 'react';
import { Icons } from './Icons';
import { engine } from '../services/SimulationEngine';
import { DebugState, IEDNode } from '../types';

interface ScriptEditorProps {
  ieds: IEDNode[];
  initialDeviceId?: string;
}

const DEFAULT_SCRIPT = `// IEC 61131-3 Inspired Logic
// Device: Controller_01

// Read Temperature Input (Reg 30001)
// Variables MUST use 'VAR' keyword for inspection
VAR temp_val = Device.ReadInput('30001') / 100.0;

// Hysteresis Control Logic
IF temp_val > 65.0 THEN
  // Turn ON Fan (Coil 1)
  Device.WriteCoil('00001', TRUE);
  Device.Log('warning', 'High Temp: ' + temp_val + 'C - Fan ON');
ELSIF temp_val < 50.0 THEN
  // Turn OFF Fan (Coil 1)
  Device.WriteCoil('00001', FALSE);
END_IF;
`;

export const ScriptEditor: React.FC<ScriptEditorProps> = ({ ieds, initialDeviceId }) => {
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>(initialDeviceId || ieds[0]?.id || '');
  const [code, setCode] = useState(DEFAULT_SCRIPT);
  const [tickRate, setTickRate] = useState(100);
  const [consoleOutput, setConsoleOutput] = useState<string[]>(['> System initialized.', '> Select a device to edit logic.']);
  const [isDirty, setIsDirty] = useState(false);
  
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

  // Initialize Engine Devices
  useEffect(() => {
      ieds.forEach(ied => engine.registerDevice(ied.id, ied.name));
  }, [ieds]);

  // Load Script when Selection Changes
  useEffect(() => {
      if (!selectedDeviceId) return;

      const config = engine.getScriptConfig(selectedDeviceId);
      if (config) {
          if (config.code) setCode(config.code);
          else {
              // Set default if empty
              engine.updateScriptConfig({ deviceId: selectedDeviceId, code: DEFAULT_SCRIPT, tickRate: 100 });
              setCode(DEFAULT_SCRIPT);
          }
          setTickRate(config.tickRate);
          setIsDirty(false); // Reset dirty flag after loading new device
      }
  }, [selectedDeviceId]);

  // Sync with Engine Debug State
  useEffect(() => {
      engine.subscribeToDebug((state) => {
          setDebugState(state);
      });
  }, []); 

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
        // Save Config First
        handleSave();

        // Trigger Compile explicitly for feedback
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
      
      // Auto-save previous device if dirty before switching
      if (isDirty) {
          engine.updateScriptConfig({
              deviceId: selectedDeviceId,
              code: code,
              tickRate: tickRate
          });
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

  const isActiveDebugTarget = debugState.activeDeviceId === selectedDeviceId;
  const showDebugLine = debugState.isPaused && isActiveDebugTarget;
  
  // Calculate Lines
  const lineCount = code.split('\n').length;
  const lines = Array.from({ length: lineCount }, (_, i) => i + 1);

  return (
    <div className="h-full flex flex-col bg-scada-bg animate-in fade-in duration-300">
       {/* Header */}
      <div className="h-16 border-b border-scada-border bg-scada-panel/50 flex justify-between items-center px-4 shrink-0 gap-4">
          
          <div className="flex items-center gap-4 flex-1">
             <div className="flex items-center gap-2 text-purple-400">
                <Icons.Code className="w-5 h-5" />
                <span className="font-semibold text-gray-200 hidden md:inline">Logic Editor</span>
             </div>
             
             {/* Device Selector */}
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

             {/* Tick Rate Config */}
             <div className="flex items-center gap-2 bg-scada-bg border border-scada-border rounded px-2 py-1.5" title="Execution Cycle Time">
                 <Icons.Refresh className="w-3 h-3 text-scada-muted" />
                 <input 
                    type="number" 
                    min="10" 
                    max="10000" 
                    value={tickRate} 
                    onChange={handleTickRateChange}
                    className="w-12 bg-transparent text-sm text-right outline-none text-white font-mono"
                 />
                 <span className="text-xs text-scada-muted">ms</span>
             </div>
          </div>
          
          {/* Debug Toolbar */}
          <div className="flex gap-2 shrink-0">
               {/* Save Button */}
               <button 
                  onClick={handleSave}
                  disabled={!isDirty}
                  className={`flex items-center gap-2 px-3 py-1.5 border rounded text-sm transition-colors font-medium
                    ${isDirty 
                        ? 'bg-scada-accent/10 text-scada-accent border-scada-accent/50 hover:bg-scada-accent/20' 
                        : 'bg-transparent text-scada-muted border-transparent opacity-50 cursor-default'
                    }`}
                  title={isDirty ? "Save Changes" : "No unsaved changes"}
              >
                  <Icons.Save className="w-4 h-4" />
                  <span className="hidden sm:inline">Save</span>
              </button>
              
              <div className="w-px h-6 bg-scada-border mx-1"></div>

              {!debugState.isRunning ? (
                <button 
                    onClick={handleRun}
                    disabled={isCompiling}
                    className="flex items-center gap-2 px-4 py-1.5 bg-scada-success/10 text-scada-success hover:bg-scada-success/20 border border-scada-success/50 rounded text-sm transition-colors font-medium"
                >
                    {isCompiling ? <Icons.Activity className="w-4 h-4 animate-spin" /> : <Icons.Run className="w-4 h-4" />}
                    {isCompiling ? 'Compiling...' : 'Run All'}
                </button>
              ) : (
                <>
                   {debugState.isPaused ? (
                       <>
                           <button onClick={() => engine.resume()} className="flex items-center gap-2 px-3 py-1.5 bg-scada-accent/10 text-scada-accent border border-scada-accent/50 rounded text-sm hover:bg-scada-accent/20" title="Continue">
                               <Icons.Play className="w-4 h-4" />
                           </button>
                           <button onClick={() => engine.stepOver()} disabled={!isActiveDebugTarget} className="flex items-center gap-2 px-3 py-1.5 bg-scada-panel border border-scada-border rounded text-sm hover:bg-white/10 text-white disabled:opacity-50" title="Step Over">
                               <Icons.ChevronRight className="w-4 h-4" />
                           </button>
                       </>
                   ) : (
                       <button onClick={() => engine.pause()} className="flex items-center gap-2 px-3 py-1.5 bg-yellow-500/10 text-yellow-500 border border-yellow-500/50 rounded text-sm hover:bg-yellow-500/20" title="Pause">
                           <Icons.Pause className="w-4 h-4" />
                       </button>
                   )}
                   <div className="w-px h-6 bg-scada-border mx-1"></div>
                   <button 
                        onClick={handleStop}
                        className="flex items-center gap-2 px-4 py-1.5 bg-scada-danger/10 text-scada-danger hover:bg-scada-danger/20 border border-scada-danger/50 rounded text-sm transition-colors font-medium"
                    >
                        <Icons.Stop className="w-4 h-4" /> Stop
                    </button>
                </>
              )}
          </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
          
          {/* Left: Code Editor with Gutter */}
          <div className="flex-1 bg-[#0d1117] relative flex border-r border-scada-border">
              
              {/* Line Gutter */}
              <div ref={lineContainerRef} className="w-12 bg-scada-bg border-r border-scada-border/50 text-right text-scada-muted text-sm font-mono pt-4 pb-4 select-none overflow-hidden">
                  {lines.map(line => {
                      const hasBreakpoint = debugState.breakpoints.includes(line) && isActiveDebugTarget;
                      const isCurrent = showDebugLine && debugState.currentLine === line;
                      return (
                          <div 
                            key={line} 
                            onClick={() => toggleBreakpoint(line)}
                            className={`h-6 pr-2 cursor-pointer hover:bg-white/5 relative flex items-center justify-end ${isCurrent ? 'bg-yellow-500/20 text-yellow-500 font-bold' : ''}`}
                          >
                              {hasBreakpoint && <div className="absolute left-1.5 w-2.5 h-2.5 rounded-full bg-red-500 shadow-sm" />}
                              {isCurrent && <Icons.ChevronRight className="absolute left-0 w-3 h-3 text-yellow-500" />}
                              {line}
                          </div>
                      );
                  })}
              </div>

              {/* Text Area */}
              <div className="flex-1 relative overflow-hidden">
                   <textarea 
                     ref={editorRef}
                     value={code}
                     onChange={handleCodeChange}
                     onScroll={handleScroll}
                     className="absolute inset-0 w-full h-full bg-transparent text-gray-300 font-mono text-sm p-4 pt-4 pl-2 resize-none outline-none leading-[1.5rem]"
                     spellCheck={false}
                     style={{ lineHeight: '1.5rem' }} 
                   />
                   {/* Active Line Highlight Overlay */}
                   {showDebugLine && debugState.currentLine > 0 && (
                       <div 
                         className="absolute left-0 right-0 bg-yellow-500/10 pointer-events-none border-t border-b border-yellow-500/20"
                         style={{ top: `${(debugState.currentLine - 1) * 1.5 + 1}rem`, height: '1.5rem' }}
                       />
                   )}
              </div>
          </div>

          {/* Right: Debug Panel & Console */}
          <div className="w-80 bg-scada-panel flex flex-col">
              
              {/* Variables Inspector */}
              <div className="flex-1 flex flex-col border-b border-scada-border min-h-[200px]">
                  <div className="p-3 border-b border-scada-border text-xs font-bold text-scada-muted uppercase flex items-center gap-2 bg-scada-bg/50">
                      <Icons.Search className="w-3 h-3" /> Variables Inspector
                  </div>
                  <div className="flex-1 overflow-y-auto p-0">
                      {isActiveDebugTarget ? (
                          <table className="w-full text-xs font-mono">
                              <thead className="text-scada-muted bg-white/5 text-left">
                                  <tr>
                                      <th className="px-3 py-1 font-medium">Name</th>
                                      <th className="px-3 py-1 font-medium">Value</th>
                                  </tr>
                              </thead>
                              <tbody className="divide-y divide-scada-border/30">
                                  {Object.entries(debugState.variables).length === 0 && (
                                      <tr><td colSpan={2} className="text-center py-4 text-scada-muted opacity-50">No variables in scope</td></tr>
                                  )}
                                  {Object.entries(debugState.variables).map(([key, val]) => (
                                      <tr key={key} className="hover:bg-white/5">
                                          <td className="px-3 py-1 text-purple-400">{key}</td>
                                          <td className="px-3 py-1 text-gray-200 break-all">{typeof val === 'number' ? val.toFixed(2) : String(val)}</td>
                                      </tr>
                                  ))}
                              </tbody>
                          </table>
                      ) : (
                          <div className="p-4 text-center text-scada-muted text-xs">
                              Variables only available when execution is paused on this device.
                          </div>
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
                          <div key={i} className={`
                            ${line.startsWith('> Error') ? 'text-scada-danger' : 'text-scada-text'}
                            ${line.includes('Warning') ? 'text-scada-warning' : ''}
                          `}>
                              {line}
                          </div>
                      ))}
                      {isCompiling && <div className="text-scada-accent animate-pulse">_</div>}
                      {debugState.isRunning && !debugState.isPaused && <div className="text-scada-success animate-pulse text-[10px] mt-2">● RUNNING</div>}
                      {debugState.isPaused && isActiveDebugTarget && <div className="text-yellow-500 font-bold text-[10px] mt-2">❚❚ PAUSED AT LINE {debugState.currentLine}</div>}
                  </div>
              </div>
          </div>
      </div>
    </div>
  );
};
