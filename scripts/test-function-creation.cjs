// Script to test code compilation with exact same logic as SimulationEngine

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
let wrappedCode = ''; // Declare outside try block

// Replicate the exact compile logic from SimulationEngine.compile()
try {
  // 0. Strip PLC-style block comments globally
  let cleanedSource = sourceCode.replace(/\(\*[\s\S]*?\*\)/g, "");

  // 0.a Convert VAR...END_VAR blocks
  cleanedSource = cleanedSource.replace(/VAR([\s\S]*?)END_VAR/g, (_m, inner) => {
      return inner.split('\n').map(l => {
          const mInit = l.match(/^\s*([A-Za-z_][\w]*)\s*:\s*[A-Za-z_][\w]*\s*:=\s*(.+);?\s*$/);
          if (mInit) return `scope.${mInit[1]} __ASSIGN__ ${mInit[2]};`;
          const mNoInit = l.match(/^\s*([A-Za-z_][\w]*)\s*:\s*[A-Za-z_][\w]*\s*;?\s*$/);
          if (mNoInit) return `scope.${mNoInit[1]} __ASSIGN__ scope.${mNoInit[1]};`;
          return l;
      }).join('\n');
  });

  // 1. Line-by-Line Instrumentation and Syntax Translation
  const lines = cleanedSource.split('\n');
  const instrumentedLines = lines.map((line, idx) => {
      const lineNum = idx + 1;
      
      let jsLine = line.replace(/\(\*[\s\S]*?\*\)/g, "");
      
      jsLine = jsLine
        .replace(/Device\.ReadInput\('(\d+)'\)/g, "ctx.readInput($1)")
        .replace(/Device\.WriteCoil\('(\d+)',\s*(.*)\)/g, "ctx.writeCoil($1, $2)")
        .replace(/Device\.SetDA\('([^']+)',\s*(.*)\)/g, "ctx.setDAValue('$1', $2)")
        .replace(/Device\.GetDA\('([^']+)'\)/g, "ctx.getDAValue('$1')")
        .replace(/Device\.Log\((.*)\)/g, "ctx.Log($1)")
        .replace(/Device\.ReadRegister\('(\d+)'\)/g, "ctx.readRegister($1)")
        .replace(/Device\.WriteRegister\('(\d+)',\s*(.*)\)/g, "ctx.writeRegister($1, $2)")
        // IEC 61131-3 ST Syntax to JS conversions
        // Handle assignment vs. comparison carefully:
        // In ST: ":=" is assignment, "=" is comparison (equality)
        .replace(/:=/g, "__ASSIGN__") // Temp placeholder for assignment
        .replace(/(?<![<>!=])=(?!=)/g, "===") // Comparison: = to ===, but not >=, <=, !=, ==
        .replace(/__ASSIGN__/g, "=") // Now convert assignment placeholder to =
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

      return `yield ${lineNum}; ${jsLine}`;
  });

  wrappedCode = `
    return function* (ctx, scope) {
       with(scope) {
          ${instrumentedLines.join('\n')}
       }
    }
  `;

  console.log('=== ATTEMPTING TO CREATE FUNCTION ===');
  console.log('wrappedCode length:', wrappedCode.length);
  
  // Search for suspicious patterns
  const allLines = wrappedCode.split('\n');
  const suspiciousLines = [];
  
  for (let i = 0; i < allLines.length; i++) {
    const line = allLines[i];
    // Look for colons that aren't part of ternary operators or object literals
    if (line.includes(':') && !line.includes('?') && !line.match(/^\s*\w+\s*:\s*function/)) {
      // Check if it's not a yield label (like "yield 10:")
      if (!line.match(/yield\s+\d+:/)) {
        suspiciousLines.push({ lineNum: i + 1, content: line.trim() });
      }
    }
  }
  
  if (suspiciousLines.length > 0) {
    console.log(`\n⚠️  Found ${suspiciousLines.length} lines with suspicious colons:`);
    suspiciousLines.slice(0, 20).forEach(item => {
      console.log(`  Line ${item.lineNum}: ${item.content}`);
    });
  }
  
  // Try to create the function
  console.log('\n=== ATTEMPTING new Function() ===');
  // eslint-disable-next-line no-new-func
  const generator = new Function(wrappedCode)();
  
  console.log('✅ SUCCESS! Function created successfully.');
  console.log('Generator type:', typeof generator);
  
} catch (e) {
  console.error('\n❌ ERROR during new Function()');
  console.error('Error type:', e.constructor.name);
  console.error('Error message:', e.message);
  
  // Try to find the problematic line by binary search or inspection
  console.log('\n=== SEARCHING FOR PROBLEMATIC CODE ===');
  const lines = wrappedCode.split('\n');
  console.log('Total lines in wrappedCode:', lines.length);
  
  // Save wrappedCode to a file for manual inspection
  fs.writeFileSync(path.join(__dirname, 'generated-code.js'), wrappedCode, 'utf8');
  console.log('Generated code saved to scripts/generated-code.js');
  
  // Look for patterns that could cause "Invalid left-hand side in assignment"
  const badPatterns = [
    { pattern: /\b\d+\s*=(?!=)/, desc: 'number = (not ==)'  },
    { pattern: /\btrue\s*=(?!=)/, desc: 'true = (not ==)' },
    { pattern: /\bfalse\s*=(?!=)/, desc: 'false = (not ==)' },
    { pattern: /\)\s*=(?!=)/, desc: 'call() = (not ==)' },
    { pattern: /\+\+\s*=/, desc: '++ =' },
    { pattern: /--\s*=/, desc: '-- =' },
    { pattern: /:\s*[A-Z_]+\s*=(?!=)/, desc: ': TYPE = (not ==)' },
  ];
  
  console.log('Searching for bad patterns...\n');
  let foundAny = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { pattern, desc } of badPatterns) {
      if (pattern.test(line)) {
        console.log(`  Line ${i + 1} [${desc}]: ${line.trim().substring(0, 120)}`);
        foundAny = true;
      }
    }
  }
  
  if (!foundAny) {
    console.log('No obvious bad patterns found. Trying binary search...\n');
    
    // Try to compile progressively smaller chunks
    let low = 0, high = lines.length;
    while (low < high - 1) {
      const mid = Math.floor((low + high) / 2);
      const testCode = `
        return function* (ctx, scope) {
           with(scope) {
              ${lines.slice(3, mid).join('\n')}
           }
        }
      `;
      try {
        new Function(testCode)();
        console.log(`  Lines 1-${mid}: ✅ OK`);
        low = mid;
      } catch (err) {
        console.log(`  Lines 1-${mid}: ❌ Error`);
        high = mid;
      }
    }
    
    console.log(`\nProblem is around line ${low}-${high}`);
    console.log('Lines around the problem:');
    for (let i = Math.max(0, low - 3); i < Math.min(lines.length, high + 3); i++) {
      console.log(`  ${i + 1}: ${lines[i].substring(0, 120)}`);
    }
  }
}
