
import React, { useState } from 'react';
import { IEDNode, IEDConfig, NodeType, ModbusRegister, ModbusRegisterType, PollingTask } from '../types';
import { Icons } from './Icons';
import { parseSCL, validateSCL, extractIEDs, extractCommunication } from '../utils/sclParser';
import { generateMockIED } from '../utils/mockGenerator';

interface DeviceConfiguratorProps {
  onSave: (ied: IEDNode) => void;
  onCancel: () => void;
  existingIEDs: IEDNode[];
}

type Step = 'source' | 'configure' | 'network' | 'review';
type ImportMode = 'modbus-slave' | 'modbus-master' | 'modbus-client' | 'scl' | 'demo';

// Helper to increment IP address
const incrementIp = (baseIp: string, offset: number): string => {
    const parts = baseIp.split('.').map(Number);
    if (parts.length !== 4 || parts.some(isNaN)) return baseIp;
    parts[3] = parts[3] + offset; 
    return parts.join('.');
};

// Helper to increment Device Name
const incrementName = (baseName: string, offset: number): string => {
    if (offset === 0) return baseName;
    // If ends in digits, increment them preserving padding
    const match = baseName.match(/(\d+)$/);
    if (match) {
        const numStr = match[1];
        const num = parseInt(numStr, 10) + offset;
        const newNumStr = num.toString().padStart(numStr.length, '0');
        return baseName.slice(0, match.index) + newNumStr;
    }
    // Else append _N
    return `${baseName}_${offset + 1}`;
};

