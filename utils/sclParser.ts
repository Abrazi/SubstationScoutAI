
import { IEDNode, NodeType, IEDConfig } from '../types';
import { LOGICAL_NODE_DESCRIPTIONS } from '../constants';

let idCounter = 10000;
const genId = () => `imported-${idCounter++}`;

const getAttr = (el: Element, name: string): string | undefined => el.getAttribute(name) || undefined;
const getVal = (el: Element): string | undefined => el.querySelector('Val')?.textContent?.trim();

// Definition Interfaces
interface DODef { name: string; type?: string; desc?: string; }
interface SDODef { name: string; type?: string; desc?: string; isSDO: true; }
interface DADef { name: string; type?: string; bType?: string; fc?: string; desc?: string; val?: string; isSDO?: false; }
interface BDADef { name: string; type?: string; bType?: string; desc?: string; val?: string; }

interface TemplateStore {
  lNodeTypes: Map<string, DODef[]>;
  doTypes: Map<string, (SDODef | DADef)[]>;
  daTypes: Map<string, BDADef[]>;
  enumTypes: Map<string, string[]>;
}

type ProtocolHint = 'mms' | 'goose' | 'sv';

export interface SclCommunicationAddress {
    ip: string;
    subnet?: string;
    gateway?: string;
    subNetwork?: string;
    protocolHints?: ProtocolHint[];
}

const parseTemplates = (doc: Document): TemplateStore => {
  const store: TemplateStore = {
    lNodeTypes: new Map(),
    doTypes: new Map(),
    daTypes: new Map(),
    enumTypes: new Map(),
  };

  const templates = doc.querySelector('DataTypeTemplates');
  if (!templates) return store;

  // 1. LNodeTypes
  templates.querySelectorAll('LNodeType').forEach(el => {
    const id = el.getAttribute('id');
    if (!id) return;
    const dos: DODef[] = [];
    el.querySelectorAll('DO').forEach(d => {
      dos.push({
        name: d.getAttribute('name') || 'Unknown',
        type: d.getAttribute('type') || undefined,
        desc: getAttr(d, 'desc')
      });
    });
    store.lNodeTypes.set(id, dos);
  });

  // 2. DOTypes
  templates.querySelectorAll('DOType').forEach(el => {
    const id = el.getAttribute('id');
    if (!id) return;
    const children: (SDODef | DADef)[] = [];
    
    // SDOs (Nested DOs)
    el.querySelectorAll('SDO').forEach(sdo => {
       children.push({
         name: sdo.getAttribute('name') || 'Unknown',
         type: sdo.getAttribute('type') || undefined,
         desc: getAttr(sdo, 'desc'),
         isSDO: true
       });
    });

    // DAs (Data Attributes)
    el.querySelectorAll('DA').forEach(da => {
      children.push({
        name: da.getAttribute('name') || 'Unknown',
        type: da.getAttribute('type') || undefined,
        bType: getAttr(da, 'bType'),
        fc: getAttr(da, 'fc'),
        desc: getAttr(da, 'desc'),
        val: getVal(da),
        isSDO: false
      });
    });

    store.doTypes.set(id, children);
  });

  // 3. DATypes
  templates.querySelectorAll('DAType').forEach(el => {
    const id = el.getAttribute('id');
    if (!id) return;
    const bdas: BDADef[] = [];
    el.querySelectorAll('BDA').forEach(bda => {
      bdas.push({
        name: bda.getAttribute('name') || 'Unknown',
        type: bda.getAttribute('type') || undefined,
        bType: getAttr(bda, 'bType'),
        desc: getAttr(bda, 'desc'),
        val: getVal(bda)
      });
    });
    store.daTypes.set(id, bdas);
  });
  
  // 4. EnumTypes
  templates.querySelectorAll('EnumType').forEach(el => {
      const id = el.getAttribute('id');
      if (!id) return;
      const vals: string[] = [];
      el.querySelectorAll('EnumVal').forEach(ev => vals.push(ev.textContent || ''));
      store.enumTypes.set(id, vals);
  });

  return store;
};

