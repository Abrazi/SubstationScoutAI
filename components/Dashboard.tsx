
import React, { useEffect, useMemo, useState } from 'react';
import { SimulationData, IEDNode, DashboardWidget, DashboardWidgetType, ModbusRegisterType } from '../types';
import { SimulationChart } from './SimulationCharts';
import { Icons } from './Icons';
import { engine } from '../services/SimulationEngine';

interface DashboardProps {
  selectedNode: IEDNode | null;
  ieds: IEDNode[];
  onSelectNode: (node: IEDNode) => void;
  onUpdateNode: (node: IEDNode) => void;
}

const DEFAULT_LAYOUT: DashboardWidget[] = [
    { id: '1', type: 'value-card', title: 'System Frequency', config: { param: 'freq' } },
    { id: '2', type: 'breaker-control', title: 'Circuit Breaker Control' },
    { id: '3', type: 'chart-voltage', title: 'Phase Voltages' },
    { id: '4', type: 'chart-current', title: 'Phase Currents' },
    { id: '5', type: 'measurement-table', title: 'MMXU Measurements' },
];

export const Dashboard: React.FC<DashboardProps> = ({ selectedNode, ieds, onSelectNode, onUpdateNode }) => {
  const [simData, setSimData] = useState<(SimulationData & { time: string })[]>([]);
    const [breakerState, setBreakerState] = useState(engine.getCoil(2));
  const [isEditing, setIsEditing] = useState(false);
  const [layout, setLayout] = useState<DashboardWidget[]>([]);
    const [sourceFilterText, setSourceFilterText] = useState('');
    const [sourceFilterGroup, setSourceFilterGroup] = useState<'all' | 'da' | 'modbus'>('all');

    type SourceOption = { value: string; label: string; group: 'IEC 61850 DA' | 'Modbus' };

    const sourceOptions = useMemo<SourceOption[]>(() => {
            if (!selectedNode) return [];

            const options: SourceOption[] = [];
            const stack: IEDNode[] = [selectedNode];

            while (stack.length > 0) {
                    const node = stack.pop()!;
                    if (node.type === 'DA' && node.path) {
                            options.push({ value: `da:${node.path}`, label: node.path, group: 'IEC 61850 DA' });
                    }
                    if (node.children) stack.push(...node.children);
            }

            (selectedNode.config?.modbusMap || []).forEach((reg) => {
                    options.push({
                            value: `modbus:${reg.type}:${reg.address}`,
                            label: `${reg.name} (${reg.type} ${reg.address})`,
                            group: 'Modbus'
                    });
            });

            return options;
    }, [selectedNode]);

          const filteredSourceOptions = useMemo(() => {
              const query = sourceFilterText.trim().toLowerCase();
              return sourceOptions.filter((opt) => {
                  const groupMatch =
                      sourceFilterGroup === 'all' ||
                      (sourceFilterGroup === 'da' && opt.group === 'IEC 61850 DA') ||
                      (sourceFilterGroup === 'modbus' && opt.group === 'Modbus');
                  const textMatch = !query || opt.label.toLowerCase().includes(query) || opt.value.toLowerCase().includes(query);
                  return groupMatch && textMatch;
              });
          }, [sourceOptions, sourceFilterGroup, sourceFilterText]);

    const findDaPath = (root: IEDNode | null, suffix: string): string | undefined => {
        if (!root) return undefined;
        const stack: IEDNode[] = [root];
        while (stack.length > 0) {
            const node = stack.pop()!;
            if (node.type === 'DA' && node.path && node.path.endsWith(suffix)) return node.path;
            if (node.children) stack.push(...node.children);
        }
        return undefined;
    };

    const getRegisterByName = (root: IEDNode | null, name: string): number | undefined => {
        const reg = root?.config?.modbusMap?.find(r => r.name.toLowerCase() === name.toLowerCase());
        if (!reg) return undefined;
        return engine.getRegister(reg.address);
    };

    const getNumericDa = (path?: string): number | undefined => {
        if (!path) return undefined;
        const value = engine.readMMS(path);
        if (value === undefined || value === null || value === '') return undefined;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    };

    const readMappedSource = (source?: string): number | boolean | undefined => {
        if (!source) return undefined;

        if (source.startsWith('da:')) {
            const path = source.slice(3);
            const value = engine.readMMS(path);
            if (typeof value === 'boolean' || typeof value === 'number') return value;
            if (typeof value === 'string') {
                const normalized = value.toLowerCase();
                if (normalized === 'true' || normalized === 'on' || normalized === 'closed') return true;
                if (normalized === 'false' || normalized === 'off' || normalized === 'open') return false;
                const parsed = Number(value);
                return Number.isFinite(parsed) ? parsed : undefined;
            }
            return undefined;
        }

        if (source.startsWith('modbus:')) {
            const [, type, addressText] = source.split(':');
            const address = Number(addressText);
            if (!Number.isFinite(address)) return undefined;
            switch (type as ModbusRegisterType) {
                case 'Coil':
                    return engine.getCoil(address);
                case 'DiscreteInput':
                    return engine.getDiscreteInput(address);
                case 'HoldingRegister':
                    return engine.getRegister(address);
                case 'InputRegister':
                    return engine.getInputRegister(address);
                default:
                    return undefined;
            }
        }

        return undefined;
    };

    const asNumber = (value: number | boolean | undefined): number | undefined => {
        if (typeof value === 'number') return value;
        if (typeof value === 'boolean') return value ? 1 : 0;
        return undefined;
    };

    const asBoolean = (value: number | boolean | undefined): boolean | undefined => {
        if (typeof value === 'boolean') return value;
        if (typeof value === 'number') return value !== 0;
        return undefined;
    };

    const updateWidgetConfig = (widgetId: string, patch: Record<string, any>) => {
        setLayout(prev => prev.map(widget => widget.id === widgetId ? { ...widget, config: { ...(widget.config || {}), ...patch } } : widget));
    };

    const resolveBreakerState = (root: IEDNode | null): boolean => {
        const posPath = findDaPath(root, '.XCBR1.Pos.stVal');
        const posVal = posPath ? engine.readMMS(posPath) : undefined;
        if (typeof posVal === 'string') {
            const normalized = posVal.toLowerCase();
            if (normalized === 'on' || normalized === 'closed') return true;
            if (normalized === 'off' || normalized === 'open') return false;
        }

        const statusWord = getRegisterByName(root, 'Status Word 1');
        if (typeof statusWord === 'number') {
            return (statusWord & (1 << 4)) !== 0;
        }

        return engine.getCoil(2);
    };

  // Initialize Layout on Node Change
  useEffect(() => {
    if (selectedNode) {
        setLayout(selectedNode.dashboardLayout || DEFAULT_LAYOUT);
    }
  }, [selectedNode]);

    // Real telemetry polling loop
  useEffect(() => {
    const interval = setInterval(() => {
            const breakerWidget = layout.find(w => w.type === 'breaker-control');
            const currentBreakerState = asBoolean(readMappedSource(breakerWidget?.config?.breakerSource)) ?? resolveBreakerState(selectedNode);
      if (currentBreakerState !== breakerState) {
          setBreakerState(currentBreakerState);
      }

      const now = new Date();
      const timeStr = now.toLocaleTimeString();

            const frequencyRaw = getRegisterByName(selectedNode, 'Frequency');
            const frequency = typeof frequencyRaw === 'number' ? frequencyRaw / 100 : 0;

            const voltageReg = getRegisterByName(selectedNode, 'Voltage') ?? 0;
            const currentReg = getRegisterByName(selectedNode, 'Current') ?? 0;

            const phvPath = findDaPath(selectedNode, '.MMXU1.PhV.phsA');
            const currentPath = findDaPath(selectedNode, '.MMXU1.A.phsA');
            const daVoltage = getNumericDa(phvPath);
            const daCurrent = getNumericDa(currentPath);

                        const phaseVoltage = daVoltage ?? voltageReg;
                        const phaseCurrent = currentBreakerState ? (daCurrent ?? currentReg) : 0;

                        const voltageWidget = layout.find(w => w.type === 'chart-voltage');
                        const currentWidget = layout.find(w => w.type === 'chart-current');
                        const valueWidget = layout.find(w => w.type === 'value-card');

                        const mappedVoltageA = asNumber(readMappedSource(voltageWidget?.config?.voltageA));
                        const mappedVoltageB = asNumber(readMappedSource(voltageWidget?.config?.voltageB));
                        const mappedVoltageC = asNumber(readMappedSource(voltageWidget?.config?.voltageC));
                        const mappedCurrentA = asNumber(readMappedSource(currentWidget?.config?.currentA));
                        const mappedCurrentB = asNumber(readMappedSource(currentWidget?.config?.currentB));
                        const mappedCurrentC = asNumber(readMappedSource(currentWidget?.config?.currentC));
                        const mappedFrequency = asNumber(readMappedSource(valueWidget?.config?.valueSource));

      const newData: SimulationData & { time: string } = {
        time: timeStr,
                                voltageA: mappedVoltageA ?? phaseVoltage,
                                voltageB: mappedVoltageB ?? phaseVoltage,
                                voltageC: mappedVoltageC ?? phaseVoltage,
                                currentA: mappedCurrentA ?? phaseCurrent,
                                currentB: mappedCurrentB ?? phaseCurrent,
                                currentC: mappedCurrentC ?? phaseCurrent,
                                frequency: mappedFrequency ?? frequency,
        breakerStatus: currentBreakerState
      };

      setSimData(prev => {
        const next = [...prev, newData];
        if (next.length > 30) next.shift(); // Keep last 30 points
        return next;
      });
    }, 1000);

    return () => clearInterval(interval);
    }, [selectedNode, breakerState, layout]);

  const toggleBreaker = () => {
    const newState = !breakerState;
        setBreakerState(newState);
        engine.setCoil(2, newState, 'Dashboard User');

        const posPath = findDaPath(selectedNode, '.XCBR1.Pos.stVal');
        if (posPath) {
            engine.writeMMS(posPath, newState ? 'on' : 'off', 'Dashboard User');
        }
  };

  const saveLayout = () => {
      if (selectedNode) {
          onUpdateNode({ ...selectedNode, dashboardLayout: layout });
          setIsEditing(false);
      }
  };

  const addWidget = (type: DashboardWidgetType, title: string) => {
      const newWidget: DashboardWidget = {
          id: Date.now().toString(),
          type,
          title,
          config: {}
      };
      setLayout(prev => [...prev, newWidget]);
  };

  const removeWidget = (id: string) => {
      setLayout(prev => prev.filter(w => w.id !== id));
  };

  const moveWidget = (index: number, direction: 'up' | 'down') => {
      const newLayout = [...layout];
      if (direction === 'up' && index > 0) {
          [newLayout[index], newLayout[index - 1]] = [newLayout[index - 1], newLayout[index]];
      } else if (direction === 'down' && index < newLayout.length - 1) {
          [newLayout[index], newLayout[index + 1]] = [newLayout[index + 1], newLayout[index]];
      }
      setLayout(newLayout);
  };

  const latest = simData[simData.length - 1] || { 
    voltageA: 0, voltageB: 0, voltageC: 0, 
    currentA: 0, currentB: 0, currentC: 0, 
    frequency: 0, breakerStatus: breakerState 
  };

  // Render Logic for different widget types
  const renderWidget = (widget: DashboardWidget) => {
      const cfg = widget.config || {};

      const renderSourceSelect = (label: string, key: string) => (
          (() => {
              const selectedValue = cfg[key] || '';
              const selectedOption = sourceOptions.find(opt => opt.value === selectedValue);
              const visibleOptions = selectedOption && !filteredSourceOptions.some(opt => opt.value === selectedOption.value)
                  ? [selectedOption, ...filteredSourceOptions]
                  : filteredSourceOptions;
              return (
          <div className="space-y-1">
              <label className="text-[10px] uppercase tracking-wide text-scada-muted">{label}</label>
              <select
                  value={cfg[key] || ''}
                  onChange={(e) => updateWidgetConfig(widget.id, { [key]: e.target.value || undefined })}
                  className="w-full bg-scada-bg border border-scada-border rounded px-2 py-1 text-[10px] text-white"
              >
                  <option value="">Auto / Default</option>
                  <optgroup label="IEC 61850 DA">
                      {visibleOptions.filter(o => o.group === 'IEC 61850 DA').map(opt => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                  </optgroup>
                  <optgroup label="Modbus">
                      {visibleOptions.filter(o => o.group === 'Modbus').map(opt => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                  </optgroup>
              </select>
          </div>
              );
          })()
      );

      const tableA = asNumber(readMappedSource(cfg.tableA)) ?? latest.voltageA;
      const tableB = asNumber(readMappedSource(cfg.tableB)) ?? latest.voltageB;
      const tableC = asNumber(readMappedSource(cfg.tableC)) ?? latest.voltageC;

      const content = () => {
          switch (widget.type) {
              case 'value-card':
                  return (
                      <div className="flex flex-col items-center justify-center h-24">
                          <div className="text-3xl font-mono text-scada-accent">{latest.frequency.toFixed(3)} Hz</div>
                          <div className="text-xs text-scada-muted uppercase mt-1">System Frequency</div>
                      </div>
                  );
              case 'breaker-control':
                  return (
                      <div className="flex items-center justify-between gap-4 p-4 h-full">
                        <div className={`w-20 h-20 rounded-full flex items-center justify-center border-4 shadow-lg transition-colors ${breakerState ? 'border-scada-danger text-scada-danger bg-scada-danger/10' : 'border-scada-success text-scada-success bg-scada-success/10'}`}>
                            <div className="text-center">
                                <span className="text-xs font-bold block mb-1">STATUS</span>
                                <span className="text-lg font-bold">{breakerState ? 'CLOSED' : 'OPEN'}</span>
                            </div>
                        </div>
                        <div className="flex flex-col gap-2 flex-1">
                            <button onClick={toggleBreaker} disabled={breakerState} className={`px-4 py-2 rounded text-sm font-bold transition-all ${breakerState ? 'bg-scada-border text-gray-500 cursor-not-allowed' : 'bg-scada-danger hover:bg-red-600 text-white shadow-lg shadow-red-900/20'}`}>
                                <Icons.Zap className="w-4 h-4 inline mr-2" /> CLOSE BREAKER
                            </button>
                            <button onClick={toggleBreaker} disabled={!breakerState} className={`px-4 py-2 rounded text-sm font-bold transition-all ${!breakerState ? 'bg-scada-border text-gray-500 cursor-not-allowed' : 'bg-scada-success hover:bg-emerald-600 text-white shadow-lg shadow-emerald-900/20'}`}>
                                <Icons.Shield className="w-4 h-4 inline mr-2" /> OPEN BREAKER
                            </button>
                        </div>
                      </div>
                  );
              case 'chart-voltage':
                  return <SimulationChart data={simData} type="voltage" />;
              case 'chart-current':
                  return <SimulationChart data={simData} type="current" />;
              case 'measurement-table':
                  return (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm font-mono text-left">
                            <thead className="text-scada-muted border-b border-scada-border bg-white/5">
                                <tr><th className="px-3 py-1">Ph</th><th className="px-3 py-1">Val</th><th className="px-3 py-1">Unit</th></tr>
                            </thead>
                            <tbody>
                                <tr><td className="px-3 py-1 text-scada-accent">Va</td><td>{tableA.toFixed(1)}</td><td className="text-gray-500">kV</td></tr>
                                <tr><td className="px-3 py-1 text-yellow-500">Vb</td><td>{tableB.toFixed(1)}</td><td className="text-gray-500">kV</td></tr>
                                <tr><td className="px-3 py-1 text-blue-400">Vc</td><td>{tableC.toFixed(1)}</td><td className="text-gray-500">kV</td></tr>
                            </tbody>
                        </table>
                      </div>
                  );
              default:
                  return <div className="p-4 text-scada-muted text-sm italic">Unknown Widget Type</div>;
          }
      };

      return (
          <div className="bg-scada-panel border border-scada-border rounded-lg overflow-hidden h-full flex flex-col relative group">
              <div className="bg-scada-bg/50 px-4 py-2 border-b border-scada-border flex justify-between items-center handle select-none">
                  <span className="font-bold text-xs uppercase text-gray-300 flex items-center gap-2">
                     <Icons.Activity className="w-3 h-3 text-scada-muted" /> {widget.title}
                  </span>
                  {isEditing && (
                      <div className="flex gap-1">
                          <button onClick={() => removeWidget(widget.id)} className="p-1 hover:bg-red-500/20 text-red-400 rounded"><Icons.Trash className="w-3 h-3"/></button>
                      </div>
                  )}
              </div>
              <div className="flex-1 overflow-auto bg-scada-panel/30 min-h-[150px]">
                  {isEditing && (
                      <div className="p-2 border-b border-scada-border bg-scada-bg/30 space-y-2">
                          {widget.type === 'value-card' && renderSourceSelect('Value Source', 'valueSource')}
                          {widget.type === 'breaker-control' && renderSourceSelect('Breaker Status Source', 'breakerSource')}
                          {widget.type === 'chart-voltage' && (
                              <>
                                  {renderSourceSelect('Phase A Source', 'voltageA')}
                                  {renderSourceSelect('Phase B Source', 'voltageB')}
                                  {renderSourceSelect('Phase C Source', 'voltageC')}
                              </>
                          )}
                          {widget.type === 'chart-current' && (
                              <>
                                  {renderSourceSelect('Phase A Source', 'currentA')}
                                  {renderSourceSelect('Phase B Source', 'currentB')}
                                  {renderSourceSelect('Phase C Source', 'currentC')}
                              </>
                          )}
                          {widget.type === 'measurement-table' && (
                              <>
                                  {renderSourceSelect('Row A Source', 'tableA')}
                                  {renderSourceSelect('Row B Source', 'tableB')}
                                  {renderSourceSelect('Row C Source', 'tableC')}
                              </>
                          )}
                      </div>
                  )}
                  {content()}
              </div>
              {isEditing && (
                  <div className="absolute inset-0 bg-black/50 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                      <span className="text-xs font-mono text-white bg-black px-2 py-1 rounded">Drag to Reorder (Coming Soon)</span>
                  </div>
              )}
          </div>
      );
  };

  return (
    <div className="p-6 h-full flex flex-col animate-in fade-in zoom-in-95 duration-300">
      
      {/* Header Info with Dropdown */}
      <div className="bg-gradient-to-r from-scada-panel to-scada-bg border border-scada-border p-4 rounded-lg flex items-center justify-between mb-6 shrink-0 shadow-md">
        <div className="flex items-center gap-4">
            <div className="p-2 bg-scada-bg border border-scada-border rounded-lg">
                <Icons.Server className="w-8 h-8 text-scada-accent" />
            </div>
            <div>
                 <label className="text-xs text-scada-muted uppercase font-bold block mb-1">Active Dashboard Device</label>
                 <div className="relative group">
                     <select 
                        value={selectedNode?.id || ''} 
                        onChange={(e) => {
                            const node = ieds.find(n => n.id === e.target.value);
                            if(node) onSelectNode(node);
                        }}
                        className="appearance-none bg-transparent text-xl font-bold text-white pr-8 focus:outline-none cursor-pointer border-b border-dashed border-scada-muted/30 hover:border-scada-accent transition-colors w-64 truncate"
                     >
                         {ieds.map(ied => (
                             <option key={ied.id} value={ied.id} className="bg-scada-panel text-sm text-white">{ied.name}</option>
                         ))}
                     </select>
                     <Icons.ChevronDown className="absolute right-0 top-1/2 -translate-y-1/2 w-4 h-4 text-scada-muted pointer-events-none" />
                 </div>
                 <div className="text-xs text-scada-muted mt-1 flex gap-2">
                    <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-scada-success"></span> Online</span>
                    <span>•</span>
                    <span>{selectedNode?.config?.ip || '192.168.1.100'}</span>
                 </div>
            </div>
        </div>
        
        <div className="flex items-center gap-3">
             {isEditing ? (
                 <>
                    <button onClick={() => setIsEditing(false)} className="px-4 py-2 rounded text-scada-muted hover:text-white text-sm">Cancel</button>
                    <button onClick={saveLayout} className="px-4 py-2 bg-scada-success text-white rounded text-sm font-bold shadow-lg shadow-emerald-900/20 flex items-center gap-2">
                        <Icons.Save className="w-4 h-4" /> Save Layout
                    </button>
                 </>
             ) : (
                 <button onClick={() => setIsEditing(true)} className="px-4 py-2 bg-scada-panel hover:bg-white/5 border border-scada-border rounded text-sm font-medium transition-colors flex items-center gap-2 text-scada-muted hover:text-white">
                     <Icons.Settings className="w-4 h-4" /> Edit Dashboard
                 </button>
             )}
        </div>
      </div>

      {/* Edit Mode Toolbar */}
      {isEditing && (
          <div className="mb-6 p-4 bg-scada-panel border border-dashed border-scada-accent/50 rounded-lg flex flex-wrap gap-4 items-center animate-in slide-in-from-top-2">
              <span className="text-xs font-bold text-scada-accent uppercase mr-2">Add Widget:</span>
              <button onClick={() => addWidget('chart-voltage', 'Voltage Chart')} className="px-3 py-1.5 bg-scada-bg border border-scada-border rounded text-xs hover:border-scada-accent transition-colors">+ Voltage Chart</button>
              <button onClick={() => addWidget('chart-current', 'Current Chart')} className="px-3 py-1.5 bg-scada-bg border border-scada-border rounded text-xs hover:border-scada-accent transition-colors">+ Current Chart</button>
              <button onClick={() => addWidget('breaker-control', 'Breaker Control')} className="px-3 py-1.5 bg-scada-bg border border-scada-border rounded text-xs hover:border-scada-accent transition-colors">+ Breaker</button>
              <button onClick={() => addWidget('measurement-table', 'Data Table')} className="px-3 py-1.5 bg-scada-bg border border-scada-border rounded text-xs hover:border-scada-accent transition-colors">+ Table</button>
              <button onClick={() => addWidget('value-card', 'Freq Card')} className="px-3 py-1.5 bg-scada-bg border border-scada-border rounded text-xs hover:border-scada-accent transition-colors">+ Value Card</button>

              <div className="ml-auto flex items-center gap-2">
                  <span className="text-[10px] uppercase text-scada-muted">Source Filter</span>
                  <select
                      value={sourceFilterGroup}
                      onChange={(e) => setSourceFilterGroup(e.target.value as 'all' | 'da' | 'modbus')}
                      className="bg-scada-bg border border-scada-border rounded px-2 py-1 text-xs text-white"
                  >
                      <option value="all">All</option>
                      <option value="da">IEC 61850 DA</option>
                      <option value="modbus">Modbus</option>
                  </select>
                  <input
                      value={sourceFilterText}
                      onChange={(e) => setSourceFilterText(e.target.value)}
                      placeholder="Search source..."
                      className="w-44 bg-scada-bg border border-scada-border rounded px-2 py-1 text-xs text-white"
                  />
                  <button
                      onClick={() => {
                          setSourceFilterGroup('all');
                          setSourceFilterText('');
                      }}
                      className="px-2 py-1 bg-scada-bg border border-scada-border rounded text-xs text-scada-muted hover:text-white hover:border-scada-accent transition-colors"
                  >
                      Clear
                  </button>
              </div>
          </div>
      )}

      {/* Grid Layout */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6 overflow-y-auto pb-10">
          {layout.map((widget, index) => (
              <div key={widget.id} className={`${['chart-voltage', 'chart-current', 'measurement-table'].includes(widget.type) ? 'col-span-1 md:col-span-2' : 'col-span-1'}`}>
                  {isEditing && (
                      <div className="flex justify-center mb-1 gap-1">
                          <button onClick={() => moveWidget(index, 'up')} disabled={index === 0} className="p-1 bg-scada-bg border border-scada-border rounded disabled:opacity-30 hover:bg-white/10"><Icons.ChevronDown className="w-3 h-3 rotate-180" /></button>
                          <button onClick={() => moveWidget(index, 'down')} disabled={index === layout.length - 1} className="p-1 bg-scada-bg border border-scada-border rounded disabled:opacity-30 hover:bg-white/10"><Icons.ChevronDown className="w-3 h-3" /></button>
                      </div>
                  )}
                  {renderWidget(widget)}
              </div>
          ))}
          
          {layout.length === 0 && (
              <div className="col-span-full py-20 text-center text-scada-muted border-2 border-dashed border-scada-border rounded-lg">
                  <p>Dashboard is empty.</p>
                  {isEditing && <p className="text-sm mt-2">Use the toolbar above to add widgets.</p>}
              </div>
          )}
      </div>
    </div>
  );
};
