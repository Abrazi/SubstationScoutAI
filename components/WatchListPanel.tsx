import React, { useState, useEffect } from 'react';
import { Icons } from './Icons';
import { WatchItem } from '../types';
import { engine } from '../services/SimulationEngine';

interface WatchListPanelProps {
  items: WatchItem[];
  onRemove: (id: string) => void;
}

export const WatchListPanel: React.FC<WatchListPanelProps> = ({ items, onRemove }) => {
  const [values, setValues] = useState<Record<string, any>>({});

  // Polling loop for watched values
  useEffect(() => {
    const fetchValues = () => {
      const nextValues: Record<string, any> = {};
      
      items.forEach(item => {
        try {
          if (item.source === 'IEC61850') {
            const val = engine.readMMS(String(item.addressOrPath));
            nextValues[item.id] = val !== undefined ? val : 'N/A';
          } else if (item.source === 'Modbus' && item.modbusType) {
            const addr = Number(item.addressOrPath);
            let val;
            switch(item.modbusType) {
              case 'Coil': val = engine.getCoil(addr); break;
              case 'DiscreteInput': val = engine.getDiscreteInput(addr); break;
              case 'InputRegister': val = engine.getInputRegister(addr); break;
              case 'HoldingRegister': val = engine.getRegister(addr); break;
            }
            nextValues[item.id] = val !== undefined ? val : 'Err';
          }
        } catch (e) {
          nextValues[item.id] = 'Error';
        }
      });
      
      setValues(nextValues);
    };

    const interval = setInterval(fetchValues, 500); // 2Hz Update Rate
    fetchValues(); // Initial fetch
    return () => clearInterval(interval);
  }, [items]);

  return (
    <div className="flex flex-col h-full bg-scada-panel border-t border-scada-border">
      <div className="p-3 border-b border-scada-border bg-scada-bg/30 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icons.Eye className="w-4 h-4 text-scada-accent" />
          <span className="font-semibold text-sm text-gray-200">Watch List</span>
          <span className="text-xs bg-scada-border px-1.5 rounded text-scada-muted">{items.length}</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {items.length === 0 && (
          <div className="flex flex-col items-center justify-center h-24 text-scada-muted opacity-50 text-xs text-center px-4">
            <Icons.List className="w-8 h-8 mb-2" />
            <p>Select a Data Attribute or Register and click "Watch" to monitor it here.</p>
          </div>
        )}

        {items.map(item => (
          <div key={item.id} className="bg-scada-bg border border-scada-border rounded p-2 flex items-center justify-between group hover:border-scada-accent/50 transition-colors shadow-sm">
            <div className="flex-1 min-w-0 mr-2">
              <div className="flex items-center gap-2 mb-0.5">
                <span className={`text-[10px] font-bold uppercase px-1 rounded border ${
                  item.source === 'IEC61850' 
                    ? 'text-purple-400 bg-purple-400/10 border-purple-400/20' 
                    : 'text-yellow-400 bg-yellow-400/10 border-yellow-400/20'
                }`}>
                  {item.source === 'IEC61850' ? 'IEC 61850' : 'MODBUS'}
                </span>
                <span className="text-xs text-scada-muted truncate font-mono" title={String(item.addressOrPath)}>
                  {String(item.addressOrPath).replace(/.*\//, '')}
                </span>
              </div>
              <div className="text-sm font-medium text-gray-200 truncate" title={item.label}>
                {item.label}
              </div>
            </div>

            <div className="flex items-center gap-3">
              <div className="text-right">
                <div className={`font-mono font-bold ${typeof values[item.id] === 'boolean' ? (values[item.id] ? 'text-scada-success' : 'text-scada-danger') : 'text-scada-accent'}`}>
                   {typeof values[item.id] === 'boolean' 
                      ? (values[item.id] ? 'ON' : 'OFF') 
                      : values[item.id]}
                </div>
              </div>
              <button 
                onClick={() => onRemove(item.id)}
                className="opacity-0 group-hover:opacity-100 text-scada-muted hover:text-scada-danger transition-opacity"
                title="Remove from watch list"
              >
                <Icons.Trash className="w-3 h-3" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