const expandReference = (
    def: SDODef | DADef | BDADef, 
    store: TemplateStore, 
    pathPrefix: string, 
    depth: number
): IEDNode => {
    const isSDO = (def as any).isSDO === true;
    const daDef = def as DADef; 
    const isStruct = daDef.bType === 'Struct';
    
    const currentPath = `${pathPrefix}.${def.name}`;
    const node: IEDNode = {
        id: genId(),
        name: def.name,
        type: isSDO ? NodeType.DO : NodeType.DA,
        path: currentPath,
        description: def.desc,
        value: daDef.val,
        attributes: {},
        children: []
    };

    if (daDef.fc) node.attributes!.fc = daDef.fc;
    if (daDef.bType) node.attributes!.bType = daDef.bType;
    if (daDef.type) node.attributes!.typeRef = daDef.type;

    if (depth > 6) return node; // Recursion Limit

    // Expand SDO -> DOType
    if (isSDO && def.type && store.doTypes.has(def.type)) {
        const children = store.doTypes.get(def.type);
        if (children) {
            node.children = children.map(c => expandReference(c, store, currentPath, depth + 1));
        }
    }
    // Expand Struct DA -> DAType
    else if (isStruct && def.type && store.daTypes.has(def.type)) {
        const children = store.daTypes.get(def.type);
        if (children) {
            node.children = children.map(c => expandReference(c, store, currentPath, depth + 1));
        }
    }
    // Enum Handling
    else if (daDef.bType === 'Enum' && def.type && store.enumTypes.has(def.type)) {
        const enums = store.enumTypes.get(def.type);
        if (enums) {
            node.validValues = enums;
            node.attributes!.enumInfo = `[${enums.slice(0, 3).join(', ')}${enums.length > 3 ? '...' : ''}]`;
        }
    }

    return node;
}

const expandDO = (def: DODef, store: TemplateStore, pathPrefix: string): IEDNode => {
  const currentPath = `${pathPrefix}.${def.name}`;
  const node: IEDNode = {
    id: genId(),
    name: def.name,
    type: NodeType.DO,
    path: currentPath,
    description: def.desc || `Data Object`,
    children: []
  };

  if (def.type && store.doTypes.has(def.type)) {
      const children = store.doTypes.get(def.type);
      if (children) {
          node.children = children.map(da => expandReference(da, store, currentPath, 0));
      }
  }

  return node;
};

export const validateSCL = (xmlText: string): { valid: boolean; error?: string; info?: string } => {
    if (!xmlText || xmlText.trim().length === 0) {
        return { valid: false, error: "File is empty." };
    }

    try {
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(xmlText, "text/xml");

        const parserError = xmlDoc.getElementsByTagName('parsererror');
        if (parserError.length > 0) {
            return { valid: false, error: "Invalid XML syntax." };
        }

        const iedCount = xmlDoc.getElementsByTagName('IED').length;
        if (iedCount === 0 && xmlDoc.getElementsByTagName('SCL').length === 0) {
            return { valid: false, error: "Missing SCL/IED elements." };
        }

        return { valid: true, info: `Found ${iedCount} IED(s)` };
    } catch (e: any) {
        return { valid: false, error: e.message };
    }
};

export const extractIEDs = (xmlText: string): { 
    name: string; 
    desc: string; 
    manufacturer: string; 
    type: string;
    configVersion: string;
    accessPoints: number;
}[] => {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlText, "text/xml");
    if (xmlDoc.getElementsByTagName('parsererror').length > 0) return [];
    
    return Array.from(xmlDoc.querySelectorAll('IED')).map(ied => ({
        name: ied.getAttribute('name') || 'Unknown',
        desc: ied.getAttribute('desc') || '',
        manufacturer: ied.getAttribute('manufacturer') || 'Generic',
        type: ied.getAttribute('type') || 'IED',
        configVersion: ied.getAttribute('configVersion') || '',
        accessPoints: ied.querySelectorAll('AccessPoint').length
    }));
};

