import React, { useState, useEffect } from 'react';
import { ModbusRegister, ModbusRegisterType, IEDNode, WatchItem, IEDConfig } from '../types';
import { Icons } from './Icons';
import { engine } from '../services/SimulationEngine';

interface ModbusPanelProps {
  selectedNode: IEDNode;
  iedList: IEDNode[];
  onSelectNode: (node: IEDNode) => void;
  onUpdateNode: (node: IEDNode) => void;
  onAddToWatch?: (item: WatchItem) => void;
  onDeleteNode?: (id: string) => void;
}

// Default Fallback if no custom map exists
const DEFAULT_REGISTERS: ModbusRegister[] = [
  { address: 1, type: 'Coil', value: false, name: 'Fan Control', description: 'Auto-start > 65C' },
  { address: 2, type: 'Coil', value: true, name: 'Breaker Status', description: 'CB Closed' },
  { address: 10001, type: 'DiscreteInput', value: true, name: 'Door Alarm', description: 'Cabinet door sensor' },
  { address: 10002, type: 'DiscreteInput', value: false, name: 'Overheat', description: 'Temp sensor alarm' },
  { address: 30001, type: 'InputRegister', value: 0, name: 'Voltage L1', description: 'Scaled x100 (Simulated)' },
  { address: 30002, type: 'InputRegister', value: 6000, name: 'Frequency', description: 'Scaled x100 (Simulated)' },
  { address: 40001, type: 'HoldingRegister', value: 50, name: 'Max Current Setpoint', description: 'Protection limit' },
  { address: 40002, type: 'HoldingRegister', value: 1000, name: 'Reclose Delay', description: 'ms' },
];

