import React, { useState, useEffect } from 'react';
import { Icons } from './components/Icons';
import { TreeExplorer } from './components/TreeExplorer';
import { Dashboard } from './components/Dashboard';
import { AIChat } from './components/AIChat';
import { NodeInspector } from './components/NodeInspector';
import { LogPanel } from './components/LogPanel';
import { NetworkTopology } from './components/NetworkTopology';
import { ModbusPanel } from './components/ModbusPanel';
import { ScriptEditor } from './components/ScriptEditor';
import { DeviceConfigurator } from './components/DeviceConfigurator';
import { NetworkTap } from './components/NetworkTap';
import { WatchListPanel } from './components/WatchListPanel';
import { ClientMasterPanel } from './components/ClientMasterPanel';
import { generateMockIED } from './utils/mockGenerator';
import { analyzeSCLFile } from './services/geminiService';
import { parseSCL, validateSCL } from './utils/sclParser';
import { IEDNode, ViewMode, LogEntry, WatchItem } from './types';
import { MOCK_IED_NAMES } from './constants';
import { engine } from './services/SimulationEngine';

// Helper to recursively find GSE nodes
const findGooseNodes = (node: IEDNode, results: IEDNode[] = []) => {
    if (node.type === 'GSE' && node.gooseConfig) {
        results.push(node);
    }
    if (node.children) {
        node.children.forEach(c => findGooseNodes(c, results));
    }
    return results;
};

// Helper to find Dataset children
const findDataset = (root: IEDNode, dsName: string): IEDNode | undefined => {
    if (root.type === 'DataSet' && root.name === dsName) return root;
    if (root.children) {
        for (const c of root.children) {
            const found = findDataset(c, dsName);
            if (found) return found;
        }
    }
    return undefined;
};

// Helper to collect all DAs for initialization
const collectDataAttributes = (node: IEDNode, map: Map<string, any>) => {
    if (node.type === 'DA' && node.path && node.value !== undefined) {
        map.set(node.path, node.value);
    }
    if (node.children) {
        node.children.forEach(c => collectDataAttributes(c, map));
    }
};

