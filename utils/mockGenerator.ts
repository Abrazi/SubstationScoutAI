
import { IEDNode, NodeType, ModbusRegister } from "../types";
import { LOGICAL_NODE_DESCRIPTIONS } from "../constants";

let idCounter = 0;
const getId = () => `node-${idCounter++}`;

// --- Helper Functions from previous version ---
const createDA = (name: string, value: any, pathPrefix: string, enums?: string[]): IEDNode => ({
  id: getId(),
  name,
  type: NodeType.DA,
  value,
  path: `${pathPrefix}.${name}`,
  description: `Data Attribute: ${name}`,
  validValues: enums,
  attributes: { fc: 'ST', q: '0x0000 (Good)', t: new Date().toISOString() } 
});

const createDO = (name: string, childGenerators: ((path: string) => IEDNode)[], pathPrefix: string): IEDNode => {
  const currentPath = `${pathPrefix}.${name}`;
  const children = childGenerators.map(gen => gen(currentPath));
  return { id: getId(), name, type: NodeType.DO, path: currentPath, description: `Data Object: ${name}`, children };
};

const createDataSet = (name: string, pathPrefix: string, entries: string[]): IEDNode => {
    return {
        id: getId(), name, type: NodeType.DataSet, path: `${pathPrefix}.${name}`, description: 'GOOSE Data Set',
        children: entries.map(entryPath => ({
            id: getId(), name: entryPath.split('.').pop() || 'FCDA', type: NodeType.DA, path: entryPath, description: `Ref: ${entryPath}`, value: 'Reference'
        }))
    };
};

const createGSEControl = (name: string, pathPrefix: string, datSet: string, appID: string): IEDNode => {
    return {
        id: getId(), name, type: NodeType.GSE, path: `${pathPrefix}.${name}`, description: 'GOOSE Control Block',
        gooseConfig: { appID, confRev: 1, minTime: 10, maxTime: 2000, datSet },
        children: [ createDA('GoEna', false, `${pathPrefix}.${name}`), createDA('AppID', appID, `${pathPrefix}.${name}`), createDA('DatSet', datSet, `${pathPrefix}.${name}`)]
    };
};

const createLN = (prefix: string, lnClass: string, inst: string, pathPrefix: string): IEDNode => {
  const name = `${prefix}${lnClass}${inst}`;
  const currentPath = `${pathPrefix}/${name}`;
  const desc = LOGICAL_NODE_DESCRIPTIONS[lnClass] || 'Generic Logical Node';
  
  const modEnums = ['on', 'on-blocked', 'test', 'test/blocked', 'off'];
  const behEnums = ['on', 'on-blocked', 'test', 'test/blocked', 'off'];
  const healthEnums = ['Ok', 'Warning', 'Alarm'];
  const posEnums = ['intermediate', 'off', 'on', 'bad'];
  const ctlModelEnums = ['status-only', 'direct-with-normal-security', 'sbo-with-normal-security', 'direct-with-enhanced-security', 'sbo-with-enhanced-security'];

  const childrenGenerators: ((path: string) => IEDNode)[] = [
    (p) => createDO('Mod', [(sp) => createDA('stVal', 'on', sp, modEnums), (sp) => createDA('ctlModel', 'status-only', sp, ctlModelEnums)], p),
    (p) => createDO('Beh', [(sp) => createDA('stVal', 'on', sp, behEnums)], p),
    (p) => createDO('Health', [(sp) => createDA('stVal', 'Ok', sp, healthEnums)], p)
  ];

  if (lnClass === 'MMXU') {
    childrenGenerators.push(
      (p) => createDO('TotW', [(sp) => createDA('mag', '0.0', sp)], p),
      (p) => createDO('PhV', [(sp) => createDA('phsA', '0.0', sp)], p),
      (p) => createDO('A', [(sp) => createDA('phsA', '0.0', sp)], p)
    );
  } else if (lnClass === 'XCBR') {
    childrenGenerators.push(
      (p) => createDO('Pos', [(sp) => createDA('stVal', 'open', sp, posEnums), (sp) => createDA('ctlModel', 'sbo-with-enhanced-security', sp, ctlModelEnums)], p),
      (p) => createDO('BlkOpn', [(sp) => createDA('stVal', false, sp)], p),
      (p) => createDO('BlkCls', [(sp) => createDA('stVal', false, sp)], p)
    );
  }

  const children = childrenGenerators.map(gen => gen(currentPath));

  if (lnClass === 'LLN0') {
      const xcbrPath = `${pathPrefix}/XCBR1.Pos.stVal`;
      const xcbrQPath = `${pathPrefix}/XCBR1.Pos.q`;
      const dsName = 'ds_Status';
      const dsPath = `${currentPath}.${dsName}`;
      children.push(createDataSet(dsName, currentPath, [xcbrPath, xcbrQPath]), createGSEControl('gocb0', currentPath, dsPath, '0001'));
  }

  return { id: getId(), name, type: NodeType.LN, path: currentPath, description: desc, children };
};

