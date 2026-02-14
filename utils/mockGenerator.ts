
import { IEDNode, NodeType } from "../types";
import { LOGICAL_NODE_DESCRIPTIONS } from "../constants";

let idCounter = 0;
const getId = () => `node-${idCounter++}`;

const createDA = (name: string, value: any, pathPrefix: string, enums?: string[]): IEDNode => ({
  id: getId(),
  name,
  type: NodeType.DA,
  value,
  path: `${pathPrefix}.${name}`,
  description: `Data Attribute: ${name}`,
  validValues: enums,
  attributes: { 
    fc: 'ST', // Functional Constraint: Status 
    q: '0x0000 (Good)', 
    t: new Date().toISOString() 
  } 
});

const createDO = (name: string, childGenerators: ((path: string) => IEDNode)[], pathPrefix: string): IEDNode => {
  const currentPath = `${pathPrefix}.${name}`;
  const children = childGenerators.map(gen => gen(currentPath));
  
  return {
    id: getId(),
    name,
    type: NodeType.DO,
    path: currentPath,
    description: `Data Object: ${name}`,
    children
  };
};

const createDataSet = (name: string, pathPrefix: string, entries: string[]): IEDNode => {
    return {
        id: getId(),
        name,
        type: NodeType.DataSet,
        path: `${pathPrefix}.${name}`,
        description: 'GOOSE Data Set',
        children: entries.map(entryPath => ({
            id: getId(),
            name: entryPath.split('.').pop() || 'FCDA',
            type: NodeType.DA,
            path: entryPath, // This acts as a reference
            description: `Ref: ${entryPath}`,
            value: 'Reference'
        }))
    };
};

const createGSEControl = (name: string, pathPrefix: string, datSet: string, appID: string): IEDNode => {
    return {
        id: getId(),
        name,
        type: NodeType.GSE,
        path: `${pathPrefix}.${name}`,
        description: 'GOOSE Control Block',
        gooseConfig: {
            appID,
            confRev: 1,
            minTime: 10,  // 10ms (burst)
            maxTime: 2000, // 2s (heartbeat)
            datSet
        },
        children: [
            createDA('GoEna', false, `${pathPrefix}.${name}`),
            createDA('AppID', appID, `${pathPrefix}.${name}`),
            createDA('DatSet', datSet, `${pathPrefix}.${name}`),
        ]
    };
};

const createLN = (prefix: string, lnClass: string, inst: string, pathPrefix: string): IEDNode => {
  const name = `${prefix}${lnClass}${inst}`;
  const currentPath = `${pathPrefix}/${name}`;
  const desc = LOGICAL_NODE_DESCRIPTIONS[lnClass] || 'Generic Logical Node';
  
  // Common Enum Types
  const modEnums = ['on', 'on-blocked', 'test', 'test/blocked', 'off'];
  const behEnums = ['on', 'on-blocked', 'test', 'test/blocked', 'off'];
  const healthEnums = ['Ok', 'Warning', 'Alarm'];
  const posEnums = ['intermediate', 'off', 'on', 'bad'];
  const ctlModelEnums = [
      'status-only', 
      'direct-with-normal-security', 
      'sbo-with-normal-security', 
      'direct-with-enhanced-security', 
      'sbo-with-enhanced-security'
  ];

  const childrenGenerators: ((path: string) => IEDNode)[] = [
    (p) => createDO('Mod', [
        (sp) => createDA('stVal', 'on', sp, modEnums),
        (sp) => createDA('ctlModel', 'status-only', sp, ctlModelEnums) // Mod usually status-only or direct
    ], p),
    (p) => createDO('Beh', [(sp) => createDA('stVal', 'on', sp, behEnums)], p),
    (p) => createDO('Health', [(sp) => createDA('stVal', 'Ok', sp, healthEnums)], p)
  ];

  if (lnClass === 'MMXU') {
    childrenGenerators.push(
      (p) => createDO('TotW', [(sp) => createDA('mag', '120.5', sp)], p),
      (p) => createDO('TotVAr', [(sp) => createDA('mag', '45.2', sp)], p),
      (p) => createDO('PhV', [
          (sp) => createDA('phsA', '110.2', sp), 
          (sp) => createDA('phsB', '109.8', sp), 
          (sp) => createDA('phsC', '110.5', sp)
      ], p),
      (p) => createDO('A', [
          (sp) => createDA('phsA', '450.0', sp), 
          (sp) => createDA('phsB', '448.2', sp), 
          (sp) => createDA('phsC', '451.5', sp)
      ], p)
    );
  } else if (lnClass === 'XCBR') {
    childrenGenerators.push(
      (p) => createDO('Pos', [
          (sp) => createDA('stVal', 'open', sp, posEnums), 
          (sp) => createDA('q', 'good', sp),
          // Default to SBO with Enhanced Security for Circuit Breakers
          (sp) => createDA('ctlModel', 'sbo-with-enhanced-security', sp, ctlModelEnums),
          (sp) => createDA('sboTimeout', '30000', sp), // 30s timeout
          (sp) => createDA('origin', 'remote', sp)
      ], p),
      (p) => createDO('BlkOpn', [(sp) => createDA('stVal', false, sp)], p),
      (p) => createDO('BlkCls', [(sp) => createDA('stVal', false, sp)], p)
    );
  } else if (lnClass === 'CSWI') {
      // Switch Controller
      childrenGenerators.push(
          (p) => createDO('Pos', [
              (sp) => createDA('stVal', 'open', sp, posEnums),
              (sp) => createDA('ctlModel', 'sbo-with-enhanced-security', sp, ctlModelEnums)
          ], p)
      );
  }

  // Generate Base Children
  const children = childrenGenerators.map(gen => gen(currentPath));

  // Add GSE and DataSet to LLN0
  if (lnClass === 'LLN0') {
      // Create Dataset referencing the XCBR1.Pos.stVal (assuming it exists in the same LD)
      // pathPrefix is like "IED...LD0"
      // XCBR1 path would be "IED...LD0/XCBR1"
      const xcbrPath = `${pathPrefix}/XCBR1.Pos.stVal`;
      const xcbrQPath = `${pathPrefix}/XCBR1.Pos.q`;

      const dsName = 'ds_Status';
      const dsPath = `${currentPath}.${dsName}`;

      const dataSet = createDataSet(dsName, currentPath, [xcbrPath, xcbrQPath]);
      
      const gse = createGSEControl('gocb0', currentPath, dsPath, '0001');

      children.push(dataSet, gse);
  }

  return {
    id: getId(),
    name,
    type: NodeType.LN,
    path: currentPath,
    description: desc,
    children
  };
};

export const generateMockIED = (name: string): IEDNode => {
  const iedPath = name;
  const ldName = 'LD0';
  const ldPath = `${iedPath}${ldName}`;

  return {
    id: getId(),
    name: name,
    type: NodeType.IED,
    path: iedPath,
    description: "Simulated IEC 61850 Server",
    children: [
      {
        id: getId(),
        name: ldName,
        type: NodeType.LDevice,
        path: ldPath,
        description: "Logical Device 0",
        children: [
          createLN('', 'LLN0', '', ldPath),
          createLN('', 'LPHD', '1', ldPath),
          createLN('Prot', 'PTOC', '1', ldPath),
          createLN('Prot', 'PIOC', '1', ldPath),
          createLN('Ctrl', 'CSWI', '1', ldPath),
          createLN('Meas', 'MMXU', '1', ldPath),
          createLN('IO', 'XCBR', '1', ldPath),
        ]
      }
    ]
  };
};