// Helper to extract Communication IP parameters
export const extractCommunication = (xmlText: string, iedName: string): Partial<IEDConfig> | null => {
    try {
        const map = extractCommunicationMap(xmlText);
        return map[iedName] || null;

    } catch (e) {
        console.error("Failed to extract communication parameters", e);
        return null;
    }
};

export const extractCommunicationProfiles = (xmlText: string): Record<string, SclCommunicationAddress[]> => {
    const result: Record<string, SclCommunicationAddress[]> = {};

    try {
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(xmlText, 'text/xml');
        if (xmlDoc.getElementsByTagName('parsererror').length > 0) return result;

        const communication = xmlDoc.querySelector('Communication');
        if (!communication) return result;

        const connectedAps = communication.querySelectorAll('SubNetwork ConnectedAP');
        connectedAps.forEach((ap) => {
            const iedName = ap.getAttribute('iedName') || '';
            if (!iedName) return;

            const subNetworkEl = ap.closest('SubNetwork');
            const subNetworkName = subNetworkEl?.getAttribute('name') || undefined;
            const subNetworkType = subNetworkEl?.getAttribute('type') || '';
            const address = ap.querySelector('Address');
            if (!address) return;

            const profile: SclCommunicationAddress = {
                ip: '',
                subnet: undefined,
                gateway: undefined,
                subNetwork: subNetworkName,
                protocolHints: []
            };

            address.querySelectorAll('P').forEach(p => {
                const type = p.getAttribute('type');
                const val = p.textContent?.trim();
                if (!val) return;
                if (type === 'IP') profile.ip = val;
                if (type === 'IP-SUBNET') profile.subnet = val;
                if (type === 'Gateway') profile.gateway = val;
            });

            if (!profile.ip) return;

            const hints = new Set<ProtocolHint>();
            const normalizedSn = `${subNetworkName || ''} ${subNetworkType}`.toLowerCase();
            if (normalizedSn.includes('goose') || normalizedSn.includes('8-1')) hints.add('goose');
            if (normalizedSn.includes('smv') || normalizedSn.includes('9-2') || normalizedSn.includes('sampled')) hints.add('sv');
            if (normalizedSn.includes('mms') || normalizedSn.includes('8-mms') || normalizedSn.includes('station')) hints.add('mms');
            if (ap.querySelector('GSE')) hints.add('goose');
            if (ap.querySelector('SMV')) hints.add('sv');
            if (!hints.has('goose') && !hints.has('sv')) hints.add('mms');
            profile.protocolHints = Array.from(hints);

            const bucket = result[iedName] || [];
            const exists = bucket.some(entry => entry.ip === profile.ip && entry.subNetwork === profile.subNetwork);
            if (!exists) bucket.push(profile);
            result[iedName] = bucket;
        });
    } catch {
        return {};
    }

    return result;
};

export const extractCommunicationMap = (xmlText: string): Record<string, Partial<IEDConfig>> => {
    const result: Record<string, Partial<IEDConfig>> = {};

    try {
        const profiles = extractCommunicationProfiles(xmlText);
        Object.entries(profiles).forEach(([iedName, addresses]) => {
            const mmsEntry = addresses.find(a => a.protocolHints?.includes('mms')) || addresses[0];
            const gooseEntry = addresses.find(a => a.protocolHints?.includes('goose')) || addresses[0];
            if (!mmsEntry) return;

            result[iedName] = {
                ip: mmsEntry.ip,
                mmsIp: mmsEntry.ip,
                gooseIp: gooseEntry?.ip,
                subnet: mmsEntry.subnet,
                gateway: mmsEntry.gateway,
                communicationIps: addresses
            };
        });
    } catch {
        return {};
    }

    return result;
};

