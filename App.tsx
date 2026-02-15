
import React, { useState, useEffect, useRef, Component, ErrorInfo } from 'react';
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
import { DeviceList } from './components/DeviceList';
import { generateFleet } from './utils/mockGenerator';
import { GENERATOR_LOGIC_SCRIPT } from './utils/generatorLogic';
import { analyzeSCLFile } from './services/geminiService';
import { parseSCL, validateSCL } from './utils/sclParser';
import { IEDNode, ViewMode, LogEntry, WatchItem } from './types';
import { engine } from './services/SimulationEngine';

// --- Error Boundary Component ---
export class ErrorBoundary extends Component<{ children: React.ReactNode }, { hasError: boolean, error: Error | null }> {
  // explicit state field to keep TypeScript happy in all environments
  state: { hasError: boolean; error: Error | null } = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Uncaught error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-screen bg-scada-bg text-scada-danger p-8 text-center">
          <Icons.Alert className="w-16 h-16 mb-4" />
          <h1 className="text-2xl font-bold mb-2">Something went wrong.</h1>
          <p className="text-scada-muted mb-4 max-w-md bg-black/30 p-4 rounded font-mono text-sm break-words">
            {this.state.error?.message}
          </p>
          <button 
            onClick={() => window.location.reload()} 
            className="px-4 py-2 bg-scada-panel border border-scada-border rounded text-white hover:bg-white/10"
          >
            Reload Application
          </button>
        </div>
      );
    }
    return this.props.children;
  }
} 

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

