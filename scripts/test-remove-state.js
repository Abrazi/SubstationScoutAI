const fs = require('fs');
const src = fs.readFileSync('./utils/generatorLogic.ts','utf8');
const m = src.match(/export const GENERATOR_LOGIC_SCRIPT = `([\s\S]*)`;/);
if(!m) { console.error('GENERATOR_LOGIC_SCRIPT not found'); process.exit(1); }
let code = m[1];

function removeStateFromCode(code, stateId, stateVarName = 'state') {
  if (!stateId) return code;
  const escState = stateId.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
  const varRe = new RegExp('^\\s*' + escState + '\\s*:\\s*INT\\s*:=\\s*(\\d+);\\s*\\n?', 'm');
  let out = code.replace(varRe, '');
  const stepBlockRe = new RegExp('(?:IF|ELSIF)\\s+' + stateVarName + '\\s*=\\s*' + escState + '\\s+THEN[\\s\\S]*?(?=(?:\\n\\s*(?:ELSIF\\s+' + stateVarName + '|END_IF;)|$))', 'i');
  out = out.replace(stepBlockRe, '');
  const assignRe = new RegExp('\\b' + stateVarName.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&') + '\\s*:=\\s*' + escState + '\\b;?', 'g');
  out = out.replace(assignRe, '');
  return out;
}

const out = removeStateFromCode(code, 'STATE_FAST_TRANSFER', 'CurrentState');
console.log('Original contains STATE_FAST_TRANSFER?', code.indexOf('STATE_FAST_TRANSFER') !== -1);
console.log('\n--- varRe test ---');
const escState = 'STATE_FAST_TRANSFER'.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
const varRe = new RegExp('^\\s*' + escState + '\\s*:\\s*INT\\s*:=\\s*(\\d+);\\s*\\n?', 'm');
console.log('varRe.test(code):', varRe.test(code));
const varMatch = code.match(varRe);
console.log('varMatch:', varMatch && varMatch[0]);
console.log('\nResult contains STATE_FAST_TRANSFER?', out.indexOf('STATE_FAST_TRANSFER') !== -1);
console.log('First 300 chars of result:\n', out.slice(0,300));