const parseIedElement = (iedElement: Element, templates: TemplateStore): IEDNode => {
  const iedName = iedElement.getAttribute('name') || 'Imported_IED';
  const iedDesc = getAttr(iedElement, 'desc') || 'SCL Import';

  const root: IEDNode = {
      id: genId(),
      name: iedName,
      type: NodeType.IED,
      path: iedName,
      description: iedDesc,
      children: []
  };

  iedElement.querySelectorAll('AccessPoint').forEach(ap => {
      const server = ap.querySelector('Server');
      if (!server) return;

      server.querySelectorAll('LDevice').forEach(ld => {
          const inst = ld.getAttribute('inst') || 'LD0';
          const ldName = inst;
          const ldPath = `${iedName}${inst}`;
          const ldDesc = getAttr(ld, 'desc');

          const ldNode: IEDNode = {
              id: genId(),
              name: ldName,
              type: NodeType.LDevice,
              path: ldPath,
              description: ldDesc,
              children: []
          };

          const lns = [...Array.from(ld.querySelectorAll('LN0')), ...Array.from(ld.querySelectorAll('LN'))];
          lns.forEach(ln => {
              const prefix = ln.getAttribute('prefix') || '';
              const lnClass = ln.getAttribute('lnClass') || '';
              const inst = ln.getAttribute('inst') || '';
              const lnType = ln.getAttribute('lnType');

              const nodeName = `${prefix}${lnClass}${inst}`;
              const lnPath = `${ldPath}/${nodeName}`;
              const desc = LOGICAL_NODE_DESCRIPTIONS[lnClass] || `Logical Node ${lnClass}`;

              const lnNode: IEDNode = {
                  id: genId(),
                  name: nodeName,
                  type: NodeType.LN,
                  path: lnPath,
                  description: desc,
                  children: []
              };

              if (lnType && templates.lNodeTypes.has(lnType)) {
                  const doList = templates.lNodeTypes.get(lnType);
                  if (doList) {
                      lnNode.children = doList.map(doDef => expandDO(doDef, templates, lnPath));
                  }
              }

              ldNode.children?.push(lnNode);
          });

          root.children?.push(ldNode);
      });
  });

  return root;
};

export const parseSCLMany = (xmlText: string, targetIEDNames: string[]): IEDNode[] => {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xmlText, 'text/xml');

  if (xmlDoc.getElementsByTagName('parsererror').length > 0) {
      throw new Error('Invalid XML file.');
  }

  const templates = parseTemplates(xmlDoc);
  const wanted = new Set(targetIEDNames.filter(Boolean));
  const allIeds = Array.from(xmlDoc.querySelectorAll('IED'));

  if (wanted.size === 0) return [];

  const selected = allIeds.filter(el => wanted.has(el.getAttribute('name') || ''));
  return selected.map(el => parseIedElement(el, templates));
};

export const parseSCL = (xmlText: string, targetIEDName?: string): IEDNode => {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xmlText, "text/xml");
  
  if (xmlDoc.getElementsByTagName('parsererror').length > 0) {
      throw new Error("Invalid XML file.");
  }

  const templates = parseTemplates(xmlDoc);
  
  let iedElement: Element | null = null;
  if (targetIEDName) {
      // Find the specific IED requested
      const ieds = Array.from(xmlDoc.querySelectorAll('IED'));
      iedElement = ieds.find(el => el.getAttribute('name') === targetIEDName) || null;
      if (!iedElement) {
          throw new Error(`IED '${targetIEDName}' not found in SCL.`);
      }
  } else {
      // Default to first IED
      iedElement = xmlDoc.querySelector('IED');
  }
  
  if (!iedElement) {
      throw new Error("No IED element found in SCL file.");
  }

  return parseIedElement(iedElement, templates);
};
