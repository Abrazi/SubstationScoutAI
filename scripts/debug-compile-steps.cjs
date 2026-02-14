// Debug script to see the intermediate transformation steps

const fs = require('fs');
const path = require('path');

// Read the generator logic
const generatorLogicPath = path.join(__dirname, '../utils/generatorLogic.ts');
const content = fs.readFileSync(generatorLogicPath, 'utf8');

// Extract GENERATOR_LOGIC_SCRIPT
const match = content.match(/export const GENERATOR_LOGIC_SCRIPT = `([\s\S]*?)`;/);
if (!match) {
  console.error('Could not extract GENERATOR_LOGIC_SCRIPT');
  process.exit(1);
}

let sourceCode = match[1];

console.log('=== ORIGINAL SOURCE (first 500 chars) ===');
console.log(sourceCode.substring(0, 500));
console.log('\n');

// Step 0: Strip comments
let cleanedSource = sourceCode.replace(/\(\*[\s\S]*?\*\)/g, "");

console.log('=== AFTER COMMENT STRIPPING (first 500 chars) ===');
console.log(cleanedSource.substring(0, 500));
console.log('\n');

// Step 0.a: VAR block preprocessing
cleanedSource = cleanedSource.replace(/VAR([\s\S]*?)END_VAR/g, (_m, inner) => {
    return inner.split('\n').map(l => {
        const mInit = l.match(/^\s*([A-Za-z_][\w]*)\s*:\s*[A-Za-z_][\w]*\s*:=\s*(.+);?\s*$/);
        if (mInit) return `scope.${mInit[1]} = ${mInit[2]};`;
        const mNoInit = l.match(/^\s*([A-Za-z_][\w]*)\s*:\s*[A-Za-z_][\w]*\s*;?\s*$/);
        if (mNoInit) return `scope.${mNoInit[1]} = scope.${mNoInit[1]};`;
        return l;
    }).join('\n');
});

console.log('=== AFTER VAR BLOCK PREPROCESSING (first 800 chars) ===');
console.log(cleanedSource.substring(0, 800));
console.log('\n');

// Now do line-by-line transformation on the first problematic line
const lines = cleanedSource.split('\n');

console.log('=== LINE-BY-LINE TRANSFORMATION (first 20 lines) ===');
for (let i = 0; i < Math.min(20, lines.length); i++) {
  let line = lines[i];
  let jsLine = line.replace(/\(\*[\s\S]*?\*\)/g, "");
  
  jsLine = jsLine
    .replace(/Device\.ReadInput\('(\d+)'\)/g, "ctx.readInput($1)")
    .replace(/Device\.WriteCoil\('(\d+)',\s*(.*)\)/g, "ctx.writeCoil($1, $2)")
    .replace(/Device\.SetDA\('([^']+)',\s*(.*)\)/g, "ctx.setDAValue('$1', $2)")
    .replace(/Device\.GetDA\('([^']+)'\)/g, "ctx.getDAValue('$1')")
    .replace(/Device\.Log\((.*)\)/g, "ctx.Log($1)")
    .replace(/Device\.ReadRegister\('(\d+)'\)/g, "ctx.readRegister($1)")
    .replace(/Device\.WriteRegister\('(\d+)',\s*(.*)\)/g, "ctx.writeRegister($1, $2)")
    .replace(/:=/g, "=")
    .replace(/<>/g, "!==")
    .replace(/\bTRUE\b/g, "true")
    .replace(/\bFALSE\b/g, "false")
    .replace(/\bAND\b/g, "&&")
    .replace(/\bOR\b/g, "||")
    .replace(/\bNOT\b/g, "!")
    .replace(/\bIF\s+(.*)\s+THEN/g, "if ($1) {")
    .replace(/\bELSIF\s+(.*)\s+THEN/g, "} else if ($1) {")
    .replace(/\bELSE\b/g, "} else {")
    .replace(/\bEND_IF;/g, "}")
    .replace(/\bWHILE\s+(.*)\s+DO/g, "while ($1) {")
    .replace(/\bEND_WHILE;/g, "}")
    .replace(/\bSQRT\(/g, "Math.sqrt(")
    .replace(/\bABS\(/g, "Math.abs(")
    .replace(/\bTO_INT\(/g, "Math.floor(")
    .replace(/\bTRUNC\(/g, "Math.trunc(")
    .replace(/\bREAL_TO_INT\(/g, "Math.floor(")
    .replace(/\bMOD\b/g, "%")
    .replace(/\bVAR\s+([a-zA-Z0-9_]+)(\s*:\s*[a-zA-Z0-9_]+)?\s*;/g, "")
    .replace(/\bVAR\s+([a-zA-Z0-9_]+)/g, "scope.$1")
    .replace(/\bEND_VAR\b/g, "")
    .replace(/FUNCTION_BLOCK.*$/gm, "")
    .replace(/END_FUNCTION_BLOCK/gm, "");
  
  if (jsLine.trim()) {
    console.log(`Line ${i + 1}: ${jsLine}`);
  }
}

console.log('\n=== CHECKING FOR SUSPICIOUS PATTERNS ===');
const suspiciousLines = [];
for (let i = 0; i < lines.length; i++) {
  let jsLine = lines[i]
    .replace(/\(\*[\s\S]*?\*\)/g, "")
    .replace(/:=/g, "=")
    .replace(/<>/g, "!==")
    .replace(/\bTRUE\b/g, "true")
    .replace(/\bFALSE\b/g, "false")
    .replace(/\bAND\b/g, "&&")
    .replace(/\bOR\b/g, "||")
    .replace(/\bNOT\b/g, "!")
    .replace(/\bIF\s+(.*)\s+THEN/g, "if ($1) {")
    .replace(/\bELSIF\s+(.*)\s+THEN/g, "} else if ($1) {")
    .replace(/\bELSE\b/g, "} else {")
    .replace(/\bEND_IF;/g, "}")
    .replace(/\bWHILE\s+(.*)\s+DO/g, "while ($1) {")
    .replace(/\bEND_WHILE;/g, "}")
    .replace(/\bSQRT\(/g, "Math.sqrt(")
    .replace(/\bABS\(/g, "Math.abs(")
    .replace(/\bTO_INT\(/g, "Math.floor(")
    .replace(/\bTRUNC\(/g, "Math.trunc(")
    .replace(/\bREAL_TO_INT\(/g, "Math.floor(")
    .replace(/\bMOD\b/g, "%")
    .replace(/\bVAR\s+([a-zA-Z0-9_]+)(\s*:\s*[a-zA-Z0-9_]+)?\s*;/g, "")
    .replace(/\bVAR\s+([a-zA-Z0-9_]+)/g, "scope.$1")
    .replace(/\bEND_VAR\b/g, "");
  
  // Check for colon not part of ternary operator
  if (jsLine.includes(':') && !jsLine.includes('?')) {
    suspiciousLines.push({ lineNum: i + 1, content: jsLine });
  }
}

if (suspiciousLines.length > 0) {
  console.log(`Found ${suspiciousLines.length} lines with colons (not ternary):`);
  suspiciousLines.slice(0, 10).forEach(item => {
    console.log(`  Line ${item.lineNum}: ${item.content}`);
  });
} else {
  console.log('No suspicious patterns found');
}
