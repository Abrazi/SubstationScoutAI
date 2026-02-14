import React from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { SimulationData } from '../types';

interface ChartProps {
  data: (SimulationData & { time: string })[];
  type: 'voltage' | 'current';
}

export const SimulationChart: React.FC<ChartProps> = ({ data, type }) => {
  const isVoltage = type === 'voltage';
  
  return (
    <div className="w-full h-48 bg-scada-panel border border-scada-border rounded p-2">
      <div className="flex justify-between items-center mb-2 px-2">
        <h3 className="text-xs uppercase font-bold text-scada-muted tracking-wider">
          {isVoltage ? 'Phasor Voltages (kV)' : 'Phasor Currents (A)'}
        </h3>
        <span className="text-xs text-scada-accent animate-pulse">● LIVE</span>
      </div>
      <ResponsiveContainer width="100%" height="80%">
        <LineChart data={data}>
          <XAxis dataKey="time" hide />
          <YAxis domain={['auto', 'auto']} stroke="#475569" fontSize={10} />
          <Tooltip 
            contentStyle={{ backgroundColor: '#1e293b', borderColor: '#334155', fontSize: '12px' }}
            itemStyle={{ padding: 0 }}
          />
          <Line 
            type="monotone" 
            dataKey={isVoltage ? "voltageA" : "currentA"} 
            stroke="#ef4444" 
            strokeWidth={2} 
            dot={false} 
            isAnimationActive={false}
          />
          <Line 
            type="monotone" 
            dataKey={isVoltage ? "voltageB" : "currentB"} 
            stroke="#f59e0b" 
            strokeWidth={2} 
            dot={false} 
            isAnimationActive={false}
          />
          <Line 
            type="monotone" 
            dataKey={isVoltage ? "voltageC" : "currentC"} 
            stroke="#06b6d4" 
            strokeWidth={2} 
            dot={false} 
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
};
