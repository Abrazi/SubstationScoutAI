import React, { useState } from 'react';
import { IEDNode, IEDConfig, NodeType, ModbusRegister, ModbusRegisterType } from '../types';
import { Icons } from './Icons';
import { parseSCL, validateSCL, extractIEDs } from '../utils/sclParser';

interface DeviceConfiguratorProps {
  onSave: (ied: IEDNode) => void;
  onCancel: () => void;
  existingIEDs: IEDNode[];
}

type Step = 'source' | 'configure' | 'network' | 'review';

export const DeviceConfigurator: React.FC<DeviceConfiguratorProps> = ({ onSave, onCancel, existingIEDs }) => {
  const [step, setStep] = useState<Step>('source');
  const [importMode, setImportMode] = useState<'modbus' | 'scl'>('modbus');
  const [sclContent, setSclContent] = useState<string>('');
  const [fileName, setFileName] = useState<string>('');
  const [parseError, setParseError] = useState<string | null>(null);
  
  // SCL Import State
  const [availableIEDs, setAvailableIEDs] = useState<{name: string, desc: string, manufacturer: string}[]>([]);
  const [selectedImportIED, setSelectedImportIED] = useState<string>('');
  
  // Draft IED State (for SCL)
  const [draftIED, setDraftIED] = useState<IEDNode | null>(null);
  const [selectedLDs, setSelectedLDs] = useState<string[]>([]);

  // Modbus Configuration State
  const [modbusSettings, setModbusSettings] = useState({
      name: 'Modbus_Device_01',
      description: 'Generic Modbus TCP Slave',
      port: 502,
      unitId: 1
  });
  
  // Dynamic Register Map State
  const [registers, setRegisters] = useState<ModbusRegister[]>([
      { address: 1, type: 'Coil', value: false, name: 'System Enable', description: 'Master control' },
      { address: 40001, type: 'HoldingRegister', value: 100, name: 'Setpoint A', description: 'Process Setpoint' }
  ]);

  // New Register Form State
  const [newReg, setNewReg] = useState<any>({
      address: 40002, type: 'HoldingRegister', value: 0, name: 'New Register', description: ''
  });

  // Network Config State
  const [netConfig, setNetConfig] = useState<IEDConfig>({
    ip: '192.168.1.100',
    subnet: '255.255.255.0',
    gateway: '192.168.1.1',
    vlan: 10,
    isDHCP: false
  });

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
    if (importMode === 'modbus') {
        setStep('configure');
    } else {
        if (!sclContent) {
            setParseError("Please upload a file first.");
            return;
        }
        if (!selectedImportIED) {
            setParseError("Please select an IED to import.");
            return;
        }

        try {
            const ied = parseSCL(sclContent, selectedImportIED);
            setDraftIED(ied);
            // Default to selecting all LDs
            setSelectedLDs(ied.children?.map(c => c.id) || []);
            setStep('configure');
        } catch (err: any) {
            setParseError(err.message);
        }
    }
  };

  const toggleLD = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedLDs(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

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

  const createModbusIED = (): IEDNode => {
      const id = `modbus-${Date.now()}`;
      const finalConfig: IEDConfig = {
          ...netConfig,
          modbusMap: registers
      };

      return {
          id: id,
          name: modbusSettings.name,
          type: NodeType.IED,
          description: modbusSettings.description,
          path: modbusSettings.name,
          config: finalConfig,
          children: [
              {
                  id: `${id}-ld0`,
                  name: 'ModbusMap',
                  type: NodeType.LDevice,
                  path: `${modbusSettings.name}ModbusMap`,
                  description: `Port: ${modbusSettings.port}, ID: ${modbusSettings.unitId}`,
                  children: [
                      {
                          id: `${id}-ln-holding`,
                          name: 'Registers',
                          type: NodeType.LN,
                          path: `${modbusSettings.name}ModbusMap/Registers`,
                          description: `Mapped Registers (${registers.length})`,
                          children: [] 
                      }
                  ]
              }
          ]
      };
  };

  const finalize = () => {
    let finalIED: IEDNode;

    if (importMode === 'modbus') {
        finalIED = createModbusIED();
    } else {
        if (!draftIED) return;
        const filteredChildren = draftIED.children?.filter(c => selectedLDs.includes(c.id)) || [];
        
        finalIED = {
            ...draftIED,
            children: filteredChildren,
            config: netConfig
        };
    }
    
    onSave(finalIED);
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
                    <h3 className="text-lg font-medium text-white border-b border-scada-border pb-2">Select Device Source</h3>
                    
                    <div className="grid grid-cols-2 gap-6">
                        <button 
                            onClick={() => setImportMode('modbus')}
                            className={`p-6 border-2 rounded-xl text-left transition-all ${importMode === 'modbus' ? 'border-scada-accent bg-scada-accent/10' : 'border-scada-border hover:border-scada-muted bg-scada-panel'}`}
                        >
                            <Icons.Database className="w-8 h-8 mb-4 text-yellow-500" />
                            <div className="font-bold text-lg mb-1">Modbus Slave Device</div>
                            <div className="text-sm text-scada-muted">Configure a new Modbus TCP server/slave device with register mapping.</div>
                        </button>

                        <button 
                            onClick={() => setImportMode('scl')}
                            className={`p-6 border-2 rounded-xl text-left transition-all ${importMode === 'scl' ? 'border-scada-accent bg-scada-accent/10' : 'border-scada-border hover:border-scada-muted bg-scada-panel'}`}
                        >
                            <Icons.Upload className="w-8 h-8 mb-4 text-scada-success" />
                            <div className="font-bold text-lg mb-1">Import SCL/CID File</div>
                            <div className="text-sm text-scada-muted">Parse an existing IEC 61850 configuration file (SCD, CID, ICD).</div>
                        </button>
                    </div>

                    {importMode === 'scl' && (
                        <div className="mt-8 space-y-4 animate-in fade-in slide-in-from-top-2">
                            
                            {/* File Upload Area */}
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
                                                <div className="mt-3 flex items-center gap-2 text-[10px] text-gray-400 font-mono">
                                                    <Icons.Cpu className="w-3 h-3" />
                                                    <span>{ied.manufacturer || 'Unknown Mfg'}</span>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}

            {/* Step 2: Configure (Preview) */}
            {step === 'configure' && (
                <div className="space-y-6">
                    {importMode === 'modbus' ? (
                         <>
                            <h3 className="text-lg font-medium text-white border-b border-scada-border pb-2">Modbus Slave Settings</h3>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
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
                                <div className="space-y-2">
                                    <label className="text-sm font-bold text-scada-muted">TCP Port</label>
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
                            </div>

                            <h3 className="text-lg font-medium text-white border-b border-scada-border pb-2 mt-4">Register Map</h3>
                            
                            {/* Add Register Form */}
                            <div className="bg-scada-panel/50 p-4 rounded border border-scada-border flex flex-wrap gap-4 items-end">
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

                            {/* Register List */}
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
                    ) : (
                        draftIED && (
                            <>
                                <h3 className="text-lg font-medium text-white border-b border-scada-border pb-2 flex items-center justify-between">
                                    <span>Import Preview: {draftIED.name}</span>
                                    <span className="text-xs font-normal text-scada-muted font-mono">{draftIED.description}</span>
                                </h3>
                                
                                <div className="space-y-4">
                                    <div className="p-3 bg-scada-accent/10 border border-scada-accent/20 rounded text-sm text-scada-accent flex items-center gap-2">
                                        <Icons.Filter className="w-4 h-4" />
                                        Select the Logical Devices (LDs) you wish to include in this import.
                                    </div>

                                    {/* Tree View Preview */}
                                    <div className="border border-scada-border rounded-lg bg-scada-panel overflow-hidden">
                                        {draftIED.children?.map(ld => {
                                            const isSelected = selectedLDs.includes(ld.id);
                                            return (
                                                <div key={ld.id} className="border-b border-scada-border last:border-0">
                                                    {/* LD Header (Selectable) */}
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

                                                    {/* LN List (Preview only) */}
                                                    {isSelected && ld.children && (
                                                        <div className="bg-scada-bg/50 border-t border-scada-border/50 py-2 px-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                                                            {ld.children.map(ln => (
                                                                <div key={ln.id} className="flex items-center gap-2 text-xs py-1 px-2 rounded hover:bg-white/5 text-scada-muted">
                                                                    <Icons.Activity className="w-3 h-3 text-blue-400 shrink-0" />
                                                                    <span className="font-mono">{ln.name}</span>
                                                                    <span className="opacity-50 truncate ml-auto">{ln.description}</span>
                                                                </div>
                                                            ))}
                                                        </div>
                                                    )}
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
                    <h3 className="text-lg font-medium text-white border-b border-scada-border pb-2">Network Configuration</h3>
                    
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
                                onChange={e => setNetConfig({...netConfig, vlan: parseInt(e.target.value)})}
                                className="w-full bg-scada-panel border border-scada-border rounded p-2 text-white focus:border-scada-accent outline-none font-mono"
                            >
                                <option value="10">VLAN 10 (Station Bus)</option>
                                <option value="20">VLAN 20 (Process Bus)</option>
                                <option value="1">VLAN 1 (Management)</option>
                            </select>
                         </div>
                    </div>
                    
                    <div className="flex items-center gap-2 mt-4">
                        <input type="checkbox" checked={netConfig.isDHCP} onChange={e => setNetConfig({...netConfig, isDHCP: e.target.checked})} id="dhcp" className="rounded bg-scada-panel border-scada-border text-scada-accent"/>
                        <label htmlFor="dhcp" className="text-sm text-scada-muted cursor-pointer">Enable DHCP (Dynamic Assignment)</label>
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
                                    {importMode === 'modbus' ? modbusSettings.name : draftIED?.name}
                                </div>
                            </div>
                            <div className="text-right">
                                <div className="text-sm text-scada-muted uppercase">Type</div>
                                <div className="font-mono">{importMode === 'modbus' ? 'Modbus TCP Slave' : 'IEC 61850 IED'}</div>
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
                                    {importMode === 'modbus' ? (
                                        <>
                                            Port: {modbusSettings.port}<br/>
                                            Unit ID: {modbusSettings.unitId}<br/>
                                            Regs: {registers.length}
                                        </>
                                    ) : (
                                        <>
                                            {selectedLDs.length} Logical Devices<br/>
                                            {draftIED?.children?.filter(c => selectedLDs.includes(c.id)).reduce((acc, curr) => acc + (curr.children?.length || 0), 0)} Logical Nodes
                                        </>
                                    )}
                                </div>
                             </div>
                        </div>
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
                        <Icons.Run className="w-4 h-4" /> Deploy Device
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
