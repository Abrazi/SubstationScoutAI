import React, { useState, useEffect } from 'react';
import { IEDNode, NodeType, IEDConfig, WatchItem, ControlModel, ControlSession, GooseConfig } from '../types';
import { Icons } from './Icons';
import { explainLogicalNode } from '../services/geminiService';
import { engine } from '../services/SimulationEngine';

interface NodeInspectorProps {
  node: IEDNode;
  onUpdateNode?: (node: IEDNode) => void;
  onAddToWatch?: (item: WatchItem) => void;
}

export const NodeInspector: React.FC<NodeInspectorProps> = ({ node, onUpdateNode, onAddToWatch }) => {
  const [aiAnalysis, setAiAnalysis] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  
  // Live Value State
  const [liveValue, setLiveValue] = useState<any>(node.value);
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(String(node.value));

  // Control State
  const [controlModel, setControlModel] = useState<ControlModel | null>(null);
  const [controlSession, setControlSession] = useState<ControlSession | undefined>(undefined);
  const [ctlMessage, setCtlMessage] = useState<string | null>(null);
  const [ctlError, setCtlError] = useState<string | null>(null);

  // IED Config State
  const [configForm, setConfigForm] = useState<IEDConfig>({
      ip: '192.168.1.100', 
      subnet: '255.255.255.0', 
      gateway: '192.168.1.1', 
      vlan: 1,
      mac: '00:1B:44:11:3A:B7',
      isDHCP: false
  });
  const [isConfigDirty, setIsConfigDirty] = useState(false);

  // GOOSE Config State
  const [gooseForm, setGooseForm] = useState<GooseConfig>({
      appID: '0001',
      confRev: 1,
      minTime: 10,
      maxTime: 2000,
      datSet: ''
  });
  const [isGooseDirty, setIsGooseDirty] = useState(false);

  // Sync with engine and props when node changes
  useEffect(() => {
    setAiAnalysis(null);
    setCtlMessage(null);
    setCtlError(null);

    // 1. Determine if this is a Controllable Object (Has ctlModel)
    if (node.type === NodeType.DO && node.children) {
        const ctlModelNode = node.children.find(c => c.name === 'ctlModel');
        if (ctlModelNode && ctlModelNode.path) {
            // Read from engine to get live configuration
            const liveModel = engine.readMMS(ctlModelNode.path) || ctlModelNode.value;
            setControlModel(liveModel as ControlModel);
        } else {
            setControlModel(null);
        }
    } else {
        setControlModel(null);
    }

    if ((node.type === NodeType.DA || node.value !== undefined) && node.path) {
        // Initialize from engine or fallback to node value
        const engineVal = engine.readMMS(node.path);
        if (engineVal === undefined && node.value !== undefined) {
             // If engine empty, populate it with initial data (simulating initial read)
             engine.writeMMS(node.path, node.value, 'System Init');
             setLiveValue(node.value);
             setEditValue(String(node.value));
        } else if (engineVal !== undefined) {
             setLiveValue(engineVal);
             setEditValue(String(engineVal));
        } else {
             setLiveValue(node.value);
             setEditValue(String(node.value));
        }
    }

    // Initialize Config Form if IED
    if (node.type === NodeType.IED) {
        setConfigForm(node.config || {
            ip: '192.168.1.100',
            subnet: '255.255.255.0',
            gateway: '192.168.1.1',
            vlan: 1,
            mac: '00:1B:44:11:3A:B7',
            isDHCP: false
        });
        setIsConfigDirty(false);
    }

    // Initialize GOOSE Form if GSE
    if (node.type === NodeType.GSE && node.gooseConfig) {
        setGooseForm(node.gooseConfig);
        setIsGooseDirty(false);
    }
  }, [node]);

  // Poll for live updates from engine
  useEffect(() => {
     if (!node.path) return;
     const interval = setInterval(() => {
         // Live Value
         const val = engine.readMMS(node.path!);
         if (val !== undefined && val !== liveValue && !isEditing) {
             setLiveValue(val);
         }

         // Control Session Status
         if (controlModel && controlModel.includes('sbo')) {
             setControlSession(engine.getControlSession(node.path!));
         }
     }, 200);
     return () => clearInterval(interval);
  }, [node, liveValue, isEditing, controlModel]);

  // --- Actions ---

  const handleSelect = () => {
      if (!node.path) return;
      setCtlMessage("Selecting...");
      setCtlError(null);
      
      // Artificial delay for realism
      setTimeout(() => {
          const res = engine.selectControl(node.path!);
          if (res.success) {
              setCtlMessage("Selection Successful. Ready to Operate.");
              // Trigger forced update of session
              setControlSession(engine.getControlSession(node.path!));
          } else {
              setCtlError(res.error || "Selection Failed");
              setCtlMessage(null);
          }
      }, 500);
  };

  const handleOperate = (val: any) => {
      if (!node.path) return;
      setCtlMessage("Operating...");
      setCtlError(null);
      
      setTimeout(() => {
          const res = engine.operateControl(node.path!, val);
          if (res.success) {
              setCtlMessage("Command Executed Successfully.");
              setTimeout(() => setCtlMessage(null), 3000);
          } else {
              setCtlError(res.error || "Operation Failed");
              setCtlMessage(null);
          }
      }, 400);
  };

  const handleCancel = () => {
      if (!node.path) return;
      engine.cancelControl(node.path);
      setCtlMessage("Selection Cancelled.");
      setControlSession(undefined);
      setTimeout(() => setCtlMessage(null), 2000);
  };

  const handleExplain = async () => {
    setLoading(true);
    const result = await explainLogicalNode(node.name, `Type: ${node.type}, Description: ${node.description || 'N/A'}`);
    setAiAnalysis(result);
    setLoading(false);
  };

  const handleSaveValue = () => {
      if (node.path) {
          engine.writeMMS(node.path, editValue, 'Inspector User');
          setLiveValue(editValue);
          setIsEditing(false);
      }
  };

  const handleConfigChange = (field: keyof IEDConfig, value: any) => {
      setConfigForm(prev => ({ ...prev, [field]: value }));
      setIsConfigDirty(true);
  };

  const saveConfig = () => {
      if (onUpdateNode) {
          onUpdateNode({ ...node, config: configForm });
          setIsConfigDirty(false);
      }
  };

  const handleGooseChange = (field: keyof GooseConfig, val: any) => {
      setGooseForm(prev => ({ ...prev, [field]: val }));
      setIsGooseDirty(true);
  };

  const saveGooseConfig = () => {
      // 1. Update UI Model
      const updatedNode = { ...node, gooseConfig: gooseForm };
      if (onUpdateNode) onUpdateNode(updatedNode);
      
      // 2. Update Engine
      if (node.path) {
          engine.updateGooseConfig(node.path, gooseForm);
      }
      
      setIsGooseDirty(false);
  };

  const addToWatchList = () => {
    if (onAddToWatch && node.path) {
        onAddToWatch({
            id: `iec61850-${node.id}`,
            label: node.name,
            source: 'IEC61850',
            addressOrPath: node.path
        });
    }
  };

  const getIcon = () => {
    switch (node.type) {
      case NodeType.IED: return <Icons.Server className="w-8 h-8 text-scada-accent" />;
      case NodeType.LDevice: return <Icons.Cpu className="w-8 h-8 text-purple-400" />;
      case NodeType.LN: return <Icons.Activity className="w-8 h-8 text-blue-400" />;
      case NodeType.DO: return <Icons.Tree className="w-8 h-8 text-scada-muted" />;
      case NodeType.DA: return <Icons.Zap className="w-8 h-8 text-yellow-400" />;
      case NodeType.GSE: return <Icons.Wifi className="w-8 h-8 text-purple-400" />;
      default: return <Icons.File className="w-8 h-8" />;
    }
  };

  // Logic to determine allowed operate values
  const getOperateButtons = () => {
      // IEC 61850 Enumeration for Switch Position:
      // off (01) = OPEN
      // on (10) = CLOSED
      // intermediate (00)
      // bad (11)
      return (
          <div className="flex gap-3 mt-2">
              <button 
                onClick={() => handleOperate('off')} // Off = Open
                className="flex-1 bg-scada-success/90 hover:bg-emerald-500 text-white font-bold py-3 px-4 rounded shadow-lg shadow-emerald-900/30 uppercase text-xs tracking-wider flex items-center justify-center gap-2 transition-all transform hover:scale-[1.02]"
              >
                  <span className="w-2 h-2 rounded-full bg-white animate-pulse"></span> Open / Off
              </button>
              <button 
                onClick={() => handleOperate('on')} // On = Closed
                className="flex-1 bg-scada-danger/90 hover:bg-red-500 text-white font-bold py-3 px-4 rounded shadow-lg shadow-red-900/30 uppercase text-xs tracking-wider flex items-center justify-center gap-2 transition-all transform hover:scale-[1.02]"
              >
                  <Icons.Zap className="w-3 h-3" /> Close / On
              </button>
          </div>
      );
  };

  // Force re-render for countdown timer
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
      if (controlSession) {
          const t = setInterval(() => setNow(Date.now()), 1000);
          return () => clearInterval(t);
      }
  }, [controlSession]);

  return (
    <div className="h-full flex flex-col bg-scada-bg text-scada-text animate-in fade-in duration-300">
      
      {/* Header */}
      <div className="p-6 border-b border-scada-border bg-scada-panel/50">
        <div className="flex items-start gap-4">
          <div className="p-3 bg-scada-bg border border-scada-border rounded-lg shadow-lg">
            {getIcon()}
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-mono uppercase bg-scada-accent/10 text-scada-accent px-2 py-0.5 rounded border border-scada-accent/20">
                {node.type}
              </span>
              <span className="text-xs text-scada-muted font-mono">{node.path}</span>
            </div>
            <h2 className="text-2xl font-bold text-white tracking-tight">{node.name}</h2>
            <p className="text-scada-muted mt-1">{node.description || "No description available."}</p>
          </div>
          <button 
            onClick={handleExplain}
            disabled={loading}
            className="flex items-center gap-2 px-3 py-2 bg-scada-panel hover:bg-scada-border border border-scada-border rounded text-sm transition-colors"
          >
            <Icons.AI className={`w-4 h-4 ${loading ? 'animate-pulse text-scada-accent' : 'text-purple-400'}`} />
            {loading ? "Analyzing..." : "Explain Node"}
          </button>
        </div>

        {/* AI Analysis Result */}
        {aiAnalysis && (
          <div className="mt-4 p-4 bg-scada-bg/50 border border-purple-500/30 rounded-lg text-sm leading-relaxed text-gray-300 shadow-inner">
            <div className="flex items-center gap-2 text-purple-400 font-semibold mb-2">
              <Icons.AI className="w-4 h-4" /> AI Insight
            </div>
            {aiAnalysis}
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">

        {/* --- GOOSE Configuration Panel (New) --- */}
        {node.type === NodeType.GSE && (
            <div className="mb-8 bg-scada-panel border border-scada-border rounded-lg p-5 shadow-sm animate-in slide-in-from-bottom-2">
                 <div className="flex justify-between items-center mb-4 border-b border-scada-border pb-3">
                     <h3 className="text-sm font-bold uppercase text-white flex items-center gap-2">
                        <Icons.Settings className="w-4 h-4 text-purple-400" /> GOOSE Publisher Settings
                    </h3>
                    {isGooseDirty && (
                         <button onClick={saveGooseConfig} className="text-xs font-bold bg-scada-accent text-white px-3 py-1.5 rounded hover:bg-cyan-600 transition-colors shadow-lg shadow-cyan-900/20 flex items-center gap-2 animate-in fade-in">
                             <Icons.Save className="w-3 h-3" /> Save Changes
                         </button>
                    )}
                </div>
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-1">
                        <label className="text-xs font-bold text-scada-muted uppercase">AppID</label>
                        <input 
                            className="w-full bg-scada-bg border border-scada-border rounded px-3 py-2 text-sm font-mono focus:border-scada-accent outline-none text-white"
                            value={gooseForm.appID}
                            onChange={(e) => handleGooseChange('appID', e.target.value)}
                            placeholder="0001"
                        />
                    </div>
                     <div className="space-y-1">
                        <label className="text-xs font-bold text-scada-muted uppercase">Config Revision</label>
                        <input 
                            type="number"
                            className="w-full bg-scada-bg border border-scada-border rounded px-3 py-2 text-sm font-mono focus:border-scada-accent outline-none text-white"
                            value={gooseForm.confRev}
                            onChange={(e) => handleGooseChange('confRev', parseInt(e.target.value))}
                        />
                    </div>
                     <div className="space-y-1">
                        <label className="text-xs font-bold text-scada-muted uppercase">Min Time (ms)</label>
                        <input 
                            type="number"
                            className="w-full bg-scada-bg border border-scada-border rounded px-3 py-2 text-sm font-mono focus:border-scada-accent outline-none text-white"
                            value={gooseForm.minTime}
                            onChange={(e) => handleGooseChange('minTime', parseInt(e.target.value))}
                        />
                    </div>
                     <div className="space-y-1">
                        <label className="text-xs font-bold text-scada-muted uppercase">Max Time (ms)</label>
                        <input 
                            type="number"
                            className="w-full bg-scada-bg border border-scada-border rounded px-3 py-2 text-sm font-mono focus:border-scada-accent outline-none text-white"
                            value={gooseForm.maxTime}
                            onChange={(e) => handleGooseChange('maxTime', parseInt(e.target.value))}
                        />
                    </div>
                    <div className="space-y-1 md:col-span-2">
                        <label className="text-xs font-bold text-scada-muted uppercase">Dataset Reference</label>
                        <input 
                            className="w-full bg-scada-bg border border-scada-border rounded px-3 py-2 text-sm font-mono focus:border-scada-accent outline-none text-gray-400 cursor-not-allowed"
                            value={gooseForm.datSet}
                            disabled
                            title="Dataset reference is currently read-only"
                        />
                    </div>
                </div>
            </div>
        )}

        {/* --- Control Actions Panel --- */}
        {controlModel && controlModel !== 'status-only' && (
            <div className="mb-8 bg-scada-panel border border-scada-border rounded-lg overflow-hidden shadow-lg animate-in slide-in-from-bottom-2">
                <div className="px-4 py-3 bg-gradient-to-r from-scada-panel to-scada-bg border-b border-scada-border flex justify-between items-center">
                    <h3 className="text-sm font-bold uppercase text-white flex items-center gap-2">
                        <Icons.Zap className="w-4 h-4 text-yellow-400" /> Control Interface
                    </h3>
                    <div className="flex gap-2">
                        {controlModel.includes('enhanced') && (
                            <div className="text-[10px] font-mono bg-purple-500/20 text-purple-300 border border-purple-500/30 px-2 py-1 rounded flex items-center gap-1">
                                <Icons.Shield className="w-3 h-3"/> Enhanced Security
                            </div>
                        )}
                        <div className="text-[10px] font-mono bg-white/5 px-2 py-1 rounded text-scada-muted border border-white/10">
                            Model: {controlModel}
                        </div>
                    </div>
                </div>
                <div className="p-5">
                    {/* Feedback Messages */}
                    {ctlMessage && <div className="mb-4 p-3 bg-scada-success/10 text-scada-success text-sm rounded border border-scada-success/20 flex gap-2 animate-in fade-in"><Icons.Activity className="w-4 h-4"/> {ctlMessage}</div>}
                    {ctlError && <div className="mb-4 p-3 bg-scada-danger/10 text-scada-danger text-sm rounded border border-scada-danger/20 flex gap-2 animate-in fade-in"><Icons.Alert className="w-4 h-4"/> {ctlError}</div>}

                    {/* SBO Logic */}
                    {controlModel.includes('sbo') ? (
                        <>
                            {controlSession ? (
                                <div className="space-y-4 animate-in fade-in slide-in-from-top-2">
                                    <div className="flex items-center justify-between bg-scada-bg/50 border border-scada-accent/50 rounded p-3">
                                        <div className="flex items-center gap-3">
                                             <div className="bg-scada-accent/20 p-2 rounded-full animate-pulse">
                                                 <Icons.Zap className="w-4 h-4 text-scada-accent" />
                                             </div>
                                             <div>
                                                 <div className="text-xs font-bold text-scada-accent uppercase">Ready to Operate</div>
                                                 <div className="text-xs text-scada-muted">Session expires in <span className="text-white font-mono">{Math.max(0, Math.ceil((controlSession.expiryTime - now) / 1000))}s</span></div>
                                             </div>
                                        </div>
                                        <button onClick={handleCancel} className="text-xs bg-white/5 hover:bg-white/10 px-3 py-1.5 rounded text-scada-muted hover:text-white transition-colors border border-transparent hover:border-scada-border">
                                            Cancel
                                        </button>
                                    </div>
                                    
                                    <div className="p-4 bg-scada-bg rounded border border-scada-border">
                                        <label className="text-xs font-bold text-scada-muted uppercase block mb-3">Select Command Value</label>
                                        {getOperateButtons()}
                                    </div>
                                </div>
                            ) : (
                                <div className="space-y-3">
                                    <div className="text-sm text-scada-muted bg-blue-500/5 border border-blue-500/10 p-3 rounded">
                                        <p className="mb-2 flex items-center gap-1"><span className="text-blue-400 font-bold">Sequence:</span> Select <Icons.ChevronRight className="w-3 h-3 inline"/> Verify <Icons.ChevronRight className="w-3 h-3 inline"/> Operate</p>
                                        <p className="text-xs opacity-70">This object requires a two-step control sequence (Select-Before-Operate) to prevent accidental operation.</p>
                                    </div>
                                    <button 
                                        onClick={handleSelect}
                                        disabled={!!ctlMessage}
                                        className="w-full py-3 bg-scada-accent/10 border border-scada-accent/50 hover:bg-scada-accent hover:text-white text-scada-accent rounded font-bold uppercase text-xs flex items-center justify-center gap-2 transition-all shadow-lg shadow-cyan-900/10 disabled:opacity-50"
                                    >
                                        {ctlMessage === 'Selecting...' ? <Icons.Refresh className="w-4 h-4 animate-spin"/> : <Icons.Filter className="w-4 h-4" />}
                                        {ctlMessage === 'Selecting...' ? 'Verifying Interlocks...' : 'Initiate Selection'}
                                    </button>
                                </div>
                            )}
                        </>
                    ) : (
                        // Direct Operate
                        <div>
                             <p className="text-xs text-scada-muted mb-3 bg-yellow-500/5 border border-yellow-500/10 p-2 rounded">
                                <span className="font-bold text-yellow-500">Caution:</span> Direct Control Mode. Commands execute immediately upon click.
                                {controlModel.includes('enhanced') && ' Enhanced security checks (Interlocking) will be performed.'}
                             </p>
                             {getOperateButtons()}
                        </div>
                    )}
                </div>
            </div>
        )}
        
        {/* Network Configuration Panel (Only for IEDs) */}
        {node.type === NodeType.IED && (
            <div className="mb-6 bg-scada-panel border border-scada-border rounded-lg p-5 shadow-sm">
                <div className="flex justify-between items-center mb-4 border-b border-scada-border pb-3">
                    <h3 className="text-sm font-bold uppercase text-white flex items-center gap-2">
                        <Icons.Wifi className="w-4 h-4 text-scada-accent" /> Network Interface
                    </h3>
                    <div className="flex items-center gap-2">
                        {isConfigDirty && (
                            <button onClick={saveConfig} className="text-xs font-bold bg-scada-accent text-white px-3 py-1.5 rounded hover:bg-cyan-600 transition-colors shadow-lg shadow-cyan-900/20 flex items-center gap-2 animate-in fade-in">
                                <Icons.Save className="w-3 h-3" /> Save Changes
                            </button>
                        )}
                    </div>
                </div>
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
                     {/* IP Configuration */}
                     <div className="col-span-full mb-2">
                        <div className="flex items-center gap-2">
                            <input 
                                type="checkbox" 
                                id="dhcp" 
                                checked={configForm.isDHCP || false} 
                                onChange={e => handleConfigChange('isDHCP', e.target.checked)}
                                className="rounded bg-scada-bg border-scada-border text-scada-accent focus:ring-scada-accent"
                            />
                            <label htmlFor="dhcp" className="text-sm text-gray-300 font-medium cursor-pointer">Obtain IP address automatically (DHCP)</label>
                        </div>
                     </div>

                    <div className="space-y-1">
                        <label className="text-xs font-bold text-scada-muted uppercase">IP Address</label>
                        <div className="relative">
                            <input 
                                className={`w-full bg-scada-bg border border-scada-border rounded px-3 py-2 text-sm font-mono focus:border-scada-accent outline-none text-white transition-colors ${configForm.isDHCP ? 'opacity-50 cursor-not-allowed' : ''}`}
                                value={configForm.ip}
                                onChange={e => handleConfigChange('ip', e.target.value)}
                                placeholder="192.168.1.100"
                                disabled={configForm.isDHCP}
                            />
                            {!configForm.isDHCP && <Icons.Settings className="w-3 h-3 text-scada-muted absolute right-3 top-3 opacity-50" />}
                        </div>
                    </div>
                    
                    <div className="space-y-1">
                        <label className="text-xs font-bold text-scada-muted uppercase">Subnet Mask</label>
                        <input 
                            className={`w-full bg-scada-bg border border-scada-border rounded px-3 py-2 text-sm font-mono focus:border-scada-accent outline-none text-white transition-colors ${configForm.isDHCP ? 'opacity-50 cursor-not-allowed' : ''}`}
                            value={configForm.subnet}
                            onChange={e => handleConfigChange('subnet', e.target.value)}
                            placeholder="255.255.255.0"
                            disabled={configForm.isDHCP}
                        />
                    </div>
                    
                    <div className="space-y-1">
                        <label className="text-xs font-bold text-scada-muted uppercase">Default Gateway</label>
                        <input 
                            className={`w-full bg-scada-bg border border-scada-border rounded px-3 py-2 text-sm font-mono focus:border-scada-accent outline-none text-white transition-colors ${configForm.isDHCP ? 'opacity-50 cursor-not-allowed' : ''}`}
                            value={configForm.gateway}
                            onChange={e => handleConfigChange('gateway', e.target.value)}
                            placeholder="192.168.1.1"
                            disabled={configForm.isDHCP}
                        />
                    </div>
                    
                    {/* VLAN & MAC */}
                    <div className="space-y-1">
                        <label className="text-xs font-bold text-scada-muted uppercase">VLAN ID</label>
                         <select 
                            className="w-full bg-scada-bg border border-scada-border rounded px-3 py-2 text-sm font-mono focus:border-scada-accent outline-none text-white transition-colors appearance-none"
                            value={configForm.vlan}
                            onChange={e => handleConfigChange('vlan', parseInt(e.target.value))}
                        >
                            <option value="1">VLAN 1 (Management)</option>
                            <option value="10">VLAN 10 (Station Bus)</option>
                            <option value="20">VLAN 20 (Process Bus)</option>
                        </select>
                    </div>

                    <div className="space-y-1 md:col-span-2">
                        <label className="text-xs font-bold text-scada-muted uppercase">MAC Address</label>
                        <div className="flex gap-2">
                            <input 
                                className="w-full bg-scada-bg border border-scada-border rounded px-3 py-2 text-sm font-mono focus:border-scada-accent outline-none text-white transition-colors uppercase"
                                value={configForm.mac || '00:00:00:00:00:00'}
                                onChange={e => handleConfigChange('mac', e.target.value)}
                                placeholder="00:1B:44:11:3A:B7"
                            />
                            <button 
                                onClick={() => handleConfigChange('mac', "00:1B:" + Array.from({length: 4}, () => Math.floor(Math.random()*256).toString(16).padStart(2, '0').toUpperCase()).join(':'))}
                                className="px-3 py-2 bg-scada-bg border border-scada-border rounded text-scada-muted hover:text-white hover:border-scada-accent transition-colors"
                                title="Generate Random MAC"
                            >
                                <Icons.Refresh className="w-4 h-4" />
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        )}

        {/* Attributes Table for Data Attributes (DA) */}
        {(node.type === NodeType.DA || (node.value !== undefined)) && (
           <div className="mb-8">
             <div className="flex justify-between items-center mb-3">
                 <h3 className="text-sm font-bold uppercase text-scada-muted flex items-center gap-2">
                    <Icons.Zap className="w-4 h-4" /> Live Values
                 </h3>
                 {onAddToWatch && node.path && (
                     <button 
                        onClick={addToWatchList}
                        className="text-xs flex items-center gap-1 bg-scada-panel border border-scada-border px-2 py-1 rounded text-scada-muted hover:text-white hover:border-scada-accent transition-colors"
                     >
                         <Icons.Eye className="w-3 h-3" /> Watch
                     </button>
                 )}
             </div>
             <div className="bg-scada-panel border border-scada-border rounded-lg overflow-hidden">
               <table className="w-full text-sm text-left">
                 <thead className="bg-white/5 text-scada-muted font-mono text-xs uppercase">
                   <tr>
                     <th className="px-4 py-3">Property</th>
                     <th className="px-4 py-3">Value</th>
                     <th className="px-4 py-3">Type</th>
                   </tr>
                 </thead>
                 <tbody className="divide-y divide-scada-border/50 font-mono">
                   <tr>
                     <td className="px-4 py-3 text-scada-accent">Value</td>
                     <td className="px-4 py-3 text-white font-bold">
                        {isEditing ? (
                            <div className="flex gap-2 items-center">
                                {node.validValues ? (
                                    <select
                                        className="bg-scada-bg border border-scada-border px-2 py-1 rounded text-white w-full outline-none focus:border-scada-accent"
                                        value={editValue}
                                        onChange={e => setEditValue(e.target.value)}
                                        autoFocus
                                    >
                                        {node.validValues.map(val => (
                                            <option key={val} value={val}>{val}</option>
                                        ))}
                                    </select>
                                ) : (
                                    <input 
                                        className="bg-scada-bg border border-scada-border px-2 py-1 rounded text-white w-full outline-none focus:border-scada-accent"
                                        value={editValue}
                                        onChange={e => setEditValue(e.target.value)}
                                        onKeyDown={e => e.key === 'Enter' && handleSaveValue()}
                                        autoFocus
                                    />
                                )}
                                <button onClick={handleSaveValue} className="p-1 bg-scada-success/20 text-scada-success rounded hover:bg-scada-success/40" title="Write Value">
                                    <Icons.Save className="w-4 h-4" />
                                </button>
                                <button onClick={() => { setIsEditing(false); setEditValue(String(liveValue)); }} className="p-1 bg-scada-danger/20 text-scada-danger rounded hover:bg-scada-danger/40" title="Cancel">
                                    <Icons.Stop className="w-4 h-4" />
                                </button>
                            </div>
                        ) : (
                            <div className="flex items-center gap-2 group cursor-pointer hover:bg-white/5 p-1 -ml-1 rounded transition-colors" onClick={() => { setIsEditing(true); setEditValue(String(liveValue)); }}>
                                <span>{String(liveValue)}</span>
                                <Icons.Code className="w-3 h-3 text-scada-muted opacity-0 group-hover:opacity-100" />
                            </div>
                        )}
                     </td>
                     <td className="px-4 py-3 text-scada-muted">
                        {node.validValues ? (
                           <div className="flex items-center gap-2 group relative">
                               <span className="text-yellow-400 font-bold">ENUM</span>
                               <Icons.List className="w-3 h-3 cursor-help text-scada-muted hover:text-white" />
                               <div className="absolute left-full ml-2 top-1/2 -translate-y-1/2 bg-scada-bg border border-scada-border p-2 rounded shadow-xl w-48 z-50 hidden group-hover:block pointer-events-none">
                                   <div className="text-[10px] text-scada-muted uppercase font-bold mb-1">Allowed Values:</div>
                                   <div className="text-xs text-white break-words">
                                       {node.validValues.join(', ')}
                                   </div>
                               </div>
                           </div>
                        ) : (
                           typeof liveValue === 'boolean' ? 'BOOLEAN' : typeof liveValue === 'number' ? 'FLOAT32' : 'VISIBLE STRING'
                        )}
                     </td>
                   </tr>
                   {node.attributes && Object.entries(node.attributes).map(([key, val]) => (
                     <tr key={key}>
                       <td className="px-4 py-3 text-scada-muted">{key}</td>
                       <td className="px-4 py-3 text-gray-300">{val}</td>
                       <td className="px-4 py-3 text-scada-muted">Attribute</td>
                     </tr>
                   ))}
                 </tbody>
               </table>
             </div>
           </div>
        )}

        {/* Children List for IED, LD, LN, DO */}
        {node.children && node.children.length > 0 && (
          <div>
            <h3 className="text-sm font-bold uppercase text-scada-muted mb-3 flex items-center gap-2">
              <Icons.Tree className="w-4 h-4" /> Contained Objects
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {node.children.map(child => (
                <div key={child.id} className="bg-scada-panel border border-scada-border p-3 rounded hover:border-scada-accent/50 transition-colors group">
                  <div className="flex items-center gap-2 mb-1">
                     {child.type === NodeType.DA ? <Icons.Zap className="w-3 h-3 text-yellow-500" /> : <Icons.Tree className="w-3 h-3 text-blue-400" />}
                     <span className="font-mono text-sm font-bold text-gray-200">{child.name}</span>
                  </div>
                  <div className="text-xs text-scada-muted truncate">
                    {child.description || child.type}
                  </div>
                  {child.value !== undefined && (
                    <div className="mt-2 text-xs font-mono bg-scada-bg/50 p-1 rounded border border-white/5 text-right text-scada-accent">
                      = {String(child.value)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
        
        {(!node.children || node.children.length === 0) && node.type !== NodeType.DA && node.type !== NodeType.IED && node.type !== NodeType.GSE && (
            <div className="text-center py-10 text-scada-muted border-2 border-dashed border-scada-border rounded-lg">
                <Icons.File className="w-12 h-12 mx-auto mb-2 opacity-20" />
                <p>Empty Container</p>
            </div>
        )}

      </div>
    </div>
  );
};