export const DeviceConfigurator: React.FC<DeviceConfiguratorProps> = ({ onSave, onCancel, existingIEDs }) => {
  const [step, setStep] = useState<Step>('source');
  const [importMode, setImportMode] = useState<ImportMode>('modbus-slave');
  const [sclContent, setSclContent] = useState<string>('');
  const [fileName, setFileName] = useState<string>('');
  const [parseError, setParseError] = useState<string | null>(null);
  
  // SCL Import State
  const [availableIEDs, setAvailableIEDs] = useState<{
      name: string; 
      desc: string; 
      manufacturer: string; 
      type: string;
      configVersion: string;
      accessPoints: number;
  }[]>([]);
  const [selectedImportIED, setSelectedImportIED] = useState<string>('');
  const [sclRole, setSclRole] = useState<'server' | 'client'>('server');
  
  // Draft IED State (for SCL)
  const [draftIED, setDraftIED] = useState<IEDNode | null>(null);
  const [selectedLDs, setSelectedLDs] = useState<string[]>([]);

  // Modbus Configuration State
  const [modbusSettings, setModbusSettings] = useState({
      name: 'New_Device_01',
      description: 'Configured Device',
      port: 502,
      unitId: 1
  });
  
  // Dynamic Register Map State (For Slaves)
  const [registers, setRegisters] = useState<ModbusRegister[]>([
      { address: 1, type: 'Coil', value: false, name: 'System Enable', description: 'Master control' },
      { address: 40001, type: 'HoldingRegister', value: 100, name: 'Setpoint A', description: 'Process Setpoint' }
  ]);

  // Dynamic Polling List State (For Masters/Clients)
  const [pollingTasks, setPollingTasks] = useState<PollingTask[]>([]);
  const [newTask, setNewTask] = useState<PollingTask>({
      id: '',
      name: 'Read Status',
      targetIp: '10.0.10.105',
      port: 502,
      unitId: 1,
      functionCode: 3,
      address: 40001,
      count: 10,
      interval: 1000
  });

  // New Register Form State
  const [newReg, setNewReg] = useState<any>({
      address: 40002, type: 'HoldingRegister', value: 0, name: 'New Register', description: ''
  });

  // Network Config State
  const [netConfig, setNetConfig] = useState<IEDConfig>({
    ip: '10.0.10.100', // Default Station Bus IP
    subnet: '255.255.255.0',
    gateway: '10.0.10.1',
    vlan: 10,
    isDHCP: false,
    role: 'server'
  });

  // Bulk Creation State
  const [deviceCount, setDeviceCount] = useState<number>(1);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    setFileName(file.name);
    
    try {
        const text = await file.text();
        const validation = validateSCL(text);
        if (!validation.valid) {
            setParseError(validation.error || "Invalid SCL");
            return;
        }
        setSclContent(text);
        
        // Extract available IEDs
        const ieds = extractIEDs(text);
        setAvailableIEDs(ieds);
        
        // Reset selection on new file upload
        setSelectedImportIED('');
        setDraftIED(null);
        setParseError(null);

        if (ieds.length === 0) {
            setParseError("No IED definitions found in file.");
        }
    } catch (err: any) {
        setParseError(err.message);
    }
  };

  const processSource = () => {
    if (importMode === 'scl') {
        if (!sclContent) {
            setParseError("Please upload a file first.");
            return;
        }
        if (!selectedImportIED) {
            setParseError("Please select an IED to import.");
            return;
        }

        try {
            // Parse Tree
            const ied = parseSCL(sclContent, selectedImportIED);
            setDraftIED(ied);
            
            // Auto-select all LDs
            setSelectedLDs(ied.children?.map(c => c.id) || []);
            
            // Extract Communication Config from SCL if available
            const extractedConfig = extractCommunication(sclContent, selectedImportIED);
            if (extractedConfig) {
                setNetConfig(prev => ({
                    ...prev,
                    ip: extractedConfig.ip || prev.ip,
                    subnet: extractedConfig.subnet || prev.subnet,
                    gateway: extractedConfig.gateway || prev.gateway,
                    role: sclRole // Apply selected role
                }));
            } else {
                setNetConfig(prev => ({ ...prev, role: sclRole }));
            }

            setStep('configure');
        } catch (err: any) {
            setParseError(err.message);
        }
    } else if (importMode === 'demo') {
        // Create Mock IED using generator (includes XCBR with SBO)
        const mockName = `Demo_IED_${Math.floor(Math.random() * 1000)}`;
        const ied = generateMockIED(mockName);
        setDraftIED(ied);
        setSelectedLDs(ied.children?.map(c => c.id) || []);
        // Default demo to Station Bus
        setNetConfig(prev => ({ ...prev, ip: '10.0.10.101', subnet: '255.255.255.0', gateway: '10.0.10.1', vlan: 10, role: 'server' }));
        setStep('configure');
    } else {
        // Modbus Modes
        const defaults = {
            'modbus-slave': { name: 'Modbus_Slave_01', desc: 'Modbus TCP Server', role: 'server' as const },
            'modbus-master': { name: 'Modbus_Master_01', desc: 'Modbus TCP Scanner / Master', role: 'client' as const },
            'modbus-client': { name: 'Modbus_Client_01', desc: 'Modbus TCP Client', role: 'client' as const }
        };
        const def = defaults[importMode as keyof typeof defaults];
        setModbusSettings({
            ...modbusSettings,
            name: def.name,
            description: def.desc
        });
        setNetConfig(prev => ({ ...prev, role: def.role }));
        setStep('configure');
    }
  };

  const handleVlanChange = (newVlan: number) => {
      // Heuristic to update subnet if the user hasn't heavily customized the IP
      // or if they are switching between standard VLANs
      let newIp = netConfig.ip;
      let newGw = netConfig.gateway;
      
      const subnets: Record<number, string> = {
          1: '192.168.1.',
          10: '10.0.10.',
          20: '10.0.20.'
      };

      const currentSubnetBase = subnets[netConfig.vlan];
      const newSubnetBase = subnets[newVlan];

      if (currentSubnetBase && newSubnetBase && netConfig.ip.startsWith(currentSubnetBase)) {
          // Replace base but keep host part
          const hostPart = netConfig.ip.substring(currentSubnetBase.length);
          newIp = newSubnetBase + hostPart;
          newGw = newSubnetBase + '1';
      } else if (newSubnetBase) {
          // Reset to default for that VLAN
          newIp = newSubnetBase + '100';
          newGw = newSubnetBase + '1';
      }

      setNetConfig(prev => ({
          ...prev,
          vlan: newVlan,
          ip: newIp,
          gateway: newGw
      }));
  };

  const toggleLD = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedLDs(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  // Register Map Logic
  const addRegister = () => {
      let val: any = newReg.value;
      if (typeof val === 'string') {
          if (val.toLowerCase() === 'true') val = true;
          else if (val.toLowerCase() === 'false') val = false;
          else val = Number(val) || 0;
      }

      setRegisters(prev => [...prev, { ...newReg, value: val }]);
      setNewReg((prev: any) => ({ ...prev, address: prev.address + 1, name: 'New Register' }));
  };

  const removeRegister = (index: number) => {
      setRegisters(prev => prev.filter((_, i) => i !== index));
  };

  // Polling Task Logic
  const addPollingTask = () => {
      setPollingTasks(prev => [...prev, { ...newTask, id: Date.now().toString() }]);
      setNewTask({ ...newTask, name: 'Read Next Block', address: newTask.address + newTask.count });
  };

  const removePollingTask = (id: string) => {
      setPollingTasks(prev => prev.filter(t => t.id !== id));
  };

  const createModbusIED = (instanceName: string, instanceIp: string, instanceIdx: number): IEDNode => {
      const id = `modbus-${Date.now()}-${instanceIdx}`;
      const isMaster = importMode === 'modbus-master' || importMode === 'modbus-client';
      
      const finalConfig: IEDConfig = {
          ...netConfig,
          ip: instanceIp,
          modbusMap: isMaster ? undefined : registers,
          pollingList: isMaster ? pollingTasks : undefined
      };

      // Create structure children
      const children: IEDNode[] = [];
      if (!isMaster) {
          children.push({
              id: `${id}-ld0`,
              name: 'ModbusMap',
              type: NodeType.LDevice,
              path: `${instanceName}ModbusMap`,
              description: `Port: ${modbusSettings.port}, ID: ${modbusSettings.unitId}`,
              children: [
                  {
                      id: `${id}-ln-holding`,
                      name: 'Registers',
                      type: NodeType.LN,
                      path: `${instanceName}ModbusMap/Registers`,
                      description: `Mapped Registers (${registers.length})`,
                      children: [] 
                  }
              ]
          });
      } else {
          // Master device structure
          children.push({
              id: `${id}-scanner`,
              name: 'Scanner',
              type: NodeType.LDevice,
              path: `${instanceName}/Scanner`,
              description: `Polling Engine (${pollingTasks.length} tasks)`,
              children: []
          });
      }

      return {
          id: id,
          name: instanceName,
          type: NodeType.IED,
          description: modbusSettings.description,
          path: instanceName,
          config: finalConfig,
          children
      };
  };

  const finalize = () => {
    const baseName = (importMode === 'scl' || importMode === 'demo') ? (draftIED?.name || 'Device') : modbusSettings.name;
    const baseIp = netConfig.ip;

    for (let i = 0; i < deviceCount; i++) {
        const instanceName = incrementName(baseName, i);
        const instanceIp = incrementIp(baseIp, i);
        
        let finalIED: IEDNode;

        if (importMode === 'scl' || importMode === 'demo') {
            if (!draftIED) return;
            const filteredChildren = draftIED.children?.filter(c => selectedLDs.includes(c.id)) || [];
            
            // Deep clone to separate instances
            const clonedIED = JSON.parse(JSON.stringify(draftIED));
            clonedIED.id = `imported-${Date.now()}-${i}`;
            clonedIED.name = instanceName;
            clonedIED.path = instanceName;
            clonedIED.config = { ...netConfig, ip: instanceIp };
            clonedIED.description = draftIED.description + (netConfig.role === 'client' ? ' [Client/Remote]' : ' [Server/Simulated]');
            clonedIED.children = filteredChildren;

            // Fix internal paths if name changed (Simple replacement for now)
            // This ensures IEDName/LD/LN paths are consistent with the new device name
            if (instanceName !== draftIED.name) {
                const updatePaths = (nodes: IEDNode[]) => {
                    nodes.forEach(n => {
                        if (n.path) n.path = n.path.replace(draftIED.name, instanceName);
                        if (n.children) updatePaths(n.children);
                    });
                };
                updatePaths(clonedIED.children || []);
            }

            finalIED = clonedIED;
        } else {
            finalIED = createModbusIED(instanceName, instanceIp, i);
        }
        
        onSave(finalIED);
    }
  };

  return (
    <div className="h-full flex flex-col bg-scada-bg text-scada-text animate-in fade-in slide-in-from-bottom-4">
        
        {/* Wizard Header */}
        <div className="p-6 border-b border-scada-border bg-scada-panel/50">
            <div className="flex items-center gap-3 mb-2">
                <Icons.Settings className="w-6 h-6 text-scada-accent" />
                <h2 className="text-2xl font-bold text-white">Device Configuration Wizard</h2>
            </div>
            <div className="flex items-center gap-4 text-sm font-mono mt-4">
                <StepIndicator current={step} target="source" label="1. Source" />
                <div className="w-8 h-px bg-scada-border" />
                <StepIndicator current={step} target="configure" label="2. Configure" />
                <div className="w-8 h-px bg-scada-border" />
                <StepIndicator current={step} target="network" label="3. Network" />
                <div className="w-8 h-px bg-scada-border" />
                <StepIndicator current={step} target="review" label="4. Review" />
            </div>
        </div>

        {/* Wizard Content */}
        <div className="flex-1 p-8 overflow-y-auto max-w-5xl mx-auto w-full">
            
            {/* Step 1: Source */}
            {step === 'source' && (
                <div className="space-y-6">
                    <h3 className="text-lg font-medium text-white border-b border-scada-border pb-2">Select Device Role & Protocol</h3>
                    
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-6">
                        <button 
                            onClick={() => setImportMode('modbus-slave')}
                            className={`p-6 border-2 rounded-xl text-left transition-all ${importMode === 'modbus-slave' ? 'border-scada-accent bg-scada-accent/10' : 'border-scada-border hover:border-scada-muted bg-scada-panel'}`}
                        >
                            <Icons.Database className="w-8 h-8 mb-4 text-yellow-500" />
                            <div className="font-bold text-lg mb-1">Modbus Slave</div>
                            <div className="text-xs text-scada-muted">Configures a TCP Server to expose local registers to other devices.</div>
                        </button>

                        <button 
                            onClick={() => setImportMode('modbus-master')}
                            className={`p-6 border-2 rounded-xl text-left transition-all ${importMode === 'modbus-master' ? 'border-scada-accent bg-scada-accent/10' : 'border-scada-border hover:border-scada-muted bg-scada-panel'}`}
                        >
                            <Icons.ArrowUpRight className="w-8 h-8 mb-4 text-purple-400" />
                            <div className="font-bold text-lg mb-1">Modbus Master</div>
                            <div className="text-xs text-scada-muted">Configures a Scanner to poll multiple slave devices cyclically.</div>
                        </button>

                        <button 
                            onClick={() => setImportMode('modbus-client')}
                            className={`p-6 border-2 rounded-xl text-left transition-all ${importMode === 'modbus-client' ? 'border-scada-accent bg-scada-accent/10' : 'border-scada-border hover:border-scada-muted bg-scada-panel'}`}
                        >
                            <Icons.Cable className="w-8 h-8 mb-4 text-blue-400" />
                            <div className="font-bold text-lg mb-1">Modbus Client</div>
                            <div className="text-xs text-scada-muted">Connects to a single remote server. Similar to Master but focused on peer connection.</div>
                        </button>

                        <button 
                            onClick={() => setImportMode('scl')}
                            className={`p-6 border-2 rounded-xl text-left transition-all ${importMode === 'scl' ? 'border-scada-accent bg-scada-accent/10' : 'border-scada-border hover:border-scada-muted bg-scada-panel'}`}
                        >
                            <Icons.Upload className="w-8 h-8 mb-4 text-scada-success" />
                            <div className="font-bold text-lg mb-1">Import SCL</div>
                            <div className="text-xs text-scada-muted">Parse an existing IEC 61850 configuration file (SCD, CID, ICD).</div>
                        </button>

                        <button 
                            onClick={() => setImportMode('demo')}
                            className={`p-6 border-2 rounded-xl text-left transition-all ${importMode === 'demo' ? 'border-scada-accent bg-scada-accent/10' : 'border-scada-border hover:border-scada-muted bg-scada-panel'}`}
                        >
                            <Icons.Zap className="w-8 h-8 mb-4 text-white" />
                            <div className="font-bold text-lg mb-1">Demo IED</div>
                            <div className="text-xs text-scada-muted">Creates a sample Bay Control Unit with XCBR and protection functions.</div>
                        </button>
                    </div>

                    {importMode === 'scl' && (
                        <div className="mt-8 space-y-4 animate-in fade-in slide-in-from-top-2">
                            {/* ... SCL Upload (Same as before) ... */}
                            <div className="bg-scada-panel p-6 rounded-lg border border-scada-border border-dashed hover:border-scada-accent/50 transition-colors">
                                <div className="flex items-center justify-between">
                                    <div>
                                        <label className="block text-sm font-bold text-white mb-1">SCL Configuration File</label>
                                        <p className="text-xs text-scada-muted">Supports .xml, .scd, .cid, .icd formats</p>
                                    </div>
                                    <label className="cursor-pointer bg-scada-bg border border-scada-border hover:bg-white/5 hover:text-white text-scada-muted px-4 py-2 rounded text-sm font-medium transition-colors flex items-center gap-2">
                                        <Icons.Upload className="w-4 h-4" />
                                        {fileName ? 'Change File' : 'Select File'}
                                        <input type="file" className="hidden" accept=".xml,.scd,.cid,.icd" onChange={handleFileUpload} />
                                    </label>
                                </div>
                                {fileName && (
                                    <div className="mt-4 flex items-center gap-2 text-sm bg-scada-bg/50 p-2 rounded border border-scada-border">
                                        <Icons.FileText className="w-4 h-4 text-scada-accent" />
                                        <span className="text-gray-200">{fileName}</span>
                                        <span className="text-scada-muted text-xs">({(sclContent.length / 1024).toFixed(1)} KB)</span>
                                        {!parseError && <Icons.CheckCircle className="w-4 h-4 text-scada-success ml-auto" />}
                                    </div>
                                )}
                                {parseError && <div className="mt-4 text-scada-danger text-sm flex items-center gap-2"><Icons.Alert className="w-4 h-4"/> {parseError}</div>}
                            </div>

                            {/* IED Selection Grid */}
                            {availableIEDs.length > 0 && (
                                <div className="mt-6">
                                    <h4 className="text-sm font-bold text-scada-muted uppercase mb-3 flex items-center gap-2">
                                        <Icons.Search className="w-4 h-4" /> Detected Devices ({availableIEDs.length})
                                    </h4>
                                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 max-h-[400px] overflow-y-auto pr-2">
                                        {availableIEDs.map(ied => (
                                            <div 
                                                key={ied.name}
                                                onClick={() => setSelectedImportIED(ied.name)}
                                                className={`
                                                    p-4 rounded-lg border cursor-pointer transition-all relative group
                                                    ${selectedImportIED === ied.name 
                                                        ? 'bg-scada-accent/10 border-scada-accent shadow-[0_0_15px_rgba(6,182,212,0.2)]' 
                                                        : 'bg-scada-panel border-scada-border hover:bg-white/5 hover:border-scada-muted'}
                                                `}
                                            >
                                                <div className="flex justify-between items-start mb-2">
                                                    <div className={`p-2 rounded-lg ${selectedImportIED === ied.name ? 'bg-scada-accent text-white' : 'bg-scada-bg text-scada-muted'}`}>
                                                        <Icons.Server className="w-5 h-5" />
                                                    </div>
                                                    {selectedImportIED === ied.name && (
                                                        <div className="w-2 h-2 rounded-full bg-scada-accent shadow-[0_0_5px_currentColor]" />
                                                    )}
                                                </div>
                                                <h5 className="font-bold text-white truncate" title={ied.name}>{ied.name}</h5>
                                                <p className="text-xs text-scada-muted mt-1 truncate">{ied.desc || 'No description'}</p>
                                                
                                                {/* Detailed Metadata Grid */}
                                                <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] text-gray-400 font-mono">
                                                    <div className="flex items-center gap-1" title="Manufacturer"><Icons.Cpu className="w-3 h-3"/> {ied.manufacturer}</div>
                                                    <div className="flex items-center gap-1" title="Device Type"><Icons.Box className="w-3 h-3"/> {ied.type}</div>
                                                    <div className="flex items-center gap-1" title="Access Points"><Icons.Wifi className="w-3 h-3"/> {ied.accessPoints} APs</div>
                                                    <div className="flex items-center gap-1" title="Config Version"><Icons.FileText className="w-3 h-3"/> v{ied.configVersion || '1.0'}</div>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                    
                                    {/* Role Selection after IED is picked */}
                                    {selectedImportIED && (
                                        <div className="mt-6 p-4 bg-scada-panel border border-scada-border rounded-lg animate-in slide-in-from-top-2">
                                            <h4 className="text-sm font-bold text-white uppercase mb-3 flex items-center gap-2">
                                                <Icons.Settings className="w-4 h-4 text-scada-accent" /> Role Configuration
                                            </h4>
                                            <div className="grid grid-cols-2 gap-4">
                                                <label 
                                                    className={`
                                                        p-3 border rounded-lg cursor-pointer transition-all flex items-center gap-3
                                                        ${sclRole === 'server' ? 'bg-scada-accent/20 border-scada-accent' : 'bg-scada-bg border-scada-border hover:border-scada-muted'}
                                                    `}
                                                >
                                                    <input type="radio" name="role" value="server" checked={sclRole === 'server'} onChange={() => setSclRole('server')} className="hidden"/>
                                                    <div className="p-2 bg-scada-panel rounded border border-scada-border">
                                                        <Icons.Server className={`w-5 h-5 ${sclRole === 'server' ? 'text-scada-accent' : 'text-scada-muted'}`} />
                                                    </div>
                                                    <div>
                                                        <div className="font-bold text-sm text-white">Server (Simulate)</div>
                                                        <div className="text-xs text-scada-muted">Host this Data Model locally and simulate values.</div>
                                                    </div>
                                                </label>

                                                <label 
                                                    className={`
                                                        p-3 border rounded-lg cursor-pointer transition-all flex items-center gap-3
                                                        ${sclRole === 'client' ? 'bg-scada-accent/20 border-scada-accent' : 'bg-scada-bg border-scada-border hover:border-scada-muted'}
                                                    `}
                                                >
                                                    <input type="radio" name="role" value="client" checked={sclRole === 'client'} onChange={() => setSclRole('client')} className="hidden"/>
                                                    <div className="p-2 bg-scada-panel rounded border border-scada-border">
                                                        <Icons.Cable className={`w-5 h-5 ${sclRole === 'client' ? 'text-blue-400' : 'text-scada-muted'}`} />
                                                    </div>
                                                    <div>
                                                        <div className="font-bold text-sm text-white">Client (Connect)</div>
                                                        <div className="text-xs text-scada-muted">Connect to the physical device IP and read DA values.</div>
                                                    </div>
                                                </label>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}

            {/* Step 2: Configure (Preview) */}
            {step === 'configure' && (
                <div className="space-y-6">
                    {/* ... (Existing Config Step Logic - No Changes) ... */}
                    {importMode !== 'scl' && importMode !== 'demo' ? (
                         <>
                            <h3 className="text-lg font-medium text-white border-b border-scada-border pb-2">Device Parameters</h3>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                {/* ... existing modbus fields ... */}
                                <div className="space-y-2">
                                    <label className="text-sm font-bold text-scada-muted">Device Name</label>
                                    <input 
                                        type="text" value={modbusSettings.name} 
                                        onChange={e => setModbusSettings({...modbusSettings, name: e.target.value})}
                                        className="w-full bg-scada-panel border border-scada-border rounded p-2 text-white focus:border-scada-accent outline-none font-mono"
                                    />
                                </div>
                                <div className="space-y-2">
                                    <label className="text-sm font-bold text-scada-muted">Description</label>
                                    <input 
                                        type="text" value={modbusSettings.description} 
                                        onChange={e => setModbusSettings({...modbusSettings, description: e.target.value})}
                                        className="w-full bg-scada-panel border border-scada-border rounded p-2 text-white focus:border-scada-accent outline-none font-mono"
                                    />
                                </div>
                                {importMode === 'modbus-slave' && (
                                    <>
                                        <div className="space-y-2">
                                            <label className="text-sm font-bold text-scada-muted">Listen Port</label>
                                            <input 
                                                type="number" value={modbusSettings.port} 
                                                onChange={e => setModbusSettings({...modbusSettings, port: parseInt(e.target.value)})}
                                                className="w-full bg-scada-panel border border-scada-border rounded p-2 text-white focus:border-scada-accent outline-none font-mono"
                                            />
                                        </div>
                                        <div className="space-y-2">
                                            <label className="text-sm font-bold text-scada-muted">Unit ID (Slave ID)</label>
                                            <input 
                                                type="number" value={modbusSettings.unitId} 
                                                onChange={e => setModbusSettings({...modbusSettings, unitId: parseInt(e.target.value)})}
                                                className="w-full bg-scada-panel border border-scada-border rounded p-2 text-white focus:border-scada-accent outline-none font-mono"
                                            />
                                        </div>
                                    </>
                                )}
                            </div>

                            {/* ... Modbus Editors ... */}
                            {importMode === 'modbus-slave' && (
                                <>
                                    <h3 className="text-lg font-medium text-white border-b border-scada-border pb-2 mt-4">Local Register Map</h3>
                                    
                                    <div className="bg-scada-panel/50 p-4 rounded border border-scada-border flex flex-wrap gap-4 items-end">
                                        {/* ... (Register Inputs) ... */}
                                        <div className="flex-1 min-w-[120px]">
                                            <label className="text-xs font-bold text-scada-muted uppercase">Type</label>
                                            <select 
                                                value={newReg.type} 
                                                onChange={e => setNewReg({...newReg, type: e.target.value as ModbusRegisterType})}
                                                className="w-full bg-scada-bg border border-scada-border rounded p-2 text-sm"
                                            >
                                                <option value="Coil">Coil (0x)</option>
                                                <option value="DiscreteInput">Discrete Input (1x)</option>
                                                <option value="InputRegister">Input Register (3x)</option>
                                                <option value="HoldingRegister">Holding Register (4x)</option>
                                            </select>
                                        </div>
                                        <div className="flex-1 min-w-[80px]">
                                            <label className="text-xs font-bold text-scada-muted uppercase">Address</label>
                                            <input type="number" value={newReg.address} onChange={e => setNewReg({...newReg, address: parseInt(e.target.value)})} className="w-full bg-scada-bg border border-scada-border rounded p-2 text-sm" />
                                        </div>
                                        <div className="flex-[2] min-w-[150px]">
                                            <label className="text-xs font-bold text-scada-muted uppercase">Name</label>
                                            <input type="text" value={newReg.name} onChange={e => setNewReg({...newReg, name: e.target.value})} className="w-full bg-scada-bg border border-scada-border rounded p-2 text-sm" />
                                        </div>
                                        <div className="flex-1 min-w-[80px]">
                                            <label className="text-xs font-bold text-scada-muted uppercase">Value</label>
                                            <input type="text" value={String(newReg.value)} onChange={e => setNewReg({...newReg, value: e.target.value})} className="w-full bg-scada-bg border border-scada-border rounded p-2 text-sm" />
                                        </div>
                                        <button onClick={addRegister} className="px-4 py-2 bg-scada-accent text-white rounded font-bold hover:bg-cyan-600 text-sm">
                                            <Icons.Box className="w-4 h-4" /> Add
                                        </button>
                                    </div>

                                    <div className="border border-scada-border rounded overflow-hidden max-h-64 overflow-y-auto">
                                        <table className="w-full text-sm text-left">
                                            <thead className="bg-scada-panel text-scada-muted text-xs uppercase font-mono sticky top-0">
                                                <tr>
                                                    <th className="px-4 py-2">Type</th>
                                                    <th className="px-4 py-2">Addr</th>
                                                    <th className="px-4 py-2">Name</th>
                                                    <th className="px-4 py-2">Init Value</th>
                                                    <th className="px-4 py-2 w-10"></th>
                                                </tr>
                                            </thead>
                                            <tbody className="divide-y divide-scada-border/30">
                                                {registers.length === 0 && <tr><td colSpan={5} className="text-center py-4 text-scada-muted">No registers defined</td></tr>}
                                                {registers.map((reg, i) => (
                                                    <tr key={i} className="hover:bg-white/5">
                                                        <td className="px-4 py-2">{reg.type}</td>
                                                        <td className="px-4 py-2 font-mono">{reg.address}</td>
                                                        <td className="px-4 py-2">{reg.name}</td>
                                                        <td className="px-4 py-2 font-mono">{String(reg.value)}</td>
                                                        <td className="px-4 py-2">
                                                            <button onClick={() => removeRegister(i)} className="text-scada-danger hover:text-red-400">
                                                                <Icons.Trash className="w-3 h-3" />
                                                            </button>
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                </>
                            )}

                            {/* --- Master/Client: Polling List Editor --- */}
                            {(importMode === 'modbus-master' || importMode === 'modbus-client') && (
                                <>
                                    <h3 className="text-lg font-medium text-white border-b border-scada-border pb-2 mt-4">Polling Configuration</h3>
                                    
                                    <div className="bg-scada-panel/50 p-4 rounded border border-scada-border grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
                                        <div className="col-span-1">
                                            <label className="text-xs font-bold text-scada-muted uppercase">Task Name</label>
                                            <input type="text" value={newTask.name} onChange={e => setNewTask({...newTask, name: e.target.value})} className="w-full bg-scada-bg border border-scada-border rounded p-2 text-sm" />
                                        </div>
                                        <div className="col-span-1">
                                            <label className="text-xs font-bold text-scada-muted uppercase">Target IP</label>
                                            <input type="text" value={newTask.targetIp} onChange={e => setNewTask({...newTask, targetIp: e.target.value})} className="w-full bg-scada-bg border border-scada-border rounded p-2 text-sm font-mono" />
                                        </div>
                                        <div className="grid grid-cols-2 gap-2">
                                            <div>
                                                <label className="text-xs font-bold text-scada-muted uppercase">Func</label>
                                                <select value={newTask.functionCode} onChange={e => setNewTask({...newTask, functionCode: parseInt(e.target.value)})} className="w-full bg-scada-bg border border-scada-border rounded p-2 text-sm">
                                                    <option value="1">01 (Coils)</option>
                                                    <option value="2">02 (Disc)</option>
                                                    <option value="3">03 (Hold)</option>
                                                    <option value="4">04 (Input)</option>
                                                </select>
                                            </div>
                                            <div>
                                                <label className="text-xs font-bold text-scada-muted uppercase">Addr</label>
                                                <input type="number" value={newTask.address} onChange={e => setNewTask({...newTask, address: parseInt(e.target.value)})} className="w-full bg-scada-bg border border-scada-border rounded p-2 text-sm" />
                                            </div>
                                        </div>
                                        <div className="grid grid-cols-2 gap-2">
                                            <div>
                                                <label className="text-xs font-bold text-scada-muted uppercase">Count</label>
                                                <input type="number" value={newTask.count} onChange={e => setNewTask({...newTask, count: parseInt(e.target.value)})} className="w-full bg-scada-bg border border-scada-border rounded p-2 text-sm" />
                                            </div>
                                            <button onClick={addPollingTask} className="px-4 py-2 bg-scada-accent text-white rounded font-bold hover:bg-cyan-600 text-sm h-[38px]">
                                                <Icons.Box className="w-4 h-4" /> Add
                                            </button>
                                        </div>
                                    </div>

                                    <div className="border border-scada-border rounded overflow-hidden max-h-64 overflow-y-auto">
                                        <table className="w-full text-sm text-left">
                                            <thead className="bg-scada-panel text-scada-muted text-xs uppercase font-mono sticky top-0">
                                                <tr>
                                                    <th className="px-4 py-2">Task</th>
                                                    <th className="px-4 py-2">Target</th>
                                                    <th className="px-4 py-2">Function</th>
                                                    <th className="px-4 py-2">Range</th>
                                                    <th className="px-4 py-2">Interval</th>
                                                    <th className="px-4 py-2 w-10"></th>
                                                </tr>
                                            </thead>
                                            <tbody className="divide-y divide-scada-border/30">
                                                {pollingTasks.length === 0 && <tr><td colSpan={6} className="text-center py-4 text-scada-muted">No polling tasks defined</td></tr>}
                                                {pollingTasks.map((task) => (
                                                    <tr key={task.id} className="hover:bg-white/5">
                                                        <td className="px-4 py-2 font-bold">{task.name}</td>
                                                        <td className="px-4 py-2 font-mono text-scada-accent">{task.targetIp}</td>
                                                        <td className="px-4 py-2">FC: {task.functionCode}</td>
                                                        <td className="px-4 py-2 font-mono">{task.address} (x{task.count})</td>
                                                        <td className="px-4 py-2 text-xs text-scada-muted">{task.interval}ms</td>
                                                        <td className="px-4 py-2">
                                                            <button onClick={() => removePollingTask(task.id)} className="text-scada-danger hover:text-red-400">
                                                                <Icons.Trash className="w-3 h-3" />
                                                            </button>
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                </>
                            )}
                         </>
                    ) : (
                        draftIED && (
                            <>
                                {/* SCL / Demo Preview Logic */}
                                <h3 className="text-lg font-medium text-white border-b border-scada-border pb-2 flex items-center justify-between">
                                    <span>Import Preview: {draftIED.name}</span>
                                    <div className="flex items-center gap-2">
                                        <span className={`px-2 py-0.5 rounded-full text-xs uppercase font-bold border ${netConfig.role === 'client' ? 'text-blue-400 border-blue-400 bg-blue-400/10' : 'text-scada-accent border-scada-accent bg-scada-accent/10'}`}>
                                            {netConfig.role === 'client' ? 'Client / Remote' : 'Server / Simulated'}
                                        </span>
                                    </div>
                                </h3>
                                
                                <div className="space-y-4">
                                    <div className="p-3 bg-scada-accent/10 border border-scada-accent/20 rounded text-sm text-scada-accent flex items-center gap-2">
                                        <Icons.Filter className="w-4 h-4" />
                                        Select the Logical Devices (LDs) you wish to include in this import.
                                    </div>

                                    <div className="border border-scada-border rounded-lg bg-scada-panel overflow-hidden">
                                        {draftIED.children?.map(ld => {
                                            const isSelected = selectedLDs.includes(ld.id);
                                            return (
                                                <div key={ld.id} className="border-b border-scada-border last:border-0">
                                                    <div 
                                                        onClick={(e) => toggleLD(ld.id, e)} 
                                                        className={`p-3 flex items-center justify-between cursor-pointer transition-colors ${isSelected ? 'bg-white/5' : 'hover:bg-white/5 opacity-75'}`}
                                                    >
                                                        <div className="flex items-center gap-3">
                                                            <div className={`w-5 h-5 rounded border flex items-center justify-center transition-colors ${isSelected ? 'bg-scada-accent border-scada-accent' : 'border-scada-muted bg-scada-bg'}`}>
                                                                {isSelected && <Icons.CheckCircle className="w-3 h-3 text-white" />}
                                                            </div>
                                                            <div>
                                                                <div className={`font-bold flex items-center gap-2 ${isSelected ? 'text-white' : 'text-scada-muted'}`}>
                                                                    <Icons.Cpu className="w-4 h-4" />
                                                                    {ld.name}
                                                                </div>
                                                                <div className="text-xs text-scada-muted font-mono">{ld.description || 'Logical Device'}</div>
                                                            </div>
                                                        </div>
                                                        <div className="text-xs text-scada-muted">
                                                            {ld.children?.length || 0} LNs
                                                        </div>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            </>
                        )
                    )}
                </div>
            )}

            {/* Step 3: Network */}
            {step === 'network' && (
                <div className="space-y-6">
                    <h3 className="text-lg font-medium text-white border-b border-scada-border pb-2">
                        {netConfig.role === 'client' ? 'Remote Connection Settings' : 'Network Configuration'}
                    </h3>
                    
                    <div className="grid grid-cols-2 gap-6">
                         <div className="space-y-2">
                            <label className="text-sm font-bold text-scada-muted">IP Address</label>
                            <input 
                                type="text" value={netConfig.ip} 
                                onChange={e => setNetConfig({...netConfig, ip: e.target.value})}
                                className="w-full bg-scada-panel border border-scada-border rounded p-2 text-white focus:border-scada-accent outline-none font-mono"
                            />
                         </div>
                         <div className="space-y-2">
                            <label className="text-sm font-bold text-scada-muted">Subnet Mask</label>
                            <input 
                                type="text" value={netConfig.subnet} 
                                onChange={e => setNetConfig({...netConfig, subnet: e.target.value})}
                                className="w-full bg-scada-panel border border-scada-border rounded p-2 text-white focus:border-scada-accent outline-none font-mono"
                            />
                         </div>
                         <div className="space-y-2">
                            <label className="text-sm font-bold text-scada-muted">Default Gateway</label>
                            <input 
                                type="text" value={netConfig.gateway} 
                                onChange={e => setNetConfig({...netConfig, gateway: e.target.value})}
                                className="w-full bg-scada-panel border border-scada-border rounded p-2 text-white focus:border-scada-accent outline-none font-mono"
                            />
                         </div>
                         <div className="space-y-2">
                            <label className="text-sm font-bold text-scada-muted">VLAN ID</label>
                             <select 
                                value={netConfig.vlan} 
                                onChange={e => handleVlanChange(parseInt(e.target.value))}
                                className="w-full bg-scada-panel border border-scada-border rounded p-2 text-white focus:border-scada-accent outline-none font-mono"
                            >
                                <option value="1">VLAN 1 (Management)</option>
                                <option value="10">VLAN 10 (Station Bus)</option>
                                <option value="20">VLAN 20 (Process Bus)</option>
                            </select>
                         </div>
                    </div>
                    
                    <div className="flex items-center gap-2 mt-4">
                        <input type="checkbox" checked={netConfig.isDHCP} onChange={e => setNetConfig({...netConfig, isDHCP: e.target.checked})} id="dhcp" className="rounded bg-scada-panel border-scada-border text-scada-accent"/>
                        <label htmlFor="dhcp" className="text-sm text-scada-muted cursor-pointer">Enable DHCP (Dynamic Assignment)</label>
                    </div>

                    <div className="border-t border-scada-border pt-4 mt-6">
                        <h4 className="text-sm font-bold text-white mb-3 flex items-center gap-2">
                            <Icons.Box className="w-4 h-4 text-yellow-400" /> Bulk Creation Options
                        </h4>
                        <div className="p-4 bg-scada-panel/30 border border-scada-border rounded-lg flex items-center gap-6">
                            <div>
                                <label className="text-xs font-bold text-scada-muted uppercase block mb-1">Instance Count</label>
                                <input 
                                    type="number" 
                                    min="1" max="50" 
                                    value={deviceCount} 
                                    onChange={(e) => setDeviceCount(Math.max(1, Math.min(50, parseInt(e.target.value) || 1)))}
                                    className="w-24 bg-scada-bg border border-scada-border rounded p-2 text-white font-mono focus:border-scada-accent outline-none text-center"
                                />
                            </div>
                            <div className="flex-1 border-l border-scada-border pl-6">
                                <div className="text-xs text-scada-muted uppercase font-bold mb-1">IP Allocation Preview</div>
                                <div className="font-mono text-sm text-scada-accent">
                                    {netConfig.ip} <span className="text-scada-muted">→</span> {incrementIp(netConfig.ip, deviceCount - 1)}
                                </div>
                                <div className="text-xs text-scada-muted mt-1">
                                    Creating {deviceCount} unique devices with incremented IP addresses and names.
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Step 4: Review */}
            {step === 'review' && (
                 <div className="space-y-6">
                    <h3 className="text-lg font-medium text-white border-b border-scada-border pb-2">Configuration Summary</h3>
                    
                    <div className="bg-scada-panel rounded-lg border border-scada-border p-6 space-y-4">
                        <div className="flex justify-between items-center border-b border-scada-border pb-4">
                            <div>
                                <div className="text-sm text-scada-muted uppercase">Device Name</div>
                                <div className="text-xl font-bold text-scada-accent">
                                    {importMode === 'scl' || importMode === 'demo' ? draftIED?.name : modbusSettings.name}
                                </div>
                            </div>
                            <div className="text-right">
                                <div className="text-sm text-scada-muted uppercase">Type</div>
                                <div className="font-mono uppercase">{importMode.replace(/-/g, ' ')}</div>
                            </div>
                        </div>
                        
                        <div className="grid grid-cols-2 gap-4">
                             <div>
                                <div className="text-xs text-scada-muted uppercase mb-1">Network Interface</div>
                                <div className="font-mono text-sm">
                                    IP: <span className="text-white">{netConfig.ip}</span><br/>
                                    Mask: <span className="text-gray-400">{netConfig.subnet}</span><br/>
                                    VLAN: <span className="text-yellow-400">{netConfig.vlan}</span>
                                </div>
                             </div>
                             <div>
                                <div className="text-xs text-scada-muted uppercase mb-1">Details</div>
                                <div className="font-mono text-sm">
                                    {importMode === 'modbus-slave' && (
                                        <>
                                            Port: {modbusSettings.port}<br/>
                                            Unit ID: {modbusSettings.unitId}<br/>
                                            Regs: {registers.length}
                                        </>
                                    )}
                                    {(importMode === 'modbus-master' || importMode === 'modbus-client') && (
                                        <>
                                            Polling Tasks: {pollingTasks.length}<br/>
                                            Status: Active Scanner
                                        </>
                                    )}
                                    {(importMode === 'scl' || importMode === 'demo') && (
                                        <>
                                            {selectedLDs.length} Logical Devices<br/>
                                            {draftIED?.children?.filter(c => selectedLDs.includes(c.id)).reduce((acc, curr) => acc + (curr.children?.length || 0), 0)} Logical Nodes<br/>
                                            Role: <span className={netConfig.role === 'client' ? 'text-blue-400 font-bold' : 'text-scada-success font-bold'}>
                                                {netConfig.role === 'client' ? 'CLIENT (Remote)' : 'SERVER (Simulated)'}
                                            </span>
                                        </>
                                    )}
                                </div>
                             </div>
                        </div>

                        {deviceCount > 1 && (
                            <div className="mt-4 p-3 bg-blue-500/10 border border-blue-500/30 rounded flex items-center gap-3">
                                <div className="p-2 bg-blue-500/20 rounded-full text-blue-400">
                                    <Icons.Box className="w-5 h-5" />
                                </div>
                                <div>
                                    <div className="font-bold text-white text-sm">Bulk Creation Active</div>
                                    <div className="text-xs text-gray-300">
                                        Generating <span className="text-white font-mono font-bold">{deviceCount}</span> instances. 
                                        Names will be suffixed (e.g., _01, _02) and IPs incremented.
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                 </div>
            )}

        </div>

        {/* Footer Actions */}
        <div className="p-6 border-t border-scada-border bg-scada-panel/50 flex justify-between">
            <button onClick={onCancel} className="px-6 py-2 rounded text-scada-muted hover:text-white transition-colors">Cancel</button>
            
            <div className="flex gap-3">
                {step !== 'source' && (
                    <button onClick={() => setStep(prev => prev === 'review' ? 'network' : prev === 'network' ? 'configure' : 'source')} className="px-6 py-2 border border-scada-border rounded hover:bg-white/5 transition-colors">
                        Back
                    </button>
                )}
                
                {step !== 'review' ? (
                    <button 
                        onClick={() => {
                            if (step === 'source') processSource();
                            else if (step === 'configure') setStep('network');
                            else if (step === 'network') setStep('review');
                        }}
                        disabled={importMode === 'scl' && step === 'source' && !selectedImportIED}
                        className="px-6 py-2 bg-scada-accent text-white rounded font-medium hover:bg-cyan-600 transition-colors shadow-lg shadow-cyan-900/20 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        Next Step
                    </button>
                ) : (
                    <button 
                        onClick={finalize}
                        className="px-8 py-2 bg-scada-success text-white rounded font-medium hover:bg-emerald-600 transition-colors shadow-lg shadow-emerald-900/20 flex items-center gap-2"
                    >
                        <Icons.Run className="w-4 h-4" /> {deviceCount > 1 ? `Deploy ${deviceCount} Devices` : 'Deploy Device'}
                    </button>
                )}
            </div>
        </div>
    </div>
  );
};

const StepIndicator = ({ current, target, label }: { current: Step, target: Step, label: string }) => {
    const steps: Step[] = ['source', 'configure', 'network', 'review'];
    const currentIndex = steps.indexOf(current);
    const targetIndex = steps.indexOf(target);
    const isCompleted = currentIndex > targetIndex;
    const isActive = current === target;

    return (
        <div className={`flex items-center gap-2 transition-colors ${isActive ? 'text-scada-accent font-bold' : isCompleted ? 'text-scada-success' : 'text-scada-muted'}`}>
            <div className={`w-2 h-2 rounded-full ${isActive ? 'bg-scada-accent' : isCompleted ? 'bg-scada-success' : 'bg-scada-border'}`} />
            <span>{label}</span>
        </div>
    );
};
