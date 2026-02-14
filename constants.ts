export const LOGICAL_NODE_DESCRIPTIONS: Record<string, string> = {
  // System
  'LPHD': 'Physical Device Information',
  'LLN0': 'Logical Node Zero (Common)',
  
  // Protection
  'PDIS': 'Distance Protection',
  'PTOC': 'Time Overcurrent Protection',
  'PIOC': 'Instantaneous Overcurrent Protection',
  'PDIF': 'Differential Protection',
  'PTOF': 'Overfrequency Protection',
  'PTUF': 'Underfrequency Protection',
  
  // Control
  'CSWI': 'Switch Controller',
  'CILO': 'Interlocking',
  'GGIO': 'Generic I/O',
  
  // Switchgear
  'XCBR': 'Circuit Breaker',
  'XSWI': 'Circuit Switch',
  
  // Measurement
  'MMXU': 'Measurement Unit (3-Phase)',
  'MMTR': 'Metering (Energy)',
  
  // Sensors
  'TCTR': 'Current Transformer',
  'TVTR': 'Voltage Transformer',
};

export const MOCK_IED_NAMES = [
  'IED_Bay_01_Main',
  'IED_Bay_01_Backup',
  'IED_Trafo_HV',
  'IED_Busbar_Prot',
  'RTU_Gateway_01'
];