const AppContent = () => {
  const [viewMode, setViewMode] = useState<ViewMode | 'devices'>('dashboard');
  
  // Initialize IEDs with the full generator fleet
  const [iedList, setIedList] = useState<IEDNode[]>([]);
  
  const [selectedIED, setSelectedIED] = useState<IEDNode | null>(null);
  const [selectedNode, setSelectedNode] = useState<IEDNode | null>(null);
  
  const [sidebarOpen, setSidebarOpen] = useState(true);
    const [rightSidebarOpen, setRightSidebarOpen] = useState<boolean>(() => {
        try {
            const saved = localStorage.getItem('ui.rightSidebarOpen');
            return saved === null ? true : saved === '1';
        } catch {
            return true;
        }
    }); // Watch List / AI Sidebar
  const [rightSidebarWidth, setRightSidebarWidth] = useState(320);
  const [isResizingRightSidebar, setIsResizingRightSidebar] = useState(false);

    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [isLogPanelCollapsed, setIsLogPanelCollapsed] = useState<boolean>(() => {
        try {
            return localStorage.getItem('ui.logPanelCollapsed') === '1';
        } catch {
            return false;
        }
    });
  const [simulationTime, setSimulationTime] = useState(0);

  // Watch List State
  const [watchList, setWatchList] = useState<WatchItem[]>([]);

  // File Upload State
  const [fileAnalysis, setFileAnalysis] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null); // For Open Project

    const handleRightSidebarResizeStart = (e: React.MouseEvent) => {
            e.preventDefault();
            setIsResizingRightSidebar(true);
    };

  // --- Engine Initialization Logic ---
  const initializeSimulation = (nodes: IEDNode[]) => {
      try {
          // 1. Initialize Engine Data Model
          const initialData = new Map<string, any>();
          nodes.forEach(ied => collectDataAttributes(ied, initialData));
          engine.initializeData(initialData);

          // 2. Register Devices
          nodes.forEach(ied => {
              engine.registerDevice(ied.id, ied.name);
          });

          // 3. Scan for GOOSE controls
          nodes.forEach(ied => {
              const gooseControls = findGooseNodes(ied);
              gooseControls.forEach(gse => {
                  if (gse.gooseConfig) {
                      const dsName = gse.gooseConfig.datSet.split('.').pop() || '';
                      const dataset = findDataset(ied, dsName);
                      if (dataset && dataset.children) {
                          const entries = dataset.children.map(c => c.path || '');
                          engine.registerDeviceGoose(gse.path!, gse.gooseConfig, entries);
                      }
                  }
              });
          });
      } catch (e) {
          console.error("Failed to initialize simulation engine:", e);
      }
  };

  // Initialize Engine Logging & Discovery (One time)
  useEffect(() => {
    // Load Fleet
    const fleet = generateFleet();
    setIedList(fleet);
    
    // Default select G1
    if (fleet.length > 0) {
        setSelectedIED(fleet[0]);
        setSelectedNode(fleet[0]);
    }

    engine.subscribeToLogs((log) => {
        setLogs(prev => [...prev.slice(-99), log]);
    });

    initializeSimulation(fleet);

    // AUTO-LOAD GENERATOR LOGIC (Specific to Mock Fleet)
    // Run this in a timeout to allow UI to render first
    setTimeout(() => {
        try {
            fleet.forEach(ied => {
                if (ied.id.startsWith('G') && !isNaN(parseInt(ied.id.substring(1)))) {
                    engine.updateScriptConfig({
                        deviceId: ied.id,
                        code: GENERATOR_LOGIC_SCRIPT,
                        tickRate: 100
                    });
                }
            });
            engine.start(); 
        } catch (e) {
            console.error("Error auto-loading scripts:", e);
        }
    }, 100);

        try {
            const saved = localStorage.getItem('ui.rightSidebarOpen');
            if (saved === null && window.innerWidth < 1280) {
                setRightSidebarOpen(false);
            }
        } catch {
            if (window.innerWidth < 1280) {
                setRightSidebarOpen(false);
            }
        }

  }, []); // Run once on mount

  // Initialize selectedNode
  useEffect(() => {
    if (selectedIED && !selectedNode) {
      setSelectedNode(selectedIED);
    }
  }, [selectedIED]);

    useEffect(() => {
        engine.syncModbusDevices(iedList);
    }, [iedList]);

    useEffect(() => {
        try {
            localStorage.setItem('ui.logPanelCollapsed', isLogPanelCollapsed ? '1' : '0');
        } catch {
            // ignore storage errors
        }
    }, [isLogPanelCollapsed]);

    useEffect(() => {
        try {
            localStorage.setItem('ui.rightSidebarOpen', rightSidebarOpen ? '1' : '0');
        } catch {
            // ignore storage errors
        }
    }, [rightSidebarOpen]);

    useEffect(() => {
        if (!isResizingRightSidebar) return;

        const handleMouseMove = (e: MouseEvent) => {
            const newWidth = window.innerWidth - e.clientX;
            const minWidth = 260;
            const maxWidth = Math.min(720, Math.floor(window.innerWidth * 0.5));
            setRightSidebarWidth(Math.max(minWidth, Math.min(maxWidth, newWidth)));
        };

        const handleMouseUp = () => {
            setIsResizingRightSidebar(false);
        };

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);

        return () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };
    }, [isResizingRightSidebar]);

  // Simulation Loop for Visuals
  useEffect(() => {
    const interval = setInterval(() => {
      setSimulationTime(prev => prev + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // --- Project Management Functions ---

  const handleNewProject = () => {
      if (confirm("Are you sure you want to create a new project? All unsaved changes will be lost.")) {
          engine.stop();
          // Unregister all current
          iedList.forEach(ied => engine.unregisterDevice(ied.id));
          
          setIedList([]);
          setWatchList([]);
          setLogs([]);
          setSelectedIED(null);
          setSelectedNode(null);
          
          setLogs(prev => [...prev, {
              id: Date.now().toString(),
              timestamp: new Date().toISOString(),
              source: 'System',
              level: 'info',
              message: 'New Project Created'
          }]);
      }
  };

  const handleSaveProject = () => {
      // 1. Gather Scripts from Engine (they are not in iedList)
      const scripts: Record<string, any> = {};
      iedList.forEach(ied => {
          const config = engine.getScriptConfig(ied.id);
          if (config) scripts[ied.id] = config;
      });

      const projectData = {
          version: '1.0',
          timestamp: new Date().toISOString(),
          iedList,
          watchList,
          scripts
      };

      const blob = new Blob([JSON.stringify(projectData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `scout-project-${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
      
      setLogs(prev => [...prev, {
          id: Date.now().toString(),
          timestamp: new Date().toISOString(),
          source: 'System',
          level: 'info',
          message: 'Project Saved Successfully'
      }]);
  };

  const handleOpenProject = (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (ev) => {
          try {
              const content = ev.target?.result as string;
              const data = JSON.parse(content);
              
              if (!data.iedList || !Array.isArray(data.iedList)) {
                  throw new Error("Invalid project file format: missing iedList");
              }

              // Cleanup current state
              engine.stop();
              iedList.forEach(ied => engine.unregisterDevice(ied.id));

              // Load State
              setIedList(data.iedList);
              setWatchList(data.watchList || []);
              
              // Restore Engine Devices & Data
              initializeSimulation(data.iedList);
              
              // Restore Scripts
              if (data.scripts) {
                  Object.values(data.scripts).forEach((scriptConfig: any) => {
                      engine.updateScriptConfig(scriptConfig);
                  });
              }

              // Reset selection
              if (data.iedList.length > 0) {
                  setSelectedIED(data.iedList[0]);
                  setSelectedNode(data.iedList[0]);
              } else {
                  setSelectedIED(null);
                  setSelectedNode(null);
              }

              setLogs(prev => [...prev, {
                  id: Date.now().toString(),
                  timestamp: new Date().toISOString(),
                  source: 'System',
                  level: 'info',
                  message: `Project Loaded: ${file.name}`
              }]);

          } catch (err: any) {
              setLogs(prev => [...prev, {
                  id: Date.now().toString(),
                  timestamp: new Date().toISOString(),
                  source: 'System',
                  level: 'error',
                  message: `Failed to load project: ${err.message}`
              }]);
              alert(`Failed to load project file: ${err.message}`);
          }
      };
      reader.readAsText(file);
      // Reset input so same file can be selected again
      if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // --- Handlers ---

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
    
    const newData = new Map<string, any>();
    collectDataAttributes(ied, newData);
    engine.initializeData(newData);
    engine.registerDevice(ied.id, ied.name); // Ensure script engine knows about it

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

      engine.unregisterDevice(iedToRemove.id); 
      
      const newList = iedList.filter(i => i.id !== id);
      setIedList(newList);
      
      setLogs(prev => [...prev, {
          id: Date.now().toString(),
          timestamp: new Date().toISOString(),
          source: 'System',
          level: 'warning',
          message: `Device removed: ${iedToRemove.name}`
      }]);

      if (selectedIED?.id === id) {
          const next = newList.length > 0 ? newList[0] : null;
          setSelectedIED(next);
          setSelectedNode(next);
          if (viewMode === 'modbus' || viewMode === 'explorer') {
              if(!next) setViewMode('dashboard');
          }
      }
  };

  const handleDeviceListSelect = (id: string, mode: 'configure' | 'view') => {
      const ied = iedList.find(i => i.id === id);
      if (ied) {
          setSelectedIED(ied);
          setSelectedNode(ied);
          
          if (mode === 'configure' && ied.config?.modbusMap) {
              setViewMode('modbus'); 
          } else if (ied.config?.modbusMap) {
               setViewMode('modbus');
          } else {
               setViewMode('explorer');
          }
      }
  };

  const handleAddToWatch = (item: WatchItem) => {
    setWatchList(prev => {
        if (prev.some(i => i.id === item.id)) return prev;
        
        setLogs(prevLogs => [...prevLogs, {
            id: Date.now().toString(),
            timestamp: new Date().toISOString(),
            source: 'User',
            level: 'info',
            message: `Added to Watch List: ${item.label}`
        }]);
        
        return [...prev, item];
    });
    setRightSidebarOpen(true);
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
        
        const newData = new Map<string, any>();
        collectDataAttributes(parsedIED, newData);
        engine.initializeData(newData);
        engine.registerDevice(parsedIED.id, parsedIED.name);
        
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

        <nav className="flex-1 py-4 space-y-1 px-2 overflow-y-auto">
           <NavItem icon={Icons.Dashboard} label="Dashboard" active={viewMode === 'dashboard'} onClick={() => setViewMode('dashboard')} collapsed={!sidebarOpen} />
           <NavItem icon={Icons.List} label="Device List" active={viewMode === 'devices'} onClick={() => setViewMode('devices')} collapsed={!sidebarOpen} />
           <NavItem icon={Icons.Wifi} label="Network Topology" active={viewMode === 'network'} onClick={() => setViewMode('network')} collapsed={!sidebarOpen} />
           <NavItem icon={Icons.Activity} label="Network Tap" active={viewMode === 'tap'} onClick={() => setViewMode('tap')} collapsed={!sidebarOpen} />
           
           <div className="my-2 border-t border-scada-border/50 mx-2"></div>
           
           <NavItem icon={Icons.Tree} label="IEC 61850 Explorer" active={viewMode === 'explorer'} onClick={() => setViewMode('explorer')} collapsed={!sidebarOpen} />
           <NavItem icon={Icons.Cable} label="Client & Master" active={viewMode === 'client'} onClick={() => setViewMode('client')} collapsed={!sidebarOpen} />
           <NavItem icon={Icons.Settings} label="Device Configurator" active={viewMode === 'config'} onClick={() => setViewMode('config')} collapsed={!sidebarOpen} />
           <NavItem icon={Icons.Database} label="Modbus Slave" active={viewMode === 'modbus'} onClick={() => setViewMode('modbus')} collapsed={!sidebarOpen} />
           <NavItem icon={Icons.Code} label="Logic Editor" active={viewMode === 'logic'} onClick={() => setViewMode('logic')} collapsed={!sidebarOpen} />
        </nav>

        {/* Project Management & Files */}
        <div className="p-4 border-t border-scada-border space-y-3 bg-scada-panel/30">
            {sidebarOpen && <div className="text-[10px] font-bold text-scada-muted uppercase tracking-wider">Project Files</div>}
            
            <div className={`grid ${sidebarOpen ? 'grid-cols-3' : 'grid-cols-1'} gap-2`}>
                <button onClick={handleNewProject} className="flex flex-col items-center justify-center p-2 rounded hover:bg-white/5 text-scada-muted hover:text-white transition-colors bg-scada-bg border border-scada-border hover:border-scada-muted group" title="New Project">
                    <Icons.File className="w-4 h-4 mb-1 group-hover:text-scada-accent" />
                    {sidebarOpen && <span className="text-[9px]">New</span>}
                </button>
                <button onClick={() => fileInputRef.current?.click()} className="flex flex-col items-center justify-center p-2 rounded hover:bg-white/5 text-scada-muted hover:text-white transition-colors bg-scada-bg border border-scada-border hover:border-scada-muted group" title="Open Project">
                    <Icons.Tree className="w-4 h-4 mb-1 group-hover:text-yellow-400" />
                    {sidebarOpen && <span className="text-[9px]">Open</span>}
                </button>
                <button onClick={handleSaveProject} className="flex flex-col items-center justify-center p-2 rounded hover:bg-white/5 text-scada-muted hover:text-white transition-colors bg-scada-bg border border-scada-border hover:border-scada-muted group" title="Save Project">
                    <Icons.Save className="w-4 h-4 mb-1 group-hover:text-scada-success" />
                    {sidebarOpen && <span className="text-[9px]">Save</span>}
                </button>
            </div>
            {/* Hidden Input for Open Project */}
            <input type="file" ref={fileInputRef} className="hidden" accept=".json" onChange={handleOpenProject} />

            <label className={`flex items-center gap-2 text-xs text-scada-muted hover:text-white cursor-pointer transition-colors p-2 rounded hover:bg-white/5 border border-dashed border-scada-border hover:border-scada-accent ${!sidebarOpen ? 'justify-center' : ''}`} title="Import SCL/CID Definition">
                <Icons.Upload className="w-4 h-4" />
                {sidebarOpen && <span>Import SCL/CID</span>}
                <input type="file" className="hidden" accept=".xml,.scd,.cid,.icd" onChange={handleFileUpload} />
            </label>
        </div>

        <div className="p-2 border-t border-scada-border">
            <button onClick={() => setSidebarOpen(!sidebarOpen)} className="w-full flex justify-center p-2 hover:bg-white/5 rounded text-scada-muted">
                <Icons.Activity className={`transition-transform duration-300 ${sidebarOpen ? 'rotate-0' : 'rotate-180'}`} />
            </button>
        </div>
      </div>

      {/* Main Layout Area */}
      <div className="flex-1 flex flex-col h-full relative overflow-hidden">
        
        {/* 2. Top Header */}
        <header className="h-16 border-b border-scada-border bg-scada-panel/50 backdrop-blur flex items-center justify-between px-6 z-20 shrink-0">
            <h1 className="text-lg font-medium text-white/90">
                {viewMode === 'dashboard' && 'System Dashboard'}
                {viewMode === 'devices' && 'All Device Explorer'}
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
                 
                 {/* Right Sidebar Toggle (Watch List) */}
                 <button 
                    onClick={() => setRightSidebarOpen(!rightSidebarOpen)}
                    className={`p-2 rounded-md transition-colors ${rightSidebarOpen ? 'bg-scada-accent/10 text-scada-accent' : 'text-scada-muted hover:bg-white/5'}`}
                    title="Toggle Watch List & AI"
                >
                    <Icons.List className="w-5 h-5" />
                </button>
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
                                {iedList.length === 0 ? (
                                    <option value="">No Devices</option>
                                ) : (
                                    iedList.map(ied => (
                                        <option key={ied.id} value={ied.id}>{ied.name}</option>
                                    ))
                                )}
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

                    {viewMode === 'devices' && (
                        <DeviceList 
                            ieds={iedList} 
                            onSelect={handleDeviceListSelect}
                            onDelete={handleRemoveIED}
                        />
                    )}
                    
                    {viewMode === 'network' && (
                        <NetworkTopology 
                            ieds={iedList} 
                            onSelectIED={handleTopologySelect}
                            onDeleteIED={handleRemoveIED} 
                            simulationTime={simulationTime} 
                        />
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
                            onDeleteNode={handleRemoveIED}
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
                <div className={`${isLogPanelCollapsed ? 'h-12' : 'h-48'} border-t border-scada-border bg-scada-panel z-20 transition-all duration-200 overflow-hidden`}>
                    <LogPanel
                      logs={logs}
                      onClear={() => setLogs([])}
                      isCollapsed={isLogPanelCollapsed}
                      onToggleCollapse={() => setIsLogPanelCollapsed(prev => !prev)}
                    />
                </div>
            </div>

            {/* 4. Right Panel: AI & Watch List (Toggleable Window) */}
            <div className={`border-scada-border bg-scada-panel flex flex-col transition-all duration-300 overflow-hidden relative ${rightSidebarOpen ? 'border-l' : ''}`} style={{ width: rightSidebarOpen ? `${rightSidebarWidth}px` : '0px' }}>
                {rightSidebarOpen && (
                    <div
                        onMouseDown={handleRightSidebarResizeStart}
                        className="absolute left-0 top-0 bottom-0 w-1 -translate-x-1/2 cursor-ew-resize bg-scada-border/40 hover:bg-scada-accent transition-colors z-20"
                        title="Drag to resize right sidebar"
                    />
                )}
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

const App = () => (
  <ErrorBoundary>
    <AppContent />
  </ErrorBoundary>
);

export default App;