// --- New Fleet Generation Logic ---

const GEN_IP_MAP: Record<string, string> = {
    "G1": "172.16.31.13", "G2": "172.16.31.23", "G3": "172.16.31.33", "G4": "172.16.31.43", "G5": "172.16.31.53",
    "G6": "172.16.32.13", "G7": "172.16.32.23", "G8": "172.16.32.33", "G9": "172.16.32.43", "G10": "172.16.32.53",
    "G11": "172.16.33.13", "G12": "172.16.33.23", "G13": "172.16.33.33", "G14": "172.16.33.43", "G15": "172.16.33.53",
    "G16": "172.16.34.13", "G17": "172.16.34.23", "G18": "172.16.34.33", "G19": "172.16.34.43", "G20": "172.16.34.53",
    "G21": "172.16.35.13", "G22": "172.16.35.23"
};

// Based on the provided CSV export R000 to R200
const createGeneratorModbusMap = (): ModbusRegister[] => {
    const map: ModbusRegister[] = [];
    // Measurements
    map.push({ address: 76, type: 'HoldingRegister', value: 0, name: 'Frequency', description: 'x100 (e.g. 5000 = 50Hz)' });
    map.push({ address: 77, type: 'HoldingRegister', value: 0, name: 'Current', description: 'Amps' });
    map.push({ address: 78, type: 'HoldingRegister', value: 0, name: 'Voltage', description: 'Volts' });
    map.push({ address: 129, type: 'HoldingRegister', value: 0, name: 'Active Power', description: 'kW' });
    map.push({ address: 130, type: 'HoldingRegister', value: 0, name: 'Reactive Power', description: 'kVAr' });
    
    // Status Words
    map.push({ address: 14, type: 'HoldingRegister', value: 0, name: 'Status Word 1', description: 'Bit 4: CB Closed, Bit 8: Running' });
    map.push({ address: 15, type: 'HoldingRegister', value: 0, name: 'Status Word 2', description: 'Bit 2: Starting, Bit 3: Ready' });
    map.push({ address: 23, type: 'HoldingRegister', value: 0, name: 'Extended Status', description: 'Fast Start Ready' });
    map.push({ address: 29, type: 'HoldingRegister', value: 0, name: 'Alarm List', description: 'Common Alarm / Start Fail' });
    map.push({ address: 30, type: 'HoldingRegister', value: 0, name: 'Load Control Status', description: 'Load Sharing Active' });
    map.push({ address: 31, type: 'HoldingRegister', value: 0, name: 'Engine Status', description: '0=Init, 2=Start, 4=Load' });
    map.push({ address: 109, type: 'HoldingRegister', value: 0, name: 'Blocking/Failures', description: 'De-excited / Load Rejected' });

    // Commands
    map.push({ address: 95, type: 'HoldingRegister', value: 0, name: 'Simulation Control', description: 'Bit 0: Fail Start, Bit 4: Reset Fault' });
    map.push({ address: 192, type: 'HoldingRegister', value: 0, name: 'Command Word', description: 'Bit 0: Demand, Bit 3: Dead Bus' });
    
    return map;
};

export const generateMockIED = (name: string): IEDNode => {
    // Legacy mock function (kept for compatibility)
    return generateFleet()[0];
};

export const generateFleet = (): IEDNode[] => {
    const fleet: IEDNode[] = [];

    // 1. Create Generators
    Object.entries(GEN_IP_MAP).forEach(([name, ip]) => {
        fleet.push({
            id: name, // Use Name as ID for easier script mapping
            name: name,
            type: NodeType.IED,
            path: name,
            description: `Diesel Generator Controller (${ip})`,
            config: {
                ip: ip,
                subnet: '255.255.0.0',
                gateway: '172.16.0.1',
                vlan: 30,
                role: 'server',
                modbusPort: 502,
                modbusUnitId: 1,
                modbusMap: createGeneratorModbusMap()
            },
            children: []
        });
    });

    // 2. Create Switchgears (Simple Mock)
    const swgs = [
        { name: "GPS1", ip: "172.16.31.63" },
        { name: "GPS2", ip: "172.16.32.63" },
        { name: "GPS3", ip: "172.16.33.63" },
        { name: "GPS4", ip: "172.16.34.63" }
    ];

    swgs.forEach(swg => {
        fleet.push({
            id: swg.name,
            name: swg.name,
            type: NodeType.IED,
            path: swg.name,
            description: "Main Switchgear Controller",
            config: {
                ip: swg.ip,
                subnet: '255.255.0.0',
                gateway: '172.16.0.1',
                vlan: 30,
                role: 'server',
                modbusPort: 502,
                modbusUnitId: 1,
                modbusMap: [
                    { address: 74, type: 'HoldingRegister', value: 0, name: 'Total Demand', description: 'kW' },
                    { address: 901, type: 'HoldingRegister', value: 0, name: 'Online Gens', description: 'Count' }
                ]
            },
            children: []
        });
    });

    return fleet;
};