export const ModbusPanel: React.FC<ModbusPanelProps> = ({ selectedNode, iedList, onSelectNode, onUpdateNode, onAddToWatch, onDeleteNode }) => {
  const [view, setView] = useState<'map' | 'config'>('map');
  const [activeTab, setActiveTab] = useState<ModbusRegisterType>('Coil');
  const [searchTerm, setSearchTerm] = useState('');
    const modbusDevices = iedList.filter(ied => !!ied.config?.modbusMap);
    const isModbusDeviceSelected = !!selectedNode.config?.modbusMap;
    const activeNode = isModbusDeviceSelected ? selectedNode : (modbusDevices[0] || selectedNode);
  
  // Resolve registers from node config or fallback
    const registers = activeNode.config?.modbusMap || [];

  // Local state for polling the engine
  const [values, setValues] = useState<Record<string, any>>({});
  const [mbConfig, setMbConfig] = useState(engine.getModbusConfig());

  // Local state for Network Configuration (IP, Subnet, etc.)
  const [netConfig, setNetConfig] = useState<IEDConfig>(selectedNode.config || {
      ip: '192.168.1.50', 
      subnet: '255.255.255.0', 
      gateway: '192.168.1.1', 
      vlan: 1, 
      mac: '00:00:00:00:00:01',
      isDHCP: false
  });

  // New Register State for Config Form
  // Using any to allow string values during input before parsing
  const [newReg, setNewReg] = useState<any>({
      address: 40003, type: 'HoldingRegister', value: 0, name: 'New Register', description: ''
  });

  // Load profile into engine when node changes
  useEffect(() => {
      if (!isModbusDeviceSelected && modbusDevices.length > 0) {
          onSelectNode(modbusDevices[0]);
          return;
      }

      setMbConfig(engine.getModbusConfig());

      // Sync local network config state with selected node
      if (activeNode.config) {
          setNetConfig(activeNode.config);
      }
      
  }, [selectedNode.id, isModbusDeviceSelected, modbusDevices.length]); // Reload when ID changes

  // Poll the Engine for real-time updates
  useEffect(() => {
    const interval = setInterval(() => {
        const newValues: Record<string, any> = {};
        registers.forEach(reg => {
            let val;
            switch(reg.type) {
                case 'Coil': val = engine.getCoil(reg.address, activeNode.name); break;
                case 'DiscreteInput': val = engine.getDiscreteInput(reg.address, activeNode.name); break;
                case 'InputRegister': val = engine.getInputRegister(reg.address, activeNode.name); break;
                case 'HoldingRegister': val = engine.getRegister(reg.address, activeNode.name); break;
            }
            newValues[`${reg.type}-${reg.address}`] = val;
        });
        setValues(newValues);
    }, 200); // 5Hz UI Refresh

    return () => clearInterval(interval);
    }, [registers, activeNode.name]);

  const handleValueChange = (reg: ModbusRegister, newValue: string) => {
    const parsedNumber = parseInt(newValue) || 0;
    const parsedBool = newValue === 'true';

    // Write back to Engine with source 'User' to trigger a network packet
    if (reg.type === 'Coil') {
        engine.setCoil(reg.address, parsedBool, activeNode.name);
    } else if (reg.type === 'HoldingRegister') {
        engine.setRegister(reg.address, parsedNumber, activeNode.name);
    }

    const updatedRegisters = registers.map(r => {
        if (r.type === reg.type && r.address === reg.address) {
            return {
                ...r,
                value: reg.type === 'Coil' ? parsedBool : parsedNumber
            };
        }
        return r;
    });
    updateNodeRegisters(updatedRegisters);

    // Force immediate update for UI responsiveness
    setValues(prev => ({ ...prev, [`${reg.type}-${reg.address}`]: reg.type === 'Coil' ? parsedBool : parsedNumber }));
  };

  const handleSaveConfig = () => {
    // 1. Update Engine Modbus Settings
    engine.setModbusConfig(mbConfig);

    // 2. Update Node Configuration (Persist to App State)
    const updatedNode: IEDNode = {
        ...activeNode,
        config: {
            ...activeNode.config,
            ...netConfig,
            modbusMap: registers // Ensure map is preserved
        }
    };
    onUpdateNode(updatedNode);
  };

  const handleAddRegister = () => {
      let val: any = newReg.value;
      // Ensure value is correct type
      if (typeof val === 'string') {
          if (val.toLowerCase() === 'true') val = true;
          else if (val.toLowerCase() === 'false') val = false;
          else val = Number(val) || 0;
      }
      
      const updatedRegisters = [...registers, { ...newReg, value: val }];
      updateNodeRegisters(updatedRegisters);
      setNewReg((prev: any) => ({ ...prev, address: prev.address + 1, name: 'New Register' }));
  };

  const handleRemoveRegister = (idx: number) => {
      const updatedRegisters = registers.filter((_, i) => i !== idx);
      updateNodeRegisters(updatedRegisters);
  };

  const updateNodeRegisters = (updatedRegisters: ModbusRegister[]) => {
      // Create deep copy of node
    const newNode: IEDNode = JSON.parse(JSON.stringify(activeNode));
      if (!newNode.config) newNode.config = { ip: '0.0.0.0', subnet: '0.0.0.0', gateway: '0.0.0.0', vlan: 1 };
      
      newNode.config.modbusMap = updatedRegisters;
      
      // Update Parent State
      onUpdateNode(newNode);
  };

  const filteredRegisters = registers.filter(r => 
    r.type === activeTab && 
    (r.name.toLowerCase().includes(searchTerm.toLowerCase()) || r.address.toString().includes(searchTerm))
  );

  if (modbusDevices.length === 0) {
      return (
          <div className="h-full flex items-center justify-center bg-scada-bg text-scada-muted">
              <div className="text-center border border-scada-border rounded-lg p-6 bg-scada-panel/40 max-w-md">
                  <Icons.Database className="w-10 h-10 mx-auto mb-3 text-yellow-500" />
                  <div className="text-white font-semibold mb-1">No Modbus devices available</div>
                  <div className="text-sm">SCD-imported IEC 61850 devices are intentionally excluded from Modbus lists.</div>
              </div>
          </div>
      );
  }

  return (
    <div className="h-full flex flex-col bg-scada-bg animate-in fade-in duration-300">
      
      {/* Header */}
      <div className="p-6 border-b border-scada-border bg-scada-panel/50 flex justify-between items-center">
        <div>
           <div className="flex items-center gap-2 mb-1">
             <span className="text-xs font-mono uppercase bg-yellow-500/10 text-yellow-500 px-2 py-0.5 rounded border border-yellow-500/20">
               Modbus TCP
             </span>
             {mbConfig.enabled ? (
                 <span className="text-xs font-mono uppercase bg-scada-success/10 text-scada-success px-2 py-0.5 rounded border border-scada-success/20 flex items-center gap-1">
                     <span className="w-1.5 h-1.5 rounded-full bg-scada-success animate-pulse"/> Online
                 </span>
             ) : (
                 <span className="text-xs font-mono uppercase bg-scada-danger/10 text-scada-danger px-2 py-0.5 rounded border border-scada-danger/20">
                     Offline
                 </span>
             )}
           </div>
           
           {/* Device Dropdown Selector */}
           <div className="relative group inline-block my-1">
               <select 
                  value={activeNode.id}
                  onChange={(e) => {
                      const node = modbusDevices.find(n => n.id === e.target.value);
                      if (node) onSelectNode(node);
                  }}
                  className="appearance-none bg-transparent text-2xl font-bold text-white pr-8 focus:outline-none cursor-pointer border-b border-dashed border-scada-muted/30 hover:border-scada-accent transition-colors w-auto max-w-md truncate py-1"
               >
                   {modbusDevices.map(ied => (
                       <option key={ied.id} value={ied.id} className="bg-scada-panel text-sm text-white">{ied.name}</option>
                   ))}
               </select>
               <Icons.ChevronDown className="absolute right-0 top-1/2 -translate-y-1/2 w-5 h-5 text-scada-muted pointer-events-none" />
           </div>

           <p className="text-scada-muted mt-1">
               {view === 'map' ? 'Real-time view of simulation engine memory.' : 'Configure Modbus TCP Server parameters and register map.'}
           </p>
        </div>
        
        {/* Actions & View Switcher */}
        <div className="flex items-center gap-3">
            {onDeleteNode && (
                <button 
                    onClick={() => onDeleteNode(activeNode.id)}
                    className="flex items-center gap-2 px-3 py-1.5 bg-scada-danger/10 hover:bg-scada-danger/20 border border-scada-danger/30 text-scada-danger rounded text-sm transition-colors"
                    title={`Delete ${activeNode.name}`}
                >
                    <Icons.Trash className="w-4 h-4" />
                </button>
            )}

            <div className="flex bg-scada-bg rounded p-1 border border-scada-border">
                <button 
                    onClick={() => setView('map')}
                    className={`px-4 py-1.5 text-sm rounded transition-all font-medium flex items-center gap-2 ${view === 'map' ? 'bg-scada-panel text-white shadow ring-1 ring-scada-border' : 'text-scada-muted hover:text-white'}`}
                >
                    <Icons.Database className="w-4 h-4" /> Memory Map
                </button>
                <button 
                    onClick={() => setView('config')}
                    className={`px-4 py-1.5 text-sm rounded transition-all font-medium flex items-center gap-2 ${view === 'config' ? 'bg-scada-panel text-white shadow ring-1 ring-scada-border' : 'text-scada-muted hover:text-white'}`}
                >
                    <Icons.Settings className="w-4 h-4" /> Configuration
                </button>
            </div>
        </div>
      </div>

      {view === 'map' ? (
          <>
            {/* Toolbar */}
            <div className="px-6 py-4 flex gap-4 border-b border-scada-border bg-scada-bg/50">
                <div className="flex bg-scada-panel rounded p-1 border border-scada-border">
                    {(['Coil', 'DiscreteInput', 'InputRegister', 'HoldingRegister'] as const).map(type => (
                        <button
                            key={type}
                            onClick={() => setActiveTab(type)}
                            className={`px-4 py-1.5 text-sm rounded transition-all ${activeTab === type ? 'bg-scada-accent text-white shadow' : 'text-scada-muted hover:text-white'}`}
                        >
                            {type.replace(/([A-Z])/g, ' $1').trim()}s
                        </button>
                    ))}
                </div>
                <div className="flex-1 relative">
                    <Icons.Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-scada-muted" />
                    <input 
                        type="text" 
                        placeholder="Search registers..." 
                        className="w-full bg-scada-panel border border-scada-border rounded pl-10 pr-4 py-2 text-sm focus:outline-none focus:border-scada-accent transition-colors"
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                    />
                </div>
            </div>

            {/* Table */}
            <div className="flex-1 overflow-auto p-6">
                <div className="bg-scada-panel border border-scada-border rounded-lg overflow-hidden">
                    <table className="w-full text-sm text-left">
                        <thead className="bg-white/5 text-scada-muted font-mono text-xs uppercase">
                            <tr>
                                <th className="px-6 py-4">Address</th>
                                <th className="px-6 py-4">Name</th>
                                <th className="px-6 py-4">Description</th>
                                <th className="px-6 py-4">Live Value</th>
                                <th className="px-6 py-4">Type</th>
                                <th className="px-6 py-4 w-10"></th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-scada-border/50">
                            {filteredRegisters.length === 0 && (
                                <tr>
                                    <td colSpan={6} className="px-6 py-8 text-center text-scada-muted">
                                        No registers of type '{activeTab}' found. Check configuration.
                                    </td>
                                </tr>
                            )}
                            {filteredRegisters.map(reg => {
                                const currentVal = values[`${reg.type}-${reg.address}`] ?? reg.value;
                                return (
                                <tr key={`${reg.type}-${reg.address}`} className="hover:bg-white/5 transition-colors group">
                                    <td className="px-6 py-4 font-mono text-scada-accent">{reg.address}</td>
                                    <td className="px-6 py-4 font-bold text-gray-200">{reg.name}</td>
                                    <td className="px-6 py-4 text-scada-muted">{reg.description}</td>
                                    <td className="px-6 py-4">
                                        {reg.type === 'Coil' || reg.type === 'HoldingRegister' ? (
                                            reg.type === 'Coil' ? (
                                                <select 
                                                    value={String(currentVal)} 
                                                    onChange={(e) => handleValueChange(reg, e.target.value)}
                                                    className={`bg-scada-bg border border-scada-border rounded px-2 py-1 focus:border-scada-accent outline-none font-bold ${currentVal ? 'text-scada-success' : 'text-scada-muted'}`}
                                                >
                                                    <option value="true">ON</option>
                                                    <option value="false">OFF</option>
                                                </select>
                                            ) : (
                                                <input 
                                                    type="number" 
                                                    value={String(currentVal)} 
                                                    onChange={(e) => handleValueChange(reg, e.target.value)}
                                                    className="bg-scada-bg border border-scada-border rounded px-2 py-1 w-24 focus:border-scada-accent outline-none font-mono"
                                                />
                                            )
                                        ) : (
                                            <span className={`font-mono font-bold ${typeof currentVal === 'boolean' ? (currentVal ? 'text-scada-success' : 'text-scada-danger') : 'text-purple-400'}`}>
                                                {String(currentVal).toUpperCase()}
                                            </span>
                                        )}
                                    </td>
                                    <td className="px-6 py-4 text-xs text-scada-muted uppercase">{reg.type}</td>
                                    <td className="px-6 py-4">
                                        {onAddToWatch && (
                                            <button 
                                                onClick={() => onAddToWatch({
                                                    id: `modbus-${reg.address}`,
                                                    label: reg.name,
                                                    source: 'Modbus',
                                                    addressOrPath: reg.address,
                                                    modbusType: reg.type
                                                })}
                                                className="opacity-0 group-hover:opacity-100 text-scada-muted hover:text-scada-accent transition-opacity"
                                                title="Watch this register"
                                            >
                                                <Icons.Eye className="w-4 h-4" />
                                            </button>
                                        )}
                                    </td>
                                </tr>
                            )})}
                        </tbody>
                    </table>
                </div>
            </div>
          </>
      ) : (
          <div className="flex-1 overflow-auto p-8">
                {/* ... (Existing Config View Content - Unchanged) ... */}
                <div className="max-w-4xl mx-auto space-y-8">
                    {/* Server Status Card */}
                    <div className="bg-scada-panel border border-scada-border rounded-lg p-6">
                        <div className="flex items-center justify-between mb-4">
                            <div>
                                <h3 className="text-lg font-bold text-white">Server Status</h3>
                                <p className="text-sm text-scada-muted">Enable or disable the Modbus TCP listener.</p>
                            </div>
                            <div className="relative inline-block w-12 h-6 transition duration-200 ease-in-out">
                                <button 
                                    onClick={() => {
                                        const newConfig = { ...mbConfig, enabled: !mbConfig.enabled };
                                        setMbConfig(newConfig);
                                        engine.setModbusConfig(newConfig); // Auto-save for toggle
                                    }}
                                    className={`block w-12 h-6 rounded-full transition-colors duration-200 focus:outline-none ${mbConfig.enabled ? 'bg-scada-success' : 'bg-scada-border'}`}
                                >
                                    <span className={`block w-4 h-4 ml-1 bg-white rounded-full shadow transform transition-transform duration-200 ${mbConfig.enabled ? 'translate-x-6' : ''}`} />
                                </button>
                            </div>
                        </div>
                    </div>

                    {/* Network Settings Card */}
                     <div className="bg-scada-panel border border-scada-border rounded-lg p-6">
                        <h3 className="text-lg font-bold text-white mb-6 flex items-center gap-2">
                            <Icons.Wifi className="w-5 h-5 text-scada-accent" /> Network Parameters
                        </h3>
                        
                        <div className="mb-6">
                            <h4 className="text-xs font-bold text-scada-muted uppercase mb-3 border-b border-scada-border pb-1">Modbus Protocol Settings</h4>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                <div className="space-y-2">
                                    <label className="text-sm font-bold text-scada-muted uppercase">TCP Port</label>
                                    <div className="relative">
                                        <input 
                                            type="number" 
                                            value={mbConfig.port}
                                            onChange={e => setMbConfig({ ...mbConfig, port: parseInt(e.target.value) || 502 })}
                                            className="w-full bg-scada-bg border border-scada-border rounded-lg p-3 pl-10 text-white focus:border-scada-accent focus:ring-1 focus:ring-scada-accent outline-none font-mono transition-all"
                                        />
                                        <Icons.Server className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-scada-muted" />
                                    </div>
                                    <p className="text-xs text-scada-muted">Standard Modbus TCP port is 502.</p>
                                </div>
                                
                                <div className="space-y-2">
                                    <label className="text-sm font-bold text-scada-muted uppercase">Unit ID (Slave ID)</label>
                                    <div className="relative">
                                        <input 
                                            type="number" 
                                            value={mbConfig.unitId}
                                            onChange={e => setMbConfig({ ...mbConfig, unitId: parseInt(e.target.value) || 1 })}
                                            className="w-full bg-scada-bg border border-scada-border rounded-lg p-3 pl-10 text-white focus:border-scada-accent focus:ring-1 focus:ring-scada-accent outline-none font-mono transition-all"
                                        />
                                        <Icons.Cpu className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-scada-muted" />
                                    </div>
                                    <p className="text-xs text-scada-muted">Identifier for this device on the Modbus network (1-247).</p>
                                </div>
                            </div>
                        </div>

                        <div>
                             <h4 className="text-xs font-bold text-scada-muted uppercase mb-3 border-b border-scada-border pb-1">Network Interface</h4>
                             <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                <div className="space-y-2">
                                    <label className="text-sm font-bold text-scada-muted uppercase">IP Address</label>
                                    <input 
                                        type="text" 
                                        value={netConfig.ip} 
                                        onChange={e => setNetConfig({ ...netConfig, ip: e.target.value })}
                                        className="w-full bg-scada-bg border border-scada-border rounded-lg p-2 text-white focus:border-scada-accent outline-none font-mono"
                                    />
                                </div>
                                <div className="space-y-2">
                                    <label className="text-sm font-bold text-scada-muted uppercase">Subnet Mask</label>
                                    <input 
                                        type="text" 
                                        value={netConfig.subnet} 
                                        onChange={e => setNetConfig({ ...netConfig, subnet: e.target.value })}
                                        className="w-full bg-scada-bg border border-scada-border rounded-lg p-2 text-white focus:border-scada-accent outline-none font-mono"
                                    />
                                </div>
                                <div className="space-y-2">
                                    <label className="text-sm font-bold text-scada-muted uppercase">Gateway</label>
                                    <input 
                                        type="text" 
                                        value={netConfig.gateway} 
                                        onChange={e => setNetConfig({ ...netConfig, gateway: e.target.value })}
                                        className="w-full bg-scada-bg border border-scada-border rounded-lg p-2 text-white focus:border-scada-accent outline-none font-mono"
                                    />
                                </div>
                                <div className="space-y-2">
                                    <label className="text-sm font-bold text-scada-muted uppercase">VLAN ID</label>
                                     <select 
                                        value={netConfig.vlan} 
                                        onChange={e => setNetConfig({ ...netConfig, vlan: parseInt(e.target.value) })}
                                        className="w-full bg-scada-bg border border-scada-border rounded-lg p-2 text-white focus:border-scada-accent outline-none font-mono"
                                    >
                                        <option value="1">VLAN 1 (Management)</option>
                                        <option value="10">VLAN 10 (Station Bus)</option>
                                        <option value="20">VLAN 20 (Process Bus)</option>
                                    </select>
                                </div>
                                 <div className="space-y-2 md:col-span-2">
                                    <label className="text-sm font-bold text-scada-muted uppercase">MAC Address</label>
                                    <input 
                                        type="text" 
                                        value={netConfig.mac} 
                                        onChange={e => setNetConfig({ ...netConfig, mac: e.target.value })}
                                        className="w-full bg-scada-bg border border-scada-border rounded-lg p-2 text-white focus:border-scada-accent outline-none font-mono uppercase"
                                    />
                                </div>
                             </div>
                        </div>

                        <div className="mt-8 pt-6 border-t border-scada-border flex justify-end">
                             <button 
                                onClick={handleSaveConfig}
                                className="px-6 py-2 bg-scada-accent text-white rounded font-bold hover:bg-cyan-600 transition-colors shadow-lg shadow-cyan-900/20 flex items-center gap-2"
                             >
                                 <Icons.Save className="w-4 h-4" /> Save Network Settings
                             </button>
                        </div>
                    </div>

                    {/* Register Map Editor */}
                    <div className="bg-scada-panel border border-scada-border rounded-lg p-6">
                         <h3 className="text-lg font-bold text-white mb-6 flex items-center gap-2">
                            <Icons.List className="w-5 h-5 text-purple-400" /> Register Map Configuration
                        </h3>

                        {/* Add Form */}
                        <div className="bg-scada-bg/50 p-4 rounded border border-scada-border flex flex-wrap gap-4 items-end mb-4">
                            <div className="flex-1 min-w-[120px]">
                                <label className="text-xs font-bold text-scada-muted uppercase">Type</label>
                                <select 
                                    value={newReg.type} 
                                    onChange={e => setNewReg({...newReg, type: e.target.value as ModbusRegisterType})}
                                    className="w-full bg-scada-panel border border-scada-border rounded p-2 text-sm"
                                >
                                    <option value="Coil">Coil (0x)</option>
                                    <option value="DiscreteInput">Discrete Input (1x)</option>
                                    <option value="InputRegister">Input Register (3x)</option>
                                    <option value="HoldingRegister">Holding Register (4x)</option>
                                </select>
                            </div>
                            <div className="flex-1 min-w-[80px]">
                                <label className="text-xs font-bold text-scada-muted uppercase">Address</label>
                                <input type="number" value={newReg.address} onChange={e => setNewReg({...newReg, address: parseInt(e.target.value)})} className="w-full bg-scada-panel border border-scada-border rounded p-2 text-sm" />
                            </div>
                            <div className="flex-[2] min-w-[150px]">
                                <label className="text-xs font-bold text-scada-muted uppercase">Name</label>
                                <input type="text" value={newReg.name} onChange={e => setNewReg({...newReg, name: e.target.value})} className="w-full bg-scada-panel border border-scada-border rounded p-2 text-sm" />
                            </div>
                            <div className="flex-1 min-w-[80px]">
                                <label className="text-xs font-bold text-scada-muted uppercase">Value</label>
                                <input type="text" value={String(newReg.value)} onChange={e => setNewReg({...newReg, value: e.target.value})} className="w-full bg-scada-panel border border-scada-border rounded p-2 text-sm" />
                            </div>
                            <button onClick={handleAddRegister} className="px-4 py-2 bg-scada-accent text-white rounded font-bold hover:bg-cyan-600 text-sm">
                                <Icons.Box className="w-4 h-4" /> Add
                            </button>
                        </div>

                        {/* Edit List */}
                        <div className="border border-scada-border rounded overflow-hidden max-h-96 overflow-y-auto">
                            <table className="w-full text-sm text-left">
                                <thead className="bg-scada-bg text-scada-muted text-xs uppercase font-mono sticky top-0">
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
                                                <button onClick={() => handleRemoveRegister(i)} className="text-scada-danger hover:text-red-400">
                                                    <Icons.Trash className="w-3 h-3" />
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>

                    </div>
                </div>
             </div>
      )}
    </div>
  );
};