const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'utils', 'generatorLogic.ts'), 'utf8');
const m = src.match(/export const GENERATOR_LOGIC_SCRIPT = `([\s\S]*)`;/);
if (!m) {
  console.error('GENERATOR_LOGIC_SCRIPT not found');
  process.exit(1);
}
let st = m[1];
// Strip multi-line PLC-style block comments first (same as SimulationEngine.compile)
st = st.replace(/\(\*[\s\S]*?\*\)/g, '');

const transformLine = (line) => {
  let jsLine = line.replace(/\(\*[\s\S]*?\*\)/g, '');
  jsLine = jsLine
    .replace(/Device\.ReadInput\('(\d+)'\)/g, 'ctx.readInput($1)')
    .replace(/Device\.WriteCoil\('(\d+)',\s*(.*)\)/g, 'ctx.writeCoil($1, $2)')
    .replace(/Device\.SetDA\('([^']+)',\s*(.*)\)/g, "ctx.setDAValue('$1', $2)")
    .replace(/Device\.GetDA\('([^']+)'\)/g, "ctx.getDAValue('$1')")
    .replace(/Device\.Log\((.*)\)/g, 'ctx.Log($1)')
    .replace(/Device\.ReadRegister\('(\d+)'\)/g, 'ctx.readRegister($1)')
    .replace(/Device\.WriteRegister\('(\d+)',\s*(.*)\)/g, 'ctx.writeRegister($1, $2)')

    // ST -> JS
    .replace(/:=/g, '=')
    .replace(/<>/g, '!==')
    .replace(/\bTRUE\b/g, 'true')
    .replace(/\bFALSE\b/g, 'false')
    .replace(/\bAND\b/g, '&&')
    .replace(/\bOR\b/g, '||')
    .replace(/\bNOT\b/g, '!')
    .replace(/\bIF\s+(.*)\s+THEN/g, 'if ($1) {')
    .replace(/\bELSIF\s+(.*)\s+THEN/g, '} else if ($1) {')
    .replace(/\bELSE\b/g, '} else {')
    .replace(/\bEND_IF;/g, '}')
    .replace(/\bWHILE\s+(.*)\s+DO/g, 'while ($1) {')
    .replace(/\bEND_WHILE;/g, '}')

    .replace(/\bSQRT\(/g, 'Math.sqrt(')
    .replace(/\bABS\(/g, 'Math.abs(')
    .replace(/\bTO_INT\(/g, 'Math.floor(')
    .replace(/\bTRUNC\(/g, 'Math.trunc(')
    .replace(/\bREAL_TO_INT\(/g, 'Math.floor(')
    .replace(/\bMOD\b/g, '%')

    // VAR handling
    .replace(/\bVAR\s+([a-zA-Z0-9_]+)(\s*:\s*[a-zA-Z0-9_]+)?\s*;/g, '')
    .replace(/\bVAR\s+([a-zA-Z0-9_]+)/g, 'scope.$1')
    .replace(/\bEND_VAR\b/g, '')
    .replace(/FUNCTION_BLOCK.*$/gm, '')
    .replace(/END_FUNCTION_BLOCK/gm, '');
  return jsLine;
};

const lines = st.split('\n');
const instrumented = lines.map((l, i) => `yield ${i + 1}; ${transformLine(l)}`);
const wrapped = `return function*(ctx, scope) { with(scope) {\n${instrumented.join('\n')}\n}}`;

// sanity parse
try {
  new Function(wrapped);
  console.log('Wrapped function compiles successfully.');
} catch (err) {
  console.error('Wrapped function failed to compile:', err && err.message);
}

// Find suspicious assignments where LHS is not a valid simple JS lvalue
const lvalueRe = /^[a-zA-Z_$][\w$]*(?:\.(?:[a-zA-Z_$][\w$]*|\[[^\]]+\]))*(?:\[[^\]]+\])?$/;
instrumented.forEach((ln, idx) => {
  const js = ln.split(';').slice(1).join(';').trim();
  const eqIndex = js.indexOf('=');
  if (eqIndex <= 0) return;
  const lhs = js.slice(0, eqIndex).trim();
  // If lhs doesn't match a conservative lvalue regex, flag it
  if (!lvalueRe.test(lhs)) {
    console.log(`Suspicious/invalid LHS at source line ${idx + 1}: "${lhs}"  -> ${js}`);
  }
});

// Also detect where ctx.Log(...) ended up on the left side of '='
instrumented.forEach((ln, idx) => {
  const js = ln.split(';').slice(1).join(';').trim();
  if (/ctx\.Log\(/.test(js) && /=/.test(js)) {
    console.log(`ctx.Log found on a line with '=' at source line ${idx + 1}: ${js}`);
  }
});

// Print nearby context for lines flagged by tests or known suspects
lines.forEach((l, i) => {
  if (/Device\.Log\(/.test(l) || /Device\.WriteRegister\(|Device\.WriteCoil\(/.test(l)) {
    console.log('\n-- source around line', i+1, '--');
    console.log(lines.slice(Math.max(0,i-3), i+3).join('\n'));
  }
});