const App = () => {
  const [viewMode, setViewMode] = useState<ViewMode>('dashboard');
  
  // Initialize IEDs lazily to ensure stable IDs and references
  const [iedList, setIedList] = useState<IEDNode[]>(() => [
      generateMockIED(MOCK_IED_NAMES[0]), 
      generateMockIED(MOCK_IED_NAMES[1]), 
      generateMockIED(MOCK_IED_NAMES[2])
  ]);
  
  const [selectedIED, setSelectedIED] = useState<IEDNode | null>(() => iedList[0]);
  const [selectedNode, setSelectedNode] = useState<IEDNode | null>(() => iedList[0]);
  
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [simulationTime, setSimulationTime] = useState(0);

  // Watch List State
  const [watchList, setWatchList] = useState<WatchItem[]>([]);

  // File Upload State
  const [fileAnalysis, setFileAnalysis] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Initialize Engine Logging & Discovery
  useEffect(() => {
    engine.subscribeToLogs((log) => {
        setLogs(prev => [...prev.slice(-99), log]);
    });

    // 1. Initialize Engine Data Model
    const initialData = new Map<string, any>();
    iedList.forEach(ied => collectDataAttributes(ied, initialData));
    engine.initializeData(initialData);

    // 2. Scan initial IEDs for GOOSE controls and register them to engine
    iedList.forEach(ied => {
        const gooseControls = findGooseNodes(ied);
        gooseControls.forEach(gse => {
            if (gse.gooseConfig) {
                // Find associated dataset
                const dsName = gse.gooseConfig.datSet.split('.').pop() || '';
                const dataset = findDataset(ied, dsName);
                if (dataset && dataset.children) {
                    const entries = dataset.children.map(c => c.path || '');
                    engine.registerDeviceGoose(gse.path!, gse.gooseConfig, entries);
                }
            }
        });
    });

  }, []); // Run once on mount

  // Initialize selectedNode
  useEffect(() => {
    if (selectedIED && !selectedNode) {
      setSelectedNode(selectedIED);
    }
  }, [selectedIED]);

  // Simulation Loop for Visuals
  useEffect(() => {
    const interval = setInterval(() => {
      setSimulationTime(prev => prev + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const handleNodeSelect = (node: IEDNode) => {
    setSelectedNode(node);
    if (node.type === 'IED') {
        setSelectedIED(node);
    }
  };

  const handleTopologySelect = (id: string) => {
      const ied = iedList.find(i => i.id === id);
      if (ied) {
          setSelectedIED(ied);
          setSelectedNode(ied);
          setViewMode('explorer');
      }
  };

  const handleCreateIED = (ied: IEDNode) => {
    setIedList(prev => [...prev, ied]);
    setSelectedIED(ied);
    setSelectedNode(ied);
    setViewMode('network');
    
    // Log creation
    setLogs(prev => [...prev, {
        id: Date.now().toString(),
        timestamp: new Date().toISOString(),
        source: 'Configurator',
        level: 'info',
        message: `Created new IED: ${ied.name} (${ied.config?.ip})`
    }]);
  };

  const handleUpdateIED = (updatedIED: IEDNode) => {
      setIedList(prev => prev.map(ied => ied.id === updatedIED.id ? updatedIED : ied));
      if (selectedIED?.id === updatedIED.id) {
          setSelectedIED(updatedIED);
      }
      // Also update selectedNode if it is the IED itself being inspected
      if (selectedNode?.id === updatedIED.id) {
          setSelectedNode(updatedIED);
      }
      
      setLogs(prev => [...prev, {
        id: Date.now().toString(),
        timestamp: new Date().toISOString(),
        source: 'System',
        level: 'info',
        message: `Updated IED Configuration: ${updatedIED.name}`
    }]);
  };

  const handleRemoveIED = (id: string) => {
      const iedToRemove = iedList.find(i => i.id === id);
      if (!iedToRemove) return;

      if (window.confirm(`Are you sure you want to permanently remove device "${iedToRemove.name}"? This cannot be undone.`)) {
          // Remove from engine logic
          engine.unregisterDevice(iedToRemove.id); 
          
          // Remove from list
          const newList = iedList.filter(i => i.id !== id);
          setIedList(newList);
          
          // Log
          setLogs(prev => [...prev, {
              id: Date.now().toString(),
              timestamp: new Date().toISOString(),
              source: 'System',
              level: 'warning',
              message: `Device removed: ${iedToRemove.name}`
          }]);

          // Adjust selection if needed
          if (selectedIED?.id === id) {
              const next = newList.length > 0 ? newList[0] : null;
              setSelectedIED(next);
              setSelectedNode(next);
          }
      }
  };

  const handleAddToWatch = (item: WatchItem) => {
    setWatchList(prev => {
        if (prev.some(i => i.id === item.id)) return prev; // Avoid duplicates
        
        setLogs(prevLogs => [...prevLogs, {
            id: Date.now().toString(),
            timestamp: new Date().toISOString(),
            source: 'User',
            level: 'info',
            message: `Added to Watch List: ${item.label}`
        }]);
        
        return [...prev, item];
    });
  };

  const handleRemoveFromWatch = (id: string) => {
      setWatchList(prev => prev.filter(i => i.id !== id));
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setErrorMsg(null);
    setFileAnalysis("Validating...");
    
    try {
        const text = await file.text();
        const validation = validateSCL(text);
        if (!validation.valid) {
            setErrorMsg(validation.error || "Validation failed");
            return;
        }

        const parsedIED = parseSCL(text);
        
        setIedList(prev => [...prev, parsedIED]);
        setSelectedIED(parsedIED);
        setSelectedNode(parsedIED);
        setViewMode('network');
        
        setFileAnalysis("SCL Imported Successfully. Running AI Analysis...");
        const analysis = await analyzeSCLFile(text);
        setFileAnalysis(analysis);
        
        setLogs(prev => [...prev, {
            id: Date.now().toString(),
            timestamp: new Date().toISOString(),
            source: 'System',
            level: 'info',
            message: `Imported SCL file: ${file.name}`
        }]);

    } catch (error: any) {
        setErrorMsg(error.message);
    }
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-scada-bg text-scada-text font-sans">
      
      {/* 1. Left Sidebar: Navigation & Project Structure */}
      <div className={`${sidebarOpen ? 'w-64' : 'w-16'} transition-all duration-300 flex flex-col border-r border-scada-border bg-scada-bg z-30`}>
        <div className="p-4 flex items-center gap-3 border-b border-scada-border h-16">
          <Icons.Shield className="text-scada-accent w-6 h-6 shrink-0" />
          <span className={`font-bold tracking-tight whitespace-nowrap overflow-hidden transition-all ${sidebarOpen ? 'opacity-100' : 'opacity-0 w-0'}`}>
            SCOUT AI
          </span>
        </div>

        <nav className="flex-1 py-4 space-y-1 px-2">
           <NavItem icon={Icons.Dashboard} label="Dashboard" active={viewMode === 'dashboard'} onClick={() => setViewMode('dashboard')} collapsed={!sidebarOpen} />
           <NavItem icon={Icons.Wifi} label="Network Topology" active={viewMode === 'network'} onClick={() => setViewMode('network')} collapsed={!sidebarOpen} />
           <NavItem icon={Icons.Activity} label="Network Tap" active={viewMode === 'tap'} onClick={() => setViewMode('tap')} collapsed={!sidebarOpen} />
           <NavItem icon={Icons.Tree} label="IED Explorer" active={viewMode === 'explorer'} onClick={() => setViewMode('explorer')} collapsed={!sidebarOpen} />
           
           <div className="my-2 border-t border-scada-border/50 mx-2"></div>
           
           <NavItem icon={Icons.Cable} label="Client & Master" active={viewMode === 'client'} onClick={() => setViewMode('client')} collapsed={!sidebarOpen} />
           <NavItem icon={Icons.Settings} label="Device Configurator" active={viewMode === 'config'} onClick={() => setViewMode('config')} collapsed={!sidebarOpen} />
           <NavItem icon={Icons.Database} label="Modbus Slave" active={viewMode === 'modbus'} onClick={() => setViewMode('modbus')} collapsed={!sidebarOpen} />
           <NavItem icon={Icons.Code} label="Logic Editor" active={viewMode === 'logic'} onClick={() => setViewMode('logic')} collapsed={!sidebarOpen} />
        </nav>

        {/* File Upload in Sidebar */}
        {sidebarOpen && (
            <div className="p-4 border-t border-scada-border">
                <label className="flex items-center gap-2 text-xs text-scada-muted hover:text-white cursor-pointer transition-colors p-2 rounded hover:bg-white/5 border border-dashed border-scada-border">
                    <Icons.Upload className="w-4 h-4" />
                    <span>Import SCL/CID</span>
                    <input type="file" className="hidden" accept=".xml,.scd,.cid,.icd" onChange={handleFileUpload} />
                </label>
            </div>
        )}

        <div className="p-2">
            <button onClick={() => setSidebarOpen(!sidebarOpen)} className="w-full flex justify-center p-2 hover:bg-white/5 rounded text-scada-muted">
                <Icons.Activity className={`transition-transform duration-300 ${sidebarOpen ? 'rotate-0' : 'rotate-180'}`} />
            </button>
        </div>
      </div>

      {/* Main Layout Area */}
      <div className="flex-1 flex flex-col h-full relative overflow-hidden">
        
        {/* 2. Top Header */}
        <header className="h-16 border-b border-scada-border bg-scada-panel/50 backdrop-blur flex items-center justify-between px-6 z-20">
            <h1 className="text-lg font-medium text-white/90">
                {viewMode === 'dashboard' && 'System Dashboard'}
                {viewMode === 'network' && 'Network Simulation & Topology'}
                {viewMode === 'tap' && 'Packet Analyzer (vTAP)'}
                {viewMode === 'explorer' && 'IEC 61850 Data Model'}
                {viewMode === 'modbus' && 'Modbus Gateway Configuration'}
                {viewMode === 'logic' && 'Programmable Logic Controller'}
                {viewMode === 'config' && 'IED Configuration Wizard'}
                {viewMode === 'client' && 'Client & Master Simulator'}
            </h1>
            <div className="flex items-center gap-4">
                 {/* Simulation Controls */}
                 <div className="flex bg-scada-bg rounded-md border border-scada-border p-1">
                    <button className="p-1.5 hover:bg-white/10 rounded text-scada-success" title="Run Simulation" onClick={() => engine.start()}><Icons.Play className="w-4 h-4" /></button>
                    <button className="p-1.5 hover:bg-white/10 rounded text-scada-danger" title="Stop" onClick={() => engine.stop()}><Icons.Stop className="w-4 h-4" /></button>
                 </div>
                 <div className="flex items-center gap-2 text-xs text-scada-accent bg-scada-accent/10 px-3 py-1.5 rounded-full border border-scada-accent/20">
                    <Icons.Activity className="w-3 h-3 animate-pulse" />
                    <span>Live Simulation</span>
                </div>
            </div>
        </header>

        {/* 3. Center Workspace */}
        <main className="flex-1 flex overflow-hidden relative">
            
            {/* 3a. Inner Sidebar (Explorer Tree) - Only in Explorer Mode */}
            {viewMode === 'explorer' && (
                 <div className="w-72 border-r border-scada-border flex flex-col bg-scada-panel/30">
                    <div className="p-3 border-b border-scada-border bg-scada-panel/50">
                        <label className="font-mono text-[10px] uppercase text-scada-muted mb-1.5 block font-bold">Active Device Context</label>
                        <div className="relative group">
                            <select 
                                value={selectedIED?.id || ''} 
                                onChange={(e) => {
                                    const ied = iedList.find(i => i.id === e.target.value);
                                    if(ied) {
                                        setSelectedIED(ied);
                                        setSelectedNode(ied);
                                    }
                                }}
                                className="w-full bg-scada-bg border border-scada-border rounded-md pl-3 pr-8 py-2 text-sm text-white focus:border-scada-accent focus:ring-1 focus:ring-scada-accent outline-none appearance-none transition-all hover:border-scada-muted cursor-pointer font-medium truncate"
                            >
                                {iedList.map(ied => (
                                    <option key={ied.id} value={ied.id}>{ied.name}</option>
                                ))}
                            </select>
                            <Icons.ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-scada-muted pointer-events-none group-hover:text-white transition-colors" />
                        </div>
                    </div>
                    {selectedIED && <TreeExplorer root={selectedIED} onSelect={handleNodeSelect} selectedId={selectedNode?.id} />}
                 </div>
            )}

            {/* 3b. Main Viewport */}
            <div className="flex-1 overflow-hidden relative flex flex-col bg-scada-bg">
                <div className="flex-1 overflow-y-auto relative">
                    {viewMode === 'dashboard' && (
                        <Dashboard 
                            selectedNode={selectedIED} 
                            ieds={iedList} 
                            onSelectNode={handleNodeSelect}
                            onUpdateNode={handleUpdateIED}
                        />
                    )}
                    
                    {viewMode === 'network' && (
                        <NetworkTopology ieds={iedList} onSelectIED={handleTopologySelect} simulationTime={simulationTime} />
                    )}

                    {viewMode === 'tap' && (
                        <NetworkTap />
                    )}

                    {viewMode === 'explorer' && selectedNode && (
                        <NodeInspector 
                            node={selectedNode} 
                            onUpdateNode={handleUpdateIED}
                            onAddToWatch={handleAddToWatch}
                            onDeleteNode={handleRemoveIED}
                        />
                    )}
                    
                    {viewMode === 'modbus' && selectedIED && (
                        <ModbusPanel 
                            selectedNode={selectedIED} 
                            iedList={iedList}
                            onSelectNode={(node) => {
                                setSelectedIED(node);
                                setSelectedNode(node);
                            }}
                            onUpdateNode={handleUpdateIED}
                            onAddToWatch={handleAddToWatch}
                        />
                    )}

                    {viewMode === 'logic' && (
                        <ScriptEditor 
                            ieds={iedList} 
                            initialDeviceId={selectedIED?.id}
                        />
                    )}

                    {viewMode === 'config' && (
                        <DeviceConfigurator 
                            onSave={handleCreateIED} 
                            onCancel={() => setViewMode('dashboard')} 
                            existingIEDs={iedList} 
                        />
                    )}

                    {viewMode === 'client' && (
                        <ClientMasterPanel ieds={iedList} />
                    )}

                    {/* Error Overlay */}
                    {errorMsg && (
                        <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-scada-danger/90 text-white px-4 py-2 rounded shadow-lg flex items-center gap-2 z-50">
                            <Icons.Alert className="w-4 h-4" /> {errorMsg}
                            <button onClick={() => setErrorMsg(null)} className="ml-2 hover:bg-white/20 rounded-full p-0.5"><Icons.Stop className="w-3 h-3" /></button>
                        </div>
                    )}
                </div>

                {/* 3c. Bottom Panel: Diagnostic Logs */}
                <div className="h-48 border-t border-scada-border bg-scada-panel z-20">
                    <LogPanel logs={logs} onClear={() => setLogs([])} />
                </div>
            </div>

            {/* 4. Right Panel: AI & Watch List */}
            <div className="w-80 border-l border-scada-border bg-scada-panel hidden 2xl:flex flex-col">
                <div className="h-2/3 min-h-[300px] border-b border-scada-border">
                    <AIChat currentIED={selectedIED} />
                </div>
                <div className="flex-1 min-h-[200px]">
                    <WatchListPanel items={watchList} onRemove={handleRemoveFromWatch} />
                </div>
            </div>

        </main>
      </div>
    </div>
  );
};

const NavItem = ({ icon: Icon, label, active, onClick, collapsed }: any) => (
  <button 
    onClick={onClick}
    className={`
      w-full flex items-center gap-3 px-3 py-2 rounded-md transition-colors my-1
      ${active ? 'bg-scada-accent/10 text-scada-accent border-r-2 border-scada-accent' : 'text-scada-muted hover:bg-white/5 hover:text-white border-r-2 border-transparent'}
      ${collapsed ? 'justify-center' : ''}
    `}
    title={label}
  >
    <Icon className="w-5 h-5" />
    {!collapsed && <span className="font-medium text-sm">{label}</span>}
  </button>
);

export default App;